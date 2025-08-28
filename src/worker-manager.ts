import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { fork } from "child_process";

import Queue from "index.js";
import Worker from "./worker.js";

import type {
	WorkerOptions,
	WorkerEvent,
} from "../types/index.d.ts";

interface WorkerManagerOptions {
	workerPrefix: string;
	maxWorkers: number;
}

/**
 * Manages worker processes for task execution in the queue system.
 *
 * The WorkerManager is responsible for spawning, monitoring, and managing
 * worker processes that handle task execution. It provides methods to
 * spawn new workers, monitor their health, and restart them if they crash.
 *
 * @example
 * ```typescript
 * const workerManager = new WorkerManager(queue, "/path/to/tasks");
 * workerManager.spawn("worker-1", { maxConcurrentTasks: 5 });
 * ```
 */
export default class WorkerManager {
	/** The directory containing task definitions and executables */
	public taskDirectory: string;

	/** The prefix used for a workers id, defaults to: 'anqueue-worker-' */
	public workerPrefix: string;

	/** The maximum amount of current worker processes allowed, defaults to 3 */
	public readonly maxWorkers: number;

	/** The queue instance that this worker manager is associated with */
	private _queue: Queue;

	/** Map of worker IDs to their corresponding child processes */
	private _workers: Map<string, Worker> = new Map();

	/**
	 * Creates a new WorkerManager instance.
	 *
	 * @param queue - The queue instance to associate with this worker manager
	 * @param taskDirectory - The directory containing task definitions
	 */
	constructor(queue: Queue, taskDirectory: string, opts: WorkerManagerOptions) {
		this.taskDirectory = taskDirectory;
		this._queue = queue;
		this.maxWorkers = opts.maxWorkers;
		this.workerPrefix = opts.workerPrefix;
	}

	/**
	 * Retrieves a specific Worker by ID.
	 *
	 * @param id - The unique identifier of the worker
	 * @returns The Worker if found, undefined otherwise
	 */
	public get(id: string) {
		return this._workers.get(id);
	}

	public set(id: string, worker: Worker) {
		return this._workers.set(id, worker);
	}

	public remove(id: string) {
		const worker = this._workers.get(id);
		
		if (worker) worker.close();

		return this._workers.delete(id);
	}

	public map(f: (worker: Worker, workerId: string) => void) {
		return Array.from(this._workers.values()).map((worker, key) => f(worker, key as unknown as string));
	}

	public forEach(f: (worker: Worker, workerId: string) => void) {
		this._workers.forEach((worker, key) => f(worker, key));
	}

	public get size() {
		return this._workers.size;
	}

	public getQueue(): Queue {
		return this._queue;
	}

	/**
	 * Gets the first available worker process.
	 * Spawns in a new process if no worker is available
	 *
	 * @returns The first available worker process
	 */
	public getAvailable(): Worker | undefined {
		const workers = this._workers;
		const workersArray = Array.from(workers.values());

		// Create a new worker if there isn't one available yet.
		if (workers.size === 0) return this.spawn();

		const availableWorkers = workersArray.filter((worker) => {
			return worker.currentTaskLoad < worker.maxConcurrentTasks;
		});

		return availableWorkers.length > 0 ? availableWorkers[0] : this.spawn();
	}

	/**
	 * Broadcasts a message to all workers
	 */
	public broadcast(message: { event: WorkerEvent } & Record<string, unknown>) {
		this.forEach((worker) => {
			worker.send(message);
		});
	}

	/**
	 * Closes and removes a worker process.
	 *
	 * @param workerId - The unique identifier of the worker to close
	 * @param force - Whether to force kill the process if graceful shutdown fails
	 * @returns True if the worker was successfully closed and removed, false otherwise
	 */
	public close(workerId: string, force = false) {
		const worker = this.get(workerId);
		if (worker) worker.close(force);
	}

	/**
	 * Spawns a new worker process.
	 *
	 * Creates a new Worker that will handle task execution. The worker
	 * is configured with environment variables for identification and task
	 * management. If the worker crashes, it will be automatically restarted
	 * with exponential backoff.
	 *
	 * @param workerId - Unique identifier for the worker
	 * @param opts - Configuration options for the worker
	 * @returns The spawned Worker
	 */
	public spawn(
		workerId: string = this._generateId(),
		opts: WorkerOptions = {}
	) {
		if (this._workers.size >= this.maxWorkers) {
			throw new Error(`Maximum number of workers reached: ${this.maxWorkers}`);
		}

		// Resolve compiled worker path (dist or transpiled in-memory when using loaders)
		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const modulePath = path.join(__dirname, "worker-script.js");

		const forkOpts: any = {
			env: {
				...process.env,
				WORKER_ID: workerId,
				TASK_DIRECTORY: this.taskDirectory,
				MAX_CONCURRENT_TASKS: String(opts.maxConcurrentTasks || 3),
			},
		};

		if (!fs.existsSync(modulePath)) {
			throw new Error(
				`Worker file not found at ${modulePath}. Build the package before running.`
			);
		}

		const worker = new Worker(this, fork(modulePath, [], forkOpts), workerId);
		this._workers.set(workerId, worker);

		return worker;
	}

	private _generateId(): string {
		return this.workerPrefix + (this._workers.size + 1);
	}
}
