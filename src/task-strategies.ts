import Queue, { Task } from "index.js";

export async function single(queue: Queue, tasks: Task[]) {
	const stats = {
		tasksSent: 0,
		noWorkerAvailable: 0,
		noExecutorFound: 0,
		validationFailed: 0,
	};

	for (const task of tasks) {
		const worker = queue.workers.getAvailable();

		if (!worker) {
			stats.noWorkerAvailable += 1;
			continue;
		}

		const executor = queue.executorRegistry.getExecutor(task.type);

		if (!executor) {
			stats.noExecutorFound += 1;
			console.warn(
				`[Anqueue] ⏩ Skipping and removing task: ${task.name} (No executor found)`
			);
			queue.remove(task.uid);
			continue;
		}

		// Validate task before sending to worker
		const { passed, reason } = task.validate(executor.validationSchema());

		if (!passed) {
			if (task.retryCount >= task.maxRetries) {
				console.warn(
					`[Anqueue] ⏩ Skipping and removing task: ${task.name} (Max retries reached)`
				);

				task.status = "failed";
				task.failedAt = new Date();

				queue.remove(task.uid);

				queue.store.saveTask({
					task: task,
					error: "Max retries reached",
					result: null,
				});

				continue;
			}

			stats.validationFailed += 1;
			task.status = "failed";
			task.retryCount += 1;

			const error = new Error(`Task ${task.name} validation failed: ${reason}`);

			task.addError(error);

			await executor.onFailure(
				task,
				{ processed: false },
				error,
				queue.store.dbAdaptor
			);

			continue;
		}

		worker.send({ event: "taskSingle", task });

		queue.remove(task.uid, true);

		stats.tasksSent += 1;
	}

	return stats;
}

export async function batch(queue: Queue, tasks: Task[]) {
	const stats = {
		tasksSent: 0,
		noWorkerAvailable: 0,
		noExecutorFound: 0,
		validationFailed: 0,
	};

	const availableWorkers = queue.workers.getAvailableWorkers();

	for (const worker of availableWorkers) {
		const capacity = worker.maxConcurrentTasks - worker.cachedInfo!.taskLoad;

		if (capacity <= 0 || tasks.length === 0) {
			stats.noWorkerAvailable++;
			continue;
		}

		const batch = tasks.splice(0, capacity);

		if (batch.length === 0) {
			continue;
		}

		for (const task of batch) {
			const executor = queue.executorRegistry.getExecutor(task.type);

			if (!executor) {
				stats.noExecutorFound += 1;
				console.warn(
					`[Anqueue] ⏩ Skipping and removing task: ${task.name} (No executor found)`
				);
				queue.remove(task.uid);
				continue;
			}

			const { passed, reason } = task.validate(executor.validationSchema());

			if (!passed) {
				if (task.retryCount >= task.maxRetries) {
					console.warn(
						`[Anqueue] ⏩ Skipping and removing task: ${task.name} (Max retries reached)`
					);
	
					task.status = "failed";
					task.failedAt = new Date();
	
					queue.remove(task.uid);
	
					queue.store.saveTask({
						task: task,
						error: "Max retries reached",
						result: null,
					});
	
					continue;
				}
	
				stats.validationFailed += 1;
				task.status = "failed";
				task.retryCount += 1;
	
				const error = new Error(`Task ${task.name} validation failed: ${reason}`);
	
				task.addError(error);
	
				await executor.onFailure(
					task,
					{ processed: false },
					error,
					queue.store.dbAdaptor
				);
	
				continue;
			}
		}

		worker.send({ event: "taskBatch", batch });

		for (const task of batch) {
			queue.remove(task.uid, true);
		}

		stats.tasksSent += batch.length;
	}

	return stats;
}
