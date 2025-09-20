import type { TaskData, TaskResult, TaskValidationRule, AdapterImplementation } from "../types/index.d.ts";

import { Task } from "../index.js";

export default class TaskExecutor<T extends TaskData = TaskData, R = any> {
	taskType: string;

	constructor(taskType: string) {
		this.taskType = taskType;
	}

	validationSchema(): TaskValidationRule<T>[] {
		return [];
	}

	__rawValidationSchema(): TaskValidationRule<T>[] {
		return this.validationSchema()
	}

	retrySchema(): string[] {
		return [];
	}

	async exec(_task: Task<T>): Promise<TaskResult<R>> {
		return { processed: true } as TaskResult<R>;
	}

	async onFailure(
		_task: Task<T>,
		_result: TaskResult<R> | null,
		_error: unknown,
		_db: AdapterImplementation | null
	) {}

	async onComplete(
		_task: Task<T>,
		_result: TaskResult<R>,
		_db: AdapterImplementation | null
	) {}

	async saveResult(
		_task: Task<T>,
		_result: TaskResult<R>,
		_db: AdapterImplementation
	) {}
}
