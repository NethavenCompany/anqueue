import type { TaskData, WorkerStatus, PrismaClient } from "../types/index.d.ts";

import Queue, { Task } from "../index.js";

import { safeUpsert } from "./lib/db.js";

export default class TaskStore {
	db: PrismaClient | null = null;
	private _queue: Queue;

	constructor(queue: Queue, db?: PrismaClient) {
		this._queue = queue;
		this.db = db || null;
	}

	// TODO: Implement incase of unfinished tasks during a server crash or new pending tasks added straight to the DB.
	async syncWithDB() {}

	async saveTask(status: WorkerStatus) {
		const task = status.task;

		if (!task || !this.db) return;

		if (status.result && "processed" in status.result) {
			delete (status.result as Partial<typeof status.result>)
				.processed;
		}

		const insert = {
			uid: task.uid,
			type: task.type,
			status: task.status,
			data: task.data ? JSON.parse(JSON.stringify(task.data)) : null,
			error: task.error ? JSON.stringify(task.error) : null, // only if error is a string column
			usersId: task.userId,
			started_at: task.startedAt,
			finished_at: task.completedAt,
		};

		await safeUpsert(this.db.tasks, { uid: task.uid }, insert, async (task: Task<TaskData>) => {
			if (!task) return;

			if (task.status === "completed") {
				this._queue.remove(task.uid);
			}
		});
	}
}
