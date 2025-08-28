// Re-export all types from their respective modules
export type * from "./error.js";
export type * from "./task.js";
export type * from "./taskdata.js";

export type TypeString = "bigint" | "boolean" | "string" | "function" | "number" | "object" | "symbol" | "undefined";

// Custom type definition for PrismaClient to avoid import issues
// This allows the package to work without requiring @prisma/client as a dependency
export interface PrismaClient {
    // Add any specific Prisma methods you need here
    // For now, we'll use a generic interface
    [key: string]: any;
}

export interface QueueOptions {
    db?: PrismaClient;
    workerPrefix?: string;
    maxWorkers?: number;
}

export interface WorkerOptions {
    maxConcurrentTasks?: number;
}

export type ProcessEvent = "workerInfo" | "taskLoadUpdated" | "taskInfo" ;
export type WorkerEvent = "setDatabase" | "task" | "getWorkerInfo" | "setTaskLoad";