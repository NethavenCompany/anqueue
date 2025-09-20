import type { TaskOptions, TaskStatus, TaskResult, TaskData, TaskValidationRule } from "../types/index.d.ts";

export default class QueueTask<TData = TaskData> {
	// Core properties
	uid: string;
	name: string;
	type: string;
	description?: string;

	// Status & state
	status: "pending" | "running" | "completed" | "failed" | "cancelled" =
		"pending";
	progress: number = 0;
	startedAt?: Date;
	failedAt?: Date;
	completedAt?: Date;

	// Execution control
	promise: Promise<unknown>;
	#resolve!: (value: unknown) => void;
	#reject!: (error: unknown) => void;

	// Configuration
	priority: number;
	retryCount: number = 0;
	maxRetries: number;
	delay: number;
	timeout: number;
	runAt?: Date;

	// Data & context
	data: TData;
	userId?: number;
	metadata: Record<string, unknown>;

	// Error handling
	error?: Error;
	errorHistory: Error[] = [];

	constructor(options: TaskOptions<TData>) {
		this.uid = options.uid || this.#generateId();
		this.name = options.name;
		this.type = options.type;
		this.description = options.description;
		this.priority = options.priority || 0;
		this.maxRetries = options.maxRetries || Number(process.env.MAX_TASK_RETRIES) || 3;
		this.delay = options.delay || 0;
		this.timeout = options.timeout || Number(process.env.TASK_TIMEOUT_MS) || 30000; // 30 seconds default
		this.data = options.data as TData;
		this.userId = options.userId;
		this.metadata = options.metadata || {};
		this.runAt = options.runAt ? new Date(options.runAt) : undefined;
		
		this.promise = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
	}

	// Public methods
	// ================================

	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	validate(validationSchema: TaskValidationRule[]) {
		const result = { passed: true, reason: "Validation passed" };

		validationSchema.forEach(validator => {
			// Skip validation rule if it is not a function.
			if(typeof validator !== "function") return;

			const validatorCode = typeof validator === "function"
				? (validator.toString().replace(/^[\t ]+/gm, "").replace(/\n{2,}/g, "\n"))
				: String(validator);

			if(!validator(this)) {
				result.reason = `ValidationRule "${validatorCode}" did not resolve to true`
				result.passed = false;
			}
		});

		return result;
	}

	async execute<TResult>(executor: (task: QueueTask<TData>) => Promise<TaskResult<TResult>>, retrySchema: () => string[]): Promise<TaskResult<TResult>> {
		if (this.status !== "pending") {
			throw new Error(`Task ${this.uid} is not in pending status`);
		}

		this.status = "running";
		this.startedAt = new Date();
		this.progress = 0;

		try {
			if (this.delay > 0) {
				await this.sleep(this.delay);
			}

			// Execute the task with timeout
			const result = await Promise.race([executor(this), this.#createTimeout()]);

			if(!result.processed) {
				this.#setFailed();
				return result;
			}

			this.#setCompleted();
			this.#resolve(result);

			const workerId = process.env.WORKER_ID;

			console.log(`[${workerId ? workerId : "Anqueue"}] (${this.name}): Description: ${this.description} | Status: ${this.status}`);

			return result;
		} catch (error) {
			// Recursively retry if retry schema condition is met
			if (this.#shouldRetry(error as Error, retrySchema()) && this.#retry()) {
				console.warn(`Retrying task ${this.uid} (attempt ${this.retryCount}) due to error:`, error);
				return this.execute(executor, retrySchema);
			}

			this.#handleError(error as Error);
			throw error;
		}
	}

	cancel(): void {
		if (this.status === "pending" || this.status === "running") {
			this.status = "cancelled";
			this.completedAt = new Date();
			this.#reject(new Error("Task cancelled"));
		}
	}

	updateProgress(progress: number): void {
		this.progress = Math.max(0, Math.min(100, progress));

		console.log(
			`(ID: ${this.uid}) ${this.description} }`,
			"Progress:",
			`${this.progress}%`
		);
	}

	getStatus(): TaskStatus {
		return {
			uid: this.uid,
			name: this.name,
			type: this.type,
			status: this.status,
			progress: this.progress,
			startedAt: this.startedAt,
			completedAt: this.completedAt,
			error: this.error,
			retryCount: this.retryCount,
			maxRetries: this.maxRetries,
			userId: this.userId,
			metadata: this.metadata,
		};
	}

	readyToRun(): boolean {
		return !this.runAt || this.runAt <= new Date();
	}

	addError(error: Error) {
		this.error = error;
		this.errorHistory.push(error);

		console.error(`[Anqueue] ${error.message}`);
	}

	// Private methods
	// ================================

	#retry(): boolean {
		if (this.retryCount >= this.maxRetries) {
			return false;
		}

		this.retryCount++;
		this.status = "pending";
		this.progress = 0;
		this.startedAt = undefined;
		this.completedAt = undefined;
		this.error = undefined;

		return true;
	}

	
	#setFailed() {
		this.status = "failed";
		this.failedAt = new Date();
		this.progress = 0;
	}
	
	#setCompleted() {
		this.status = "completed";
		this.completedAt = new Date();
		this.progress = 100;
	}
	

	#handleError(error: Error): void {
		this.addError(error);
		this.#setFailed();
		this.#reject(error);
	}

	// Utility
	// ================================

	static fromPlainObject(object: TaskOptions<TaskData>): QueueTask<TaskData> {
		return new QueueTask({
			...object
		});
	}

	#generateId(): string {
		return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
	}
	
	#createTimeout(): Promise<never> {
		return new Promise((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Task ${this.uid} timed out after ${this.timeout}ms`));
			}, this.timeout);
		});
	}

	#shouldRetry(error: Error, retrySchema: string[]): boolean {
		const retryableErrors = [
			'Network timeout',
			...retrySchema
		];
		
		return retryableErrors.some(pattern => error.message.includes(pattern));
	}
}
