import path from "path";
import { ChildProcess, fork } from "child_process";

import Task from "./src/task.js";
import TaskStore from "./src/task-store.js";
import TaskExecutor from "./src/task-executor.js";
import TaskExecutorRegistry from "./src/task-registry.js";
import WorkerManager from "./src/worker-manager.js";

import { getFileParts } from "./src/lib/files.js";
import { safeUpsert } from "./src/lib/db.js";
import { maybeGenerateTypes, hasProperty } from "./src/lib/util.js";

import type {
	QueueOptions,
	WorkerStatus,
	TaskStatus,
	TaskResult,
	PrismaClient,
	TaskValidationRule,
} from "./types/index.d.ts";

/**
 * A robust task queue system that manages task execution, scheduling, and worker management.
 *
 * The Queue class provides a comprehensive solution for handling asynchronous tasks with
 * features like priority-based scheduling, automatic task execution, and database persistence.
 *
 * @example
 * ```typescript
 * const queue = new Queue("./tasks");
 * await queue.init();
 *
 * const task = new Task("process-data", { priority: 1 });
 * queue.add(task);
 *
 * // Process any pending tasks automatically every 30 seconds
 * await queue.runAutomatically(30);
 * ```
 */
export default class Queue {
	/** Directory containing task definitions and implementations */
	public taskDirectory: string;

	/** Manager for worker processes that execute tasks */
	public workers: WorkerManager;

	/** Internal array of tasks waiting to be executed */
	private taskStack: Task[] = [];

	/** Registry of available task executors */
	private taskExecutors: TaskExecutorRegistry;

	/** Storage layer for task persistence and database operations */
	private taskStore: TaskStore;

	/** Flag indicating if the automatic execution loop has been initialized */
	private _loopInitialized: boolean = false;

	/**
	 * Creates a new Queue instance.
	 *
	 * @param taskDirectory - Path to the directory containing task definitions. Required.
	 * @param options - Configuration options for the queue
	 * @throws {Error} When taskDirectory is undefined
	 *
	 * @example
	 * ```typescript
	 * const queue = new Queue("./src/tasks", {
	 *   db: new PrismaClient()
	 * });
	 *
	 * await queue.init();
	 * ```
	 */
	constructor(taskDirectory: string, opts: QueueOptions = {}) {
		if (typeof taskDirectory === "undefined") {
			throw new Error(
				`[ERROR] Property "taskDirectory" is required in a new Queue()`
			);
		}

		this.taskDirectory = taskDirectory;

		maybeGenerateTypes(this.taskDirectory);

		this.workers = new WorkerManager(this, taskDirectory, {
			workerPrefix: opts.workerPrefix || "anqueue-worker-",
			maxWorkers: opts.maxWorkers || 3,
		});
		this.taskStore = new TaskStore(this);
		this.taskExecutors = new TaskExecutorRegistry();

		if (opts.db) this.setDatabase(opts.db);
	}

	// Public methods
	// ================================

	/**
	 * Initializes the queue system.
	 *
	 * This method:
	 * - Generates TypeScript types for the task directory
	 * - Spawns the first worker process
	 * - Initializes the task executor registry
	 *
	 * @returns Promise that resolves to Queue for method chaining
	 *
	 * @example
	 * ```typescript
	 * await queue.init();
	 * ```
	 */
	public async init(): Promise<Queue> {
		this.workers.spawn();

		await this.taskExecutors.initialize(this.taskDirectory);

		return this;
	}

	/**
	 * Sets the database connection for the queue and all of its active workers.
	 *
	 * @param db - Prisma client instance for database operations
	 */
	public setDatabase(db: PrismaClient) {
		this.taskStore.db = db;
		console.log("[Anqueue] 🔗 Database connection set");
	}

	/**
	 * Starts automatic task execution with a specified delay interval.
	 *
	 * This method runs continuously until stopped, checking for pending tasks
	 * and executing them at regular intervals. It also syncs with the database
	 * to ensure task state consistency.
	 *
	 * @param delay - Delay between execution cycles in seconds
	 * @returns Promise that resolves when the loop is stopped
	 *
	 * @example
	 * ```typescript
	 * // Run tasks every 30 seconds
	 * await queue.runAutomatically(30);
	 *
	 * // Run tasks every 2 minutes
	 * await queue.runAutomatically(120);
	 * ```
	 */
	public async runAutomatically(timeout: number) {
		this._loopInitialized = true;

		const readableDuration = timeout >= 60 ? timeout / 60 : timeout;
		const suffix =
			timeout >= 60 ? (timeout === 60 ? "minute" : "minutes") : "seconds";

		while (this._loopInitialized) {
			await this.taskStore.syncWithDB();

			const pendingTasks = this.getPendingTasks();

			if (pendingTasks.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, timeout * 1000));
				continue;
			}

			console.log(
				`[Anqueue] 🧹 Running pending tasks (every ${readableDuration} ${suffix})`
			);

			await this.runTasks(pendingTasks);
			await new Promise((resolve) => setTimeout(resolve, timeout * 1000));
		}
	}

	/**
	 * Executes all pending tasks that are ready to run.
	 *
	 * This method:
	 * - Filters tasks that are ready for execution
	 * - Schedules multiple tasks if needed
	 * - Distributes tasks to available workers
	 *
	 * @returns Promise that resolves when all pending tasks have been sent to workers
	 *
	 * @example
	 * ```typescript
	 * await queue.runPendingTasks();
	 * ```
	 */
	public async runTasks(tasks?: Task[]) {
		if (!tasks) tasks = this.getPendingTasks();

		const taskLoad = tasks.length;

		if (taskLoad === 0) return;

		if (taskLoad > 1) await this.scheduleTasks();

		console.log(
			`[Anqueue] 🚀 Sending ${taskLoad} pending`,
			taskLoad > 1 ? "tasks" : "task",
			"to available workers"
		);

		const stats = {
			tasksSent: 0,
			noWorkerAvailable: 0,
			noExecutorFound: 0,
			validationFailed: 0,
		};

		for (const task of tasks) {
			const worker = this.workers.getAvailable();

			if (!worker) {
				stats.noWorkerAvailable += 1;
				continue;
			}

			const executor = this.taskExecutors.getExecutor(task.type);

			if (!executor) {
				stats.noExecutorFound += 1;
				console.warn(`[Anqueue] ⏩ Skipping and removing task: ${task.name} (No executor found)`);
				this.remove(task.uid);
				continue;
			}

			// Validate task before sending to worker
			const { passed, reason } = task.validate(executor.validationSchema());

			if (!passed) {
				if (task.retryCount >= task.maxRetries) {
					console.warn(`[Anqueue] ⏩ Skipping and removing task: ${task.name} (Max retries reached)`);
					this.remove(task.uid);
					continue;
				}

				stats.validationFailed += 1;
				task.status = "failed";
				task.retryCount += 1;

				const error = new Error(`Task ${task.name} validation failed: ${reason}`);

				task.addError(error);

				await executor.onFailure(task, { processed: false }, error, this.store.db);

				continue;
			}

			worker.send({ event: "task", task });

			this.remove(task.uid);

			stats.tasksSent += 1;
		}

		return stats;
	}

	/**
	 * Sorts and schedules tasks based on priority and creation time.
	 *
	 * Tasks are sorted by priority (higher priority first) and then by
	 * creation time (earlier tasks first).
	 *
	 * @returns Promise that resolves when scheduling is complete
	 *
	 * @example
	 * ```typescript
	 * await queue.scheduleTasks();
	 * ```
	 */
	public async scheduleTasks(): Promise<void> {
		console.log("[Anqueue] 📅 Scheduling tasks...");

		// Sort tasks by priority and creation time
		this.taskStack.sort((a, b) => {
			// Higher priority first
			if (a.priority !== b.priority) {
				return b.priority - a.priority;
			}
			// Earlier tasks first (assuming tasks are added in order)
			return 0;
		});

		console.log(`[Anqueue] 📋 Scheduled ${this.taskStack.length} tasks`);
	}

	/**
	 * Gets the task store instance for database operations.
	 *
	 * @returns TaskStore instance
	 */
	public get store(): TaskStore {
		return this.taskStore;
	}

	/**
	 * Gets the task executor registry instance.
	 *
	 * @returns TaskExecutorRegistry instance
	 */
	public get executorRegistry(): TaskExecutorRegistry {
		return this.taskExecutors;
	}

	/**
	 * Adds a task to the queue.
	 *
	 * @param task - Task instance to add to the queue
	 * @returns The queue instance for method chaining
	 *
	 * @example
	 * ```typescript
	 * const task = new Task("process-data", { priority: 1 });
	 * queue.add(task);
	 * ```
	 */
	public add(task: Task): this {
		this.taskStack.push(task);
		console.log(`[Anqueue] ➕ Added task to stack: ${task.name} (ID: ${task.uid})`);

		return this;
	}

	/**
	 * Removes a task from the queue by its ID.
	 *
	 * @param taskId - Unique identifier of the task to remove
	 * @returns True if the task was found and removed, false otherwise
	 *
	 * @example
	 * ```typescript
	 * const removed = queue.remove("task-123");
	 * if (removed) {
	 *   console.log("Task removed successfully");
	 * }
	 * ```
	 */
	public remove(taskId: string): boolean {
		const index = this.taskStack.findIndex((task) => task.uid === taskId);

		if (index !== -1) {
			const task = this.taskStack.splice(index, 1)[0];
			console.log(`[Anqueue] 🗑️ Removed task from stack: ${task.name} (ID: ${taskId})`);

			return true;
		}

		return false;
	}

	/**
	 * Cancels a pending task and removes it from the queue.
	 *
	 * This method only affects tasks that haven't started executing yet.
	 * Running or completed tasks cannot be cancelled.
	 *
	 * @param taskId - Unique identifier of the task to cancel
	 * @returns True if the task was found, cancelled, and removed, false otherwise
	 *
	 * @example
	 * ```typescript
	 * const cancelled = queue.cancel("task-123");
	 * if (cancelled) {
	 *   console.log("Task cancelled successfully");
	 * }
	 * ```
	 */
	public cancel(taskId: string): boolean {
		// Cancel pending task only
		const pendingTask = this.getTask(taskId);
		if (pendingTask) {
			pendingTask.cancel();
			this.remove(taskId);
			return true;
		}

		return false;
	}

	/**
	 * Retrieves a task from the queue by its ID.
	 *
	 * @param taskId - Unique identifier of the task to retrieve
	 * @returns Task instance if found, undefined otherwise
	 *
	 * @example
	 * ```typescript
	 * const task = queue.getTask("task-123");
	 * if (task) {
	 *   console.log(`Found task: ${task.name}`);
	 * }
	 * ```
	 */
	public getTask(taskId: string): Task | undefined {
		return this.taskStack.find((task) => task.uid === taskId);
	}

	/**
	 * Gets all tasks that are ready to run.
	 *
	 * @returns Array of task status objects for pending tasks
	 *
	 * @example
	 * ```typescript
	 * const pending = queue.pendingTasks;
	 * console.log(`${pending.length} tasks are ready to run`);
	 * ```
	 */
	public getPendingTasks() {
		return this.taskStack.filter(
			(task) => typeof task.readyToRun === "function" && task.readyToRun()
		);
	}

	/**
	 * Gets the status of all tasks in the queue.
	 *
	 * @returns Array of task status objects
	 *
	 * @example
	 * ```typescript
	 * const statuses = queue.getTaskStatuses();
	 * statuses.forEach(status => {
	 *   console.log(`Task ${status.id}: ${status.status}`);
	 * });
	 * ```
	 */
	public getTaskStatuses(): TaskStatus[] {
		return this.taskStack.map((task) => task.getStatus());
	}

	/**
	 * Removes all tasks from the queue.
	 *
	 * This method clears the entire task stack, effectively resetting
	 * the queue to an empty state.
	 */
	public clear(): void {
		this.taskStack = [];
		console.log("🧹 Queue cleared");
	}
}

export { Task, TaskStore, TaskExecutor, getFileParts, safeUpsert, hasProperty };

export type { WorkerStatus, TaskResult, TaskStatus, TaskValidationRule };
