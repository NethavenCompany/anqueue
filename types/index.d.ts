import type { AdapterImplemantation } from "../src/database-adapter.ts";

// Re-export all types from their respective modules
export type * from "./adapter.js";
export type * from "./task.js";
export type * from "./taskdata.js";
export type * from "./adapter.js";
export type * from "./worker.js";

export type TypeString = "bigint" | "boolean" | "string" | "function" | "number" | "object" | "symbol" | "undefined";

export interface QueueOptions {
    id?: string;
    db?: AdapterImplemantation;
    workerPrefix?: string;
    maxWorkers?: number;
}
