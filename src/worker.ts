import { ChildProcess } from "child_process";

import { Task } from "../index.js";
import WorkerManager from "./worker-manager.js";

import type {
	ProcessEvent,
	WorkerEvent,
	WorkerInfo,
	WorkerTaskStatus,
} from "../types/index.d.ts";

type DataToWorker = { event: WorkerEvent } & Record<string, unknown>;
type DataFromWorker = { event: ProcessEvent } & WorkerTaskStatus;

export default class Worker {
	public id: string;
	public maxConcurrentTasks: number = 10;
	public cachedInfo: WorkerInfo | null = null;
	public cacheInterval: number;

	#manager: WorkerManager;
	#process: ChildProcess;

	constructor(manager: WorkerManager, process: ChildProcess, id: string, cacheRate: number = 200) {
		this.id = id;
		this.cacheInterval = cacheRate;

		this.#manager = manager;
		this.#process = process;

		this.#initialize();
	}

	public send(data: DataToWorker) {
		if (!data.event) return;
		this.#process.send(data);
	}

	public async getInfo(): Promise<WorkerInfo | null> {
		return new Promise((resolve) => {
			const worker = this.#process;

			if (!worker) {
				resolve(null);
				return;
			}

			const timeout = setTimeout(() => {
				resolve(null);
			}, 5000);

			worker.once(
				"message",
				(response: DataFromWorker & { data: WorkerInfo }) => {
					clearTimeout(timeout);

					if (response.event === "workerInfo") {
						this.cachedInfo = response.data;
						return resolve(response.data);
					}

					return resolve(null);
				}
			);

			this.send({ event: "getWorkerInfo" });
		});
	}

	/**
	 * Closes and removes a worker process.
	 *
	 * @param workerId - The unique identifier of the worker to close
	 * @param force - Whether to force kill the process if graceful shutdown fails
	 * @returns True if the worker was successfully closed and removed, false otherwise
	 */
	public close(force = false) {
		const worker = this.#process;

		worker.removeAllListeners();
		worker.disconnect();

		if (force) worker.kill();
	}

	#registerListener(
		event: "error" | "message" | "close" | "disconnect" | "exit" | "spawn",
		listener: (...data: any) => void
	) {
		if (!this.#process) return;
		this.#process.on(event, listener);
	}

	#initialize() {
		// Track restart attempts for exponential backoff
		let restartAttempts = 0;
		const maxRestartAttempts = 5;

		// In case worker crashes or loses connection, restart it with exponential backoff
		this.#registerListener("exit", (code, signal) => {
			// Do not restart on clean exits or intentional terminations
			if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
				this.#manager.remove(this.id);
				return;
			}

			console.error(
				`[${this.id}] Exited with code ${code} and signal ${signal}. Restarting...`
			);

			if (restartAttempts < maxRestartAttempts) {
				const delay = Math.min(1000 * Math.pow(2, restartAttempts), 30000); // Max 30 seconds
				restartAttempts++;

				setTimeout(() => {
					console.log(
						`[${this.id}] Restarting (attempt ${restartAttempts})`
					);
					// Remove the old worker entry first, then spawn a new one
					this.#manager.remove(this.id);
					this.#manager.spawn(this.id);
				}, delay);
			} else {
				this.close(true);
				this.#manager.remove(this.id);
				console.error(
					`[${this.id}] Closed after exceeding max restart attempts. Manual intervention required.`
				);
			}
		});

		// Incase of on error just log it.
		this.#registerListener("error", (err) => {
			console.error(`[${this.id}] Error:`, err.message);
		});

		// Catch any task updates using a message listener.
		this.#registerListener("message", async (data: DataFromWorker) => {
			const task = data.task as Task;
			const result = data.result as any;

			if (!task || !result) return;

			const queue = this.#manager.getQueue();
			const taskStore = queue.store;
			const taskExecutors = queue.executorRegistry;

			try {
				if (!taskStore.dbAdaptor) {
					if (task.status === "completed") {
						queue.remove(task.uid);
					}
					return;
				}

				await taskStore.saveTask(data);
				
				const executor = taskExecutors.getExecutor(task.type);
				
				if (!executor || !executor.saveResult) return;

				await executor.saveResult(task, result, taskStore.dbAdaptor);
			} catch (err) {
				console.error(
					`[${this.id}] Task update handling error:`,
					err instanceof Error ? err.message : String(err)
				);
			}
		});

		// And finally add a loop to fetch and cache worker info periodically
		setInterval(async () => {
			await this.getInfo();
		}, this.cacheInterval)
	}
}
