import { Task } from "../index.ts";
import type { Error, PrismaClient } from "./index.js";
import type { TaskData } from "./index.js";

export interface TaskModule {
	default: new (...args: unknown[]) => TaskExecutor;
	[key: string]: unknown;
}

export interface TaskOptions<TData = TaskData> {
    uid?: string;
    name: string;
    type: string;
    description: string;
    priority?: number;
    maxRetries?: number;
    delay?: number;
    timeout?: number;
    data?: TData;
    userId?: number;
    metadata?: Record<string, unknown>;
    runAt?: Date;
}

export type TaskValidationRule<T extends TaskData = TaskData> = (task: Task<T>) => boolean;

export interface TaskStatus {
    uid: string;
    name: string;
    type: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    startedAt?: Date;
    completedAt?: Date;
    error?: Error;
    retryCount: number;
    maxRetries: number;
    userId?: number;
    metadata?: Record<string, unknown>;
    runAt?: Date;
}

export type TaskResult<T> = {
    processed: boolean;
} & T;

export interface WorkerTaskStatus {
    task: Task | null;
    error: string | null;
    result: TaskResult;
}
