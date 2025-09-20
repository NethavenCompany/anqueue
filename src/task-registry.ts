import fs from "fs";
import path from "path";

import { Task } from "../index.js";
import TaskExecutor from "./task-executor.js";
import { ensureDir, getFileParts } from "./lib/files.js";
import { generateClassName } from "./lib/util.js";
import { TaskModule } from "../types/task.js";

export default class TaskExecutorRegistry {
	public taskTypes: string[] = [];

	#registry: Map<string, TaskExecutor> = new Map();
	#initialized: boolean = false;
	#workerId: string | undefined = process.env.WORKER_ID;

	constructor() {}

	async #validateExecutorModule(
		executorModule: TaskModule,
		taskType: string
	): Promise<{ passed: boolean; executor: TaskExecutor; reason?: string }> {
		const ExecutorClass = executorModule.default;
		const result = (passed: boolean, reason?: string) => {
			return { executor, passed, reason };
		};

		// Module validation - First we check whether the default export of the module is a TaskExecutor in the first place.
		// ================================================
		if (
			typeof ExecutorClass !== "function" ||
			ExecutorClass === TaskExecutor ||
			!(ExecutorClass.prototype instanceof TaskExecutor)
		) {
			return result(false, "import.default is not an instance of TaskExecutor");
		}

		const executor: TaskExecutor = new ExecutorClass(taskType);
		const className = generateClassName(taskType);
		const retrySchema = executor.retrySchema();
		const validationSchema = executor.validationSchema();

		executor.__rawValidationSchema = () => [...validationSchema];

		// .retrySchema() validation
		// ================================================

		if (!Array.isArray(retrySchema))
			return result(
				false,
				`${className}.retrySchema() does not return an array`
			);

		// .validationSchema() validation
		// ================================================

		if (!Array.isArray(validationSchema))
			return result(
				false,
				`${className}.validationSchema() does not return an array`
			);

		// Loop over schema and find any invalid values
		const invalidEntries: Array<{
			index: number;
			value: unknown;
			reason: string;
		}> = [];
		const cleanValidationSchema = validationSchema.filter((v, i) => {
			let reason = "";

			if (typeof v !== "function") {
				reason = "validator is not a function";
				invalidEntries.push({ index: i, value: v, reason });
				return false;
			}

			const dummyTask = new Task({
				name: "dummyTask",
				description: "dummy validation task",
				type: taskType,
			});

			if (typeof v(dummyTask) !== "boolean") {
				let reason = "validator does not resolve to boolean";
				invalidEntries.push({ index: i, value: v, reason });
				return false;
			}

			return true;
		});

		// If this is not a worker, warn the user of the invalid entries
		if (!this.#workerId) {
			if (invalidEntries.length > 0) {
				console.warn(
					`Validation sanitization for ${className}: removed ${invalidEntries.length} invalid validator(s).` +
						` Indices: [${invalidEntries.map((e) => e.index).join(", ")}];` +
						` Types: [${invalidEntries
							.map((e) => typeof e.value)
							.join(", ")}];` +
						` Reasons: [${invalidEntries.map((e) => e.reason).join(", ")}]`
				);
			}
			if (
				cleanValidationSchema.length === 0 &&
				executor.__rawValidationSchema().length !== 0
			) {
				console.warn(
					`${className}: validationSchema() is empty after sanitization`
				);
			}
		}

		executor.validationSchema = () => [...cleanValidationSchema];

		return result(true);
	}

	public async initialize(taskDirectoryPath: string): Promise<void> {
		if (this.#initialized) return;

		const executorDir = path.join(process.cwd(), taskDirectoryPath);
		await ensureDir(executorDir);

		const executorFiles = (await fs.promises.readdir(executorDir)).filter(
			(file) =>
				(file.endsWith(".ts") || file.endsWith(".js")) &&
				!file.endsWith(".test.ts") &&
				!file.startsWith(".") &&
				!file.includes(".copy")
		);

		for (const file of executorFiles) {
			const importPath = path.join(executorDir, file);
			await this.register(importPath);
		}

		this.#initialized = true;

		console.log(
			`[${
				this.#workerId ? this.#workerId : "Anqueue"
			}] 🔧 Task registry initialized`
		);
	}

	#initWarning() {
		if (!this.#initialized) {
			console.warn(
				`[${
					this.#workerId ? this.#workerId : "Anqueue"
				}] ❗️ Task registry not initialized`
			);
		}
	}

	public async register(importPath: string, type?: string) {
		const importedModule = await import(importPath);
		const taskType = type ?? getFileParts(importPath).nameWithoutExtension;

		// Then we test if the imported module is actually exporting a valid TaskExecutor
		const { executor, passed, reason } = await this.#validateExecutorModule(
			importedModule,
			taskType
		);

		if (!passed) {
			console.error(
				`⏩ Skipping task module ${taskType}, invalid task executor; ${
					reason || ""
				}`
			);
			return;
		}

		this.taskTypes.push(taskType);
		this.#registry.set(taskType, executor);

		// Only log the registration of individual executors on the queue itself, not if it is a worker.
		if (!this.#workerId) {
			console.log(
				`[Anqueue] 🔧 Registered executor for task type: ${executor.taskType}`
			);
		}
	}

	public getRegistry(): Map<string, TaskExecutor> {
		this.#initWarning();

		return this.#registry;
	}

	public getExecutor(type: string): TaskExecutor | undefined {
		this.#initWarning();

		return this.#registry.get(type);
	}
}
