# AnQueue

AnQueue is a robust, lightweight task queue system for Node.js that discovers task executors from a directory, executes tasks in isolated worker processes, optionally persists state to a database, and provides comprehensive retry/validation hooks with automatic worker management.

## Features

- **Automatic Task Discovery**: Discovers task executors from a directory structure
- **Worker Process Management**: Spawns and manages isolated worker processes with automatic restart
- **Priority-based Scheduling**: Tasks are executed based on priority and creation time
- **Database Integration**: Optional Prisma integration for task persistence
- **Comprehensive Validation**: Built-in task validation with custom validation rules
- **Retry Mechanism**: Configurable retry logic with exponential backoff
- **Progress Tracking**: Real-time task progress monitoring
- **TypeScript Support**: Full TypeScript support with automatic type generation
- **Error Handling**: Robust error handling with detailed error context

## Installation

```bash
npm install anqueue
```

## Quick Start

```typescript
import Queue, { Task, PrismaAdapter } from "anqueue";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Point the queue at your task executors directory
const queue = new Queue("./tasks", { 
  db: new PrismaAdapter(prisma),
  workerPrefix: "MyAppWorker",
  maxWorkers: 2
});

// Initialize the queue (spawns workers and registers executors)
await queue.init();

// Start automatic task processing every 5 seconds
queue.runAutomatically(5);

// Create and enqueue a task
const task = new Task({
  name: "Send Welcome Email",
  type: "test-task", // matches file ./tasks/test-task.ts
  description: "Send welcome email to new user",
  priority: 1,
  data: {
    email: new Email({ to: [], from: "", cc: [] })
  },
  runAt: new Date(new Date.now() + 5000) // Delay execution by 5 seconds
});

queue.add(task);
```

## Task Directory and Executors

Each file in your task directory (e.g., `./tasks`) must export a default class extending `TaskExecutor`. The executor's type is derived from the filename.

### Example Task Executor

```typescript
import { Task, TaskExecutor, TaskValidationRule, TaskResult, hasProperty } from "anqueue";
import Email from "../src/models/Email.js";

export interface TestTaskData {
  email: Email
}

export interface TestTaskResult {
  data?: boolean
}

export default class TestTask extends TaskExecutor<TestTaskData, TestTaskResult> {
  retrySchema(): string[] {
    return [];
  }

  validationSchema(): TaskValidationRule[] {
    return [
      (task: Task<any>) => {
        return hasProperty(task.data, "email") && task.data.email instanceof Email;
      },
    ];
  }

  async exec(_task: Task<TestTaskData>): Promise<TaskResult<TestTaskResult>> {
    return { processed: true }
  }
  
  async onComplete(_task: Task<TestTaskData>, _result: TaskResult<TestTaskResult>, _db: any): Promise<void> {
    // Optional: Handle successful completion
  }

  async onFailure(_task: Task<TestTaskData>, _result: TaskResult<TestTaskResult> | null, _error: unknown, _db: any): Promise<void> {
    // Optional: Handle task failure
  }

  async saveResult(_task: Task<TestTaskData>, _result: TaskResult<TestTaskResult>, _db: any): Promise<void> {
    // Optional: Save result to database
  }
}
```

### Advanced Task Executor with Progress Tracking

```typescript
import { Task, TaskExecutor, TaskResult, TaskValidationRule } from "anqueue";
import { PrismaClient } from '@prisma/client';
import sharp from "sharp";

export interface CompressImageTaskData {
  image: File;
  sizes: { width: number; height: number }[];
}

export interface CompressImageTaskResult {
  files?: File[];
}

export default class CompressImageTask extends TaskExecutor {
  override retrySchema(): string[] {
    return [];
  }

  override validationSchema(): TaskValidationRule[] {
    return [
      (task) => {
        const t = task as Task<CompressImageTaskData>;
        return typeof t.data?.image !== "undefined";
      },
      (task) => {
        const t = task as Task<CompressImageTaskData>;
        return Array.isArray(t.data?.sizes);
      },
    ];
  }

  override async exec(task: Task<CompressImageTaskData>) {
    try {
      const image = task.data.image;
      const sizes = task.data.sizes;
      const progressRate = 100 / sizes.length;
	  const processedFiles = [];

      // Update progress as work is done
      for (let i = 0; i < sizes.length; i++) {
        // Simulate work
        await task.sleep(200);
		const compressedImage = new File([], image.name);
		processedFiles.push(compressedImage);

        task.updateProgress((i + 1) * progressRate);
      }

      return {
        files: processedFiles,
        processed: true
      };
    } catch (error) {
      task.addError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  override async onComplete(task: Task<CompressImageTaskData>) {
    // Handle completion
  }

  override async saveResult(task: Task<CompressImageTaskData>, result: CompressImageTaskResult, db: PrismaClient) {
    // Save to database
  }
}
```

## How Execution Works

1. **Initialization**: `queue.init()` spawns worker processes and initializes the executor registry from your task directory
2. **Task Addition**: `queue.add(task)` enqueues a `Task` instance in memory
3. **Automatic Processing**: `queue.runAutomatically(seconds)` periodically:
   - Syncs with database (if configured)
   - Schedules tasks by priority
   - Sends ready tasks to available workers
4. **Worker Execution**: Workers reconstruct `Task` instances and run executor hooks:
   - `validationSchema()` → each validator function must return true
   - `exec(task)` → must return `{ processed: boolean, ... }`
   - `onComplete(task, result, db)` on success
   - `onFailure(task, result, error, db)` on error
5. **Retry Logic**: If `exec()` throws, the task decides whether to retry based on `retrySchema()` patterns

## Task Configuration

Tasks support various configuration options:

```typescript
const task = new Task({
  name: "Task Name",
  type: "task-type",
  description: "Task description",
  priority: 1, // Higher numbers = higher priority
  maxRetries: 3, // Default: 3
  delay: 1000, // Delay before execution (ms)
  timeout: 30000, // Execution timeout (ms, default: 30s)
  runAt: new Date(), // Schedule for specific time
  data: { /* your data */ },
  userId: 123, // Optional user association
  metadata: { /* custom metadata */ }
});
```

## Worker Management

- **Automatic Spawning**: Workers are automatically spawned as needed
- **Load Balancing**: Tasks are distributed across available workers
- **Crash Recovery**: Automatic restart with exponential backoff
- **Concurrent Execution**: Configurable maximum concurrent tasks per worker

### Worker Configuration

```typescript
const queue = new Queue("./tasks", {
  workerPrefix: "MyAppWorker", // Default: "anqueue-worker-"
  maxWorkers: 3, // Default: 3
  // Workers automatically handle up to 3 concurrent tasks each
});
```

## Database Integration

AnQueue supports optional database integration for persistent task storage and tracking. By connecting a database adapter (such as the provided PrismaAdapter), tasks are automatically saved, updated, and synchronized between memory and your database. This enables reliable task recovery, auditing, and coordination across multiple processes or restarts.

### Expected Database Schema

```sql
CREATE TABLE tasks (
  uid VARCHAR PRIMARY KEY,
  type VARCHAR NOT NULL,
  name VARCHAR,
  description VARCHAR,
  data VARCHAR,
  status VARCHAR NOT NULL,
  data JSON,
  error TEXT,
  started_at TIMESTAMP,
  finished_at TIMESTAMP
);
```

### Database Adapters

When using a database adapter, tasks are automatically persisted and updated.
Pass your generated PrismaClient to the adapter to enable task persistence:

> Note: Currently only an adapter for prisma is available, more are planned in the future.

```typescript
const queue = new Queue("./tasks", { 
  db: new PrismaAdapter(new PrismaClient()) 
});
```


## API Reference

### Queue

- `constructor(taskDirectory: string, options?: QueueOptions)`
- `init(): Promise<Queue>` – spawns workers and registers executors
- `setDatabase(adaptor: AdapterImplementation): void` – set/replace database connection
- `runAutomatically(timeoutSeconds: number): Promise<void>` – periodic processing loop
- `runTasks(tasks?: Task[]): Promise<void>` – send tasks to workers; defaults to all pending in-memory tasks if none specified.
- `scheduleTasks(): Promise<void>` – sort in-memory tasks by priority
- `add(task: Task): this` – add task to queue
- `remove(taskId: string): boolean` – remove task by ID
- `cancel(taskId: string): boolean` – cancel pending task
- `getTask(taskId: string): Task | undefined` – get task by ID
- `getPendingTasks(): Task[]` – get all pending tasks
- `getTaskStatuses(): TaskStatus[]` – get status of all tasks
- `clear(): void` – clear all tasks

### Task

- `constructor(options: TaskOptions<TData>)`
- **Properties**: `uid`, `name`, `type`, `description`, `status`, `progress`, `priority`, `retryCount`, `maxRetries`, `delay`, `timeout`, `runAt`, `data`, `userId`, `metadata`
- **Methods**:
  - `sleep(ms)` – pause execution
  - `validate(validationSchema)` – run validation rules
  - `execute(executor, retrySchema)` – execute with timeout and retry handling
  - `retry()` – prepare for retry attempt
  - `cancel()` – cancel execution
  - `updateProgress(0..100)` – update progress percentage
  - `getStatus()` – get current task status
  - `readyToRun()` – check if task is ready to execute
  - `addError(error)` – add error context

### TaskExecutor

- `constructor(taskType: string)`
- **Hooks to override**:
  - `validationSchema(): TaskValidationRule[]` – validation functions
  - `retrySchema(): string[]` – retry patterns
  - `exec(task): Promise<TaskResult<R>>` – main execution logic
  - `onFailure(task, result, error, db)` – failure handling
  - `onComplete(task, result, db)` – completion handling
  - `saveResult(task, result, db)` – result persistence

## Environment Variables

- `ANQUEUE_GENERATE_TYPES` – Set to `"false"` to disable automatic type generation
- `MAX_TASK_RETRIES` – Default maximum retry attempts (default: 3)
- `TASK_TIMEOUT_MS` – Default task timeout in milliseconds (default: 30000)

## Type Generation

AnQueue automatically generates TypeScript types for your task directory at startup. This is controlled by the `ANQUEUE_GENERATE_TYPES` environment variable and stores a hash in `.anqueue-types.hash` inside your task folder.

## Error Handling

- **Validation Errors**: Tasks fail validation if any rule returns false
- **Execution Errors**: Use `task.addError(error)` to attach context
- **Retry Logic**: Automatic retry based on error message patterns
- **Timeout Handling**: Tasks respect their configured timeout

## Best Practices

1. **Task Naming**: Use descriptive names and types that match your file structure
2. **Validation**: Implement comprehensive validation rules for task data
3. **Error Handling**: Use `task.addError()` to provide context for debugging
4. **Progress Updates**: Call `task.updateProgress()` for long-running tasks
5. **Resource Management**: Implement proper cleanup logic in the `onComplete` and `onFailure` hooks for complex tasks

## Core Architecture

The `src` directory contains the core components that power AnQueue:

- `database-adapter.ts`: Defines the interface for database interactions, allowing AnQueue to be decoupled from specific ORMs or database clients.
- `task.ts`: Represents a single task in the queue, encapsulating its state, data, and lifecycle methods.
- `task-executor.ts`: The base class for all task executors, defining the hooks and methods for task execution, validation, and retry logic.
- `task-registry.ts`: Manages the discovery and registration of `TaskExecutor` classes from the specified task directory.
- `task-store.ts`: Handles in-memory storage and retrieval of tasks, acting as the central source of truth for pending and active tasks.
- `task-strategies.ts`: Contains various strategies for task management, such as scheduling, retry policies, and worker assignment.
- `worker.ts`: Defines the individual worker process responsible for executing tasks in isolation.
- `worker-manager.ts`: Manages the lifecycle of worker processes, including spawning, monitoring, and restarting them as needed.
- `worker-script.ts`: The entry point script executed within each isolated worker process to set up the task execution environment.
- `lib/files.ts`: Utility functions for file system operations, primarily used for task executor discovery.
- `lib/util.ts`: General utility functions used throughout the AnQueue codebase.

## License

MIT
