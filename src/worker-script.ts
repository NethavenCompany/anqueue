import type { TaskData, TaskOptions, TaskResult, PrismaClient, WorkerEvent, ProcessEvent } from "../types/index.d.ts";

import { Task } from "../index.js";
import TaskExecutorRegistry from "./task-registry.js";


// Surface fatal errors that would otherwise silently terminate the worker
process.on("uncaughtException", (err) => {
	console.error(`[Worker: ${process.env.WORKER_ID}] Uncaught exception:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	console.error(`[Worker: ${process.env.WORKER_ID}] Unhandled rejection:`, reason instanceof Error ? reason.message : String(reason));
    process.exit(1);
});

const MAX_TASK_LOAD = Number(process.env.MAX_CONCURRENT_TASKS);
let taskLoad = 0;

// Custom send method with additional functionality
function sendDataToProcess(data: { event: ProcessEvent } & Record<string, unknown>) {
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
	process.on("message", async (data: any) => {
		// Simple type check for internal communication
		if (data?.event === eventType) {
			await callbackfn(data);
		}
	});
}

// Utility functions for worker information
function getWorkerInfo() {
	return {
		workerId: process.env.WORKER_ID,
		processId: process.pid,
		taskLoad,
		maxLoad: MAX_TASK_LOAD,
		uptime: process.uptime(),
	};
}

function setTaskLoad(load: number) {
	taskLoad = Math.max(0, Math.min(load, MAX_TASK_LOAD));
	return taskLoad;
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
	return `[Worker: ${process.env.WORKER_ID}] ${message}`;
}

// Listen for custom worker info requests
addWorkerListener("getWorkerInfo", (data) => {
	sendDataToProcess({
		event: "workerInfo",
		data: getWorkerInfo()
	});
});

// Listen for task load modification requests
addWorkerListener("setTaskLoad", (data) => {
	const newLoad = setTaskLoad(data.load);
	sendDataToProcess({
		event: "taskLoadUpdated",
		data: { taskLoad: newLoad }
	});
});

// Listen for database connection setup and pass DB from parent process to worker.
let db: PrismaClient | null = null;
addWorkerListener("setDatabase", (data) => {
	db = data.db;
});

// Listen for any incoming tasks
addWorkerListener("task", async (message) => {
	const taskData = message.task;
	let result: TaskResult<TaskData> = { processed: false };

	try {
		// If
		if (taskLoad >= MAX_TASK_LOAD) {
			throw new Error(m("Currently under full load"));
		}

		taskLoad++;

		console.log(m(`Received a new task`));
		// Reconstruct a Task instance from plain object
		const task = new Task<TaskData>(taskData as TaskOptions<TaskData>);

		// Immediately process it using the registered executor
		const executor = taskExecutors.getExecutor(task.type);

		if (executor) {
			try {
				// Execute the task itself.
				result = await task.execute(executor.exec, executor.retrySchema);
				// Do any post processing or clean up
				await executor.onComplete(task, result, db);
			} catch (error) {
				console.error(`Task ${task.uid} failed: ${error instanceof Error ? error.message : String(error)}`);
				task.status = "failed";
				task.error = error instanceof Error ? error : new Error(String(error));

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
	} catch (err) {
		sendTaskInfo(null, err, result);
	}

	taskLoad--;
});

// Initialize the task executor registry for the worker
const taskExecutors = new TaskExecutorRegistry()
await taskExecutors.initialize(process.env.TASK_DIRECTORY!);