import { ChildProcess } from "child_process";

import { Task } from "../index.js";
import WorkerManager from "./worker-manager.js";

import type { ProcessEvent, WorkerEvent, WorkerStatus } from "../types/index.d.ts";

type DataToWorker = { event: WorkerEvent } & Record<string, unknown>;
type DataFromWorker = { event: ProcessEvent } & WorkerStatus;

export default class Worker {
	public id: string;
	public currentTaskLoad: number = 0;
	public maxConcurrentTasks: number = 10;

	protected _manager: WorkerManager;
	protected _process: ChildProcess;

	constructor(manager: WorkerManager, process: ChildProcess, id: string) {
		this._manager = manager;
		this._process = process;
		this.id = id;

		this._registerListeners();
	}

	public send(data: { event: WorkerEvent } & Record<string, unknown>) {
		if (!data.event) return;
		this._process.send(data);
	}

	public async getInfo() {
		return new Promise((resolve) => {
			const worker = this._process;

			if (!worker) {
				resolve(null);
				return;
			}

			const timeout = setTimeout(() => {
				resolve(null);
			}, 5000);

			worker.once(
				"message",
				(response: { event: ProcessEvent } & Record<string, unknown>) => {
					clearTimeout(timeout);
					if (response.event === "workerInfo") {
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
		const worker = this._process;

		worker.removeAllListeners();
		worker.disconnect();

		if (force) worker.kill();

		return this._manager.remove(this.id);
	}

	public setTaskLoad(load: number) {
		this.send({ event: "setTaskLoad", load });
	}

	private registerListener(
		event: "error" | "message" | "close" | "disconnect" | "exit" | "spawn",
		listener: (...data: any) => void
	) {
		if (!this._process) return;
		this._process.on(event, listener);
	}

	private _registerListeners() {
		// Track restart attempts for exponential backoff
		let restartAttempts = 0;
		const maxRestartAttempts = 5;

		// In case worker crashes or loses connection, restart it with exponential backoff
		this.registerListener("exit", (code, signal) => {
			// Do not restart on clean exits or intentional terminations
			if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
				this._manager.remove(this.id);
				return;
			}

			console.error(
				`[Worker: ${this.id}] Exited with code ${code} and signal ${signal}. Restarting...`
			);

			if (restartAttempts < maxRestartAttempts) {
				const delay = Math.min(1000 * Math.pow(2, restartAttempts), 30000); // Max 30 seconds
				restartAttempts++;
	
				setTimeout(() => {
					console.log(`[Worker: ${this.id}] Restarting (attempt ${restartAttempts})`);
                    // Remove the old worker entry first, then spawn a new one
                    this._manager.remove(this.id);
					this._manager.spawn(this.id);
				}, delay);
			} else {
				this.close(true);
				console.error(`[Worker: ${this.id}] exceeded max restart attempts. Manual intervention required.`);
			}
		});

		// Incase of on error just log it.
		this.registerListener("error", (err) => {
			console.error(`[Worker: ${this.id}] Error:`, err.message);
		});

		this.registerListener("message", async (data: DataFromWorker) => {
			const task = data.task as Task;
			const result = data.result as any;

			if (!task || !result) return;

			const queue = this._manager.getQueue();
			const taskStore = queue.store;
			const taskExecutors = queue.executorRegistry;

			try {
				// if(!this._manager.queue.store.db) {
				if (!taskStore.db) {
					if (task.status === "completed") {
						queue.remove(task.uid);
					}
					return;
				}

				await taskStore.saveTask(data);

				const executor = taskExecutors.getExecutor(task.type);

				if (!executor || !executor.saveResult) return;

				await executor.saveResult(task, result, taskStore.db);
			} catch (err) {
				console.error(
					`[Worker: ${this.id}] Message handling error:`,
					err instanceof Error ? err.message : String(err)
				);
			}
		});
	}
}