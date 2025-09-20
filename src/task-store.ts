import type { WorkerTaskStatus } from "../types/index.d.ts";

import Queue, { PrismaAdapter, MySQLAdapter, Task } from "../index.js";

export default class TaskStore {
	dbAdaptor: PrismaAdapter | MySQLAdapter | null = null;
	#queue: Queue;

	constructor(queue: Queue, db?: PrismaAdapter | MySQLAdapter) {
		this.#queue = queue;
		this.dbAdaptor = db || null;
	}

	// TODO: Implement incase of unfinished tasks during a server crash or new pending tasks added straight to the DB.
	async syncWithDB() {
		if (!this.dbAdaptor) return;

		if (!this.dbAdaptor.db.tasks) {
			return console.warn("[Anqueue] No task table found, skipping task sync");
		}

		// Find any pending tasks in the db with an active executor to process it
		const pendingTasks = await this.dbAdaptor.findMany("tasks", {
			where: {
				status: "pending",
				type: {
					in: this.#queue.executorRegistry.taskTypes
				},
			},
		});

		if (pendingTasks.length === 0) return;

		// Filter out and add any tasks that are not already in the queue.
		pendingTasks
			.filter((task: any) => {
				return task && task.uid && !this.#queue.getTask(task.uid);
			})
			.map((data: any) => {
				this.#queue.add(
					new Task({
						uid: data.uid,
						type: data.type,
						name: data.name,
						data: data.data || {},
						description: data.description,
					})
				);
			});
	}

	async saveTask(status: WorkerTaskStatus) {
		const task = status.task;

		if (!task || !this.dbAdaptor) return;

		if (!this.dbAdaptor.db.tasks) {
			return console.warn("[Anqueue] No task table found, skipping task save");
		}

		if (status.result && "processed" in status.result) {
			delete (status.result as Partial<typeof status.result>).processed;
		}

		const insert = {
			uid: task.uid,
			type: task.type,
			name: task.name,
			description: task.description,
			status: task.status,
			data: task.data ? JSON.parse(JSON.stringify(task.data)) : null,
			error: task.error ? JSON.stringify(task.error) : null, // only if error is a string column
			usersId: task.userId,
			started_at: task.startedAt,
			finished_at: task.completedAt,
		};

		await this.dbAdaptor
			.upsert("tasks", {
				where: { uid: task.uid },
				update: insert,
				create: insert,
			})
			.then(() => {
				if (task.status === "completed") {
					this.#queue.remove(task.uid);
				}
			});
	}
}
