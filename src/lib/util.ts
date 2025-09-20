import { TypeString } from "@types";
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";

// This module provides build-time type generation utilities
// For runtime type syncing, use the generate-types script instead
import { generateQueueTypes } from "../../scripts/generate-types.js";
export { generateClassName } from "../../scripts/generate-types.js";

/**
 * Utility function to validate the direct contents of any object.
 *
 * @param object
 * @param property The key of the property you want to validate
 * @param expect The value and/or type you expect it to be.
 * @returns
 */
export function hasProperty<T extends object | unknown>(
	object: T,
	property: keyof T | string,
	expect?: {
		type?: TypeString;
		value?: unknown;
	}
) {
	if (typeof object !== "object" || object === null) {
		return false;
	}

	if (!(property in object)) {
		return false;
	}

	const value = object[property as keyof T];

	if (expect?.type && typeof value !== expect.type) {
		return false;
	}

	if (arguments.length >= 3 && expect?.value) {
		// Only check expectValue if it was explicitly provided
		return value === expect.value;
	}

	return true;
}

async function hasTasksChanged(
	taskDirectory: string,
	hash: string
): Promise<{ changed: boolean; reason: string }> {
	const hashFilePath = path.join(taskDirectory, hash);

	const listFiles = async (dir: string): Promise<string[]> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
			else files.push(fullPath);
		}
		return files;
	};

	const computeHash = async (): Promise<string> => {
		const files = await listFiles(taskDirectory);
		files.sort();
		const hasher = createHash("sha1");
		for (const file of files) {
			try {
				const stat = await fs.stat(file);
				hasher.update(file);
				hasher.update(String(stat.size));
				hasher.update(String(stat.mtimeMs));
			} catch {}
		}
		return hasher.digest("hex");
	};

	const currentHash = await computeHash();

	let previousHash: string | null = null;
	try {
		previousHash = (await fs.readFile(hashFilePath, "utf8")).trim();
	} catch {}

	if (!previousHash) return { changed: true, reason: "no previous hash" };
	if (previousHash !== currentHash)
		return { changed: true, reason: "hash mismatch" };
	return { changed: false, reason: "up-to-date" };
}

async function writeHash(taskDirectory: string, hash: string) {
	const hashFilePath = path.join(taskDirectory, hash);

	const listFiles = async (
		dir: string,
		includeHidden: boolean = false
	): Promise<string[]> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			if (entry.name === "node_modules") continue;
			if (includeHidden && entry.name.startsWith(".")) continue; // Skip hidden files unless specified otherwise.

			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
			else files.push(fullPath);
		}
		return files;
	};

	const files = await listFiles(taskDirectory);
	files.sort();
	const hasher = createHash("sha1");
	for (const file of files) {
		try {
			const stat = await fs.stat(file);
			hasher.update(file);
			hasher.update(String(stat.size));
			hasher.update(String(stat.mtimeMs));
		} catch {}
	}
	const digest = hasher.digest("hex");

	try {
		await fs.writeFile(hashFilePath, digest, "utf8");
	} catch {}
}

export async function maybeGenerateTypes(taskDir: string) {
	if (process.env.ANQUEUE_GENERATE_TYPES === "false") return;
	if (process.env.WORKER_ID) return; // only in controller/parent

	const start = Date.now();
	try {
		const { changed, reason } = await hasTasksChanged(
			taskDir,
			".anqueue-types.hash"
		);
		if (!changed) return;

		// Fire-and-forget with timeout
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2000); // 2s budget

		await generateQueueTypes(taskDir, false, { signal: controller.signal });
		clearTimeout(timer);

		await writeHash(taskDir, ".anqueue-types.hash");
	} catch (err) {
		// Log once; don’t fail startup
		console.warn(
			"[anqueue] type generation skipped:",
			err instanceof Error ? err.message : String(err)
		);
	} finally {
		const ms = Date.now() - start;
		if (ms > 100) console.log(`[anqueue] types gen took ${ms}ms`);
	}
}
