import fs from "fs";
import path from "path";

import { Task } from "../index.js";
import TaskExecutor from "./task-executor.js";
import { ensureDir, getFileParts } from "./lib/files.js";
import { generateClassName } from "./lib/util.js";

import type { TaskValidationRule } from "../types/index.d.ts";

export default class TaskExecutorRegistry {
	private _registry: Map<string, TaskExecutor> = new Map();
	private _initialized: boolean = false;
	private _workerId: string | undefined = process.env.WORKER_ID;

	constructor() {}

	private async validateExecutorModule(
		executorModule: any,
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
		const invalidEntries: Array<{ index: number; value: unknown; reason: string }> = [];
		const cleanValidationSchema = validationSchema.filter((v, i) => {
			let reason = "";

			if (typeof v !== "function") {
				reason = "validator is not a function";
				invalidEntries.push({ index: i, value: v, reason });
				return false;
			}
			
			const dummyTask = new Task({ name: "dummyTask", description: "dummy validation task", type: taskType });
			
			if(typeof v(dummyTask) !== "boolean") {
				let reason = "validator does not resolve to boolean";
				invalidEntries.push({ index: i, value: v, reason });
				return false;
			}

			return true;
		});

		// If this is not a worker, warn the user of the invalid entries
		if(!this._workerId) {
			if (invalidEntries.length > 0) {
				console.warn(
					`Validation sanitization for ${className}: removed ${invalidEntries.length} invalid validator(s).` +
					` Indices: [${invalidEntries.map(e => e.index).join(", ")}];` +
					` Types: [${invalidEntries.map(e => typeof e.value).join(", ")}];` +
					` Reasons: [${invalidEntries.map(e => e.reason).join(", ")}]`
				);
			}
			if (cleanValidationSchema.length === 0 && executor.__rawValidationSchema().length !== 0) {
				console.warn(`${className}: validationSchema() is empty after sanitization`);
			}
		}

		executor.validationSchema = () => [...cleanValidationSchema];

		return result(true);
	}

	public async initialize(taskDirectoryPath: string): Promise<void> {
		if (this._initialized) return;

		const executorDir = path.join(process.cwd(), taskDirectoryPath);

		await ensureDir(executorDir);

		const executorFiles = (await fs.promises.readdir(executorDir)).filter(
			(file) =>
				(file.endsWith(".ts") || file.endsWith(".js")) &&
				!file.endsWith(".test.ts") &&
				!file.startsWith(".") &&
				!file.includes(".copy")
		);

		// Find and all TaskExecutor classes in src/tasks and register them (this has to be done on both the server and the worker).
		for (const file of executorFiles) {
			const taskType = getFileParts(file).nameWithoutExtension; // Use the name of the file as the executor type
			const importPath = path.join(executorDir, file);
			const importedModule = await import(importPath);

			// Then we test if the imported module is actually exporting a valid TaskExecutor
			// If validation
			const { executor, passed, reason } = await this.validateExecutorModule(
				importedModule,
				taskType
			);

			if (!passed) {
				console.error(
					`⏩ Skipping task module ${taskType}, invalid task executor; ${
						reason || ""
					}`
				);
				continue;
			}

			this._registry.set(executor.taskType, executor);

			// Only log the registration of individual executors on the queue itself, not if it is a worker.
			if (!this._workerId) {
				console.log(
					`[Anqueue] 🔧 Registered executor for task type: ${executor.taskType}`
				);
			}
		}

		this._initialized = true;

		console.log(`[${this._workerId ? "Worker: " + this._workerId : "Anqueue"}] 🔧 Task registry initialized`);
	}

	public getRegistry(): Map<string, TaskExecutor> {
		return this._registry;
	}

	public getExecutor(type: string): TaskExecutor | undefined {
		return this._registry.get(type);
	}
}
