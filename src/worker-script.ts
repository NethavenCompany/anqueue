import type {
	TaskData,
	TaskOptions,
	TaskResult,
	WorkerEvent,
	ProcessEvent,
	WorkerInfo,
} from "../types/index.d.ts";

import { hasProperty, MySQLAdapter, PrismaAdapter, Task } from "../index.js";
import TaskExecutorRegistry from "./task-registry.js";

// Surface fatal errors that would otherwise silently terminate the worker
process.on("uncaughtException", (err) => {
	console.error(
		`[${process.env.WORKER_ID}] Uncaught exception:`,
		err instanceof Error ? err.message : String(err)
	);
	process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	console.error(
		`[${process.env.WORKER_ID}] Unhandled rejection:`,
		reason instanceof Error ? reason.message : String(reason)
	);
	process.exit(1);
});

const MAX_TASK_LOAD = Number(process.env.MAX_CONCURRENT_TASKS);
let taskLoad = 0;

// Custom send method with additional functionality
function sendDataToProcess(
	data: { event: ProcessEvent } & Record<string, any>
) {
	// Add metadata to every message
	const enhancedData = {
		...data,
		workerId: process.env.WORKER_ID,
		processId: process.pid,
	};

	process.send?.(enhancedData);
}

// Listen for incoming data from the parent process
function addWorkerListener(
	eventType: WorkerEvent,
	callbackfn: (message: any) => void | Promise<void>
) {
	process.on(
		"message",
		async (data: { event: WorkerEvent } & Record<string, unknown>) => {
			// Simple type check for internal communication
			if (hasProperty(data, "event") && data.event === eventType) {
				await callbackfn(data);
			}
		}
	);
}

// Utility functions for worker information
function getWorkerInfo(): WorkerInfo {
	return {
		workerId: process.env.WORKER_ID,
		processId: process.pid,
		taskLoad,
		maxLoad: MAX_TASK_LOAD,
		uptime: process.uptime(),
	};
}

// Send task related data properly formatted back to the parent process.
function sendTaskInfo(task: Task | null, error: unknown, result: unknown) {
	sendDataToProcess({
		event: "taskInfo",
		task: task,
		error: error instanceof Error ? error.message : String(error),
		result,
	});
}

function m(message: string) {
	return `[${process.env.WORKER_ID}] ${message}`;
}

// Listen for custom worker info requests
addWorkerListener("getWorkerInfo", () => {
	sendDataToProcess({
		event: "workerInfo",
		data: getWorkerInfo(),
	});
});

// Listen for database connection setup and pass DB from parent process to worker.
let db: PrismaAdapter | MySQLAdapter | null = null;
addWorkerListener("setDatabase", (data) => {
	if (!hasProperty(data, "db", { type: "object" })) return;
	db = data.db;
});

// Validation before attempting task execution
async function withWorkerCapacity<T>(fn: () => Promise<T>): Promise<T> {
	if (taskLoad >= MAX_TASK_LOAD) {
		throw new Error(m("Currently under full load"));
	}

	taskLoad++;

	try {
		return await fn();
	} finally {
		taskLoad--;
	}
}

async function processTasks(taskData: TaskOptions<TaskData>[]) {
	if (!taskData) return;

	taskData.forEach(async (data) => {
		let result: TaskResult<TaskData> = { processed: false };

		try {
			await withWorkerCapacity(async () => {
				// Reconstruct a Task instance from plain object
				const task = Task.fromPlainObject(data);
				// Immediately process it using the registered executor
				const executor = taskExecutors.getExecutor(task.type);

				if (executor) {
					try {
						// Execute the task itself.
						result = await task.execute(executor.exec, executor.retrySchema);
						// Do any post processing or clean up
						await executor.onComplete(task, result, db);
					} catch (error) {
						task.status = "failed";
						task.error =
							error instanceof Error ? error : new Error(String(error));

						console.error(
							`(${task.name}): Description: ${task.description} | Status: ${
								task.status
							} | Error: ${error instanceof Error ? error.message : String(error)}`
						);

						await executor.onFailure(task, result, error, db);

						// Send empty result and error back to parent
						sendTaskInfo(task, error, result);
					}
					// Send result back to parent process for storage and final processing.
					sendTaskInfo(task, null, result);
				} else {
					sendTaskInfo(
						task,
						new Error(`No executor for type: ${task.type}`),
						result
					);
				}
			});
		} catch (err) {
			sendTaskInfo(null, err, result);
		} finally {
			taskLoad--;
		}
	});
}

// Listen for any incoming tasks
addWorkerListener("taskSingle", async (message) => {
	processTasks([message.task]);
});

addWorkerListener("taskBatch", async (message) => {
	processTasks(message.batch);
});

// Initialize the task executor registry for the worker
const taskExecutors = new TaskExecutorRegistry();
await taskExecutors.initialize(process.env.TASK_DIRECTORY!);
