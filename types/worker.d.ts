export interface WorkerOptions {
    maxConcurrentTasks?: number;
}

export type ProcessEvent = "workerInfo" | "taskInfo" ;
export type WorkerEvent = "setDatabase" | "taskSingle" | "taskBatch" | "getWorkerInfo";

export type WorkerInfo = {
    workerId: string | undefined;
    processId: number;
    taskLoad: number;
    maxLoad: number;
    uptime: number;
};