import { hasProperty } from "./util.js";

export async function waitForDbRecord<T>(
	dbTable: { findFirst: (args: { where: any }) => Promise<T | null> },
	searchParams: { where: any },
	maxAttempts: number,
	delayMs: number
): Promise<any> {
	let attempts = 0;
	let record: T | null = null;

	while (attempts < maxAttempts) {
		record = await dbTable.findFirst(searchParams);
		if (record) return record;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		attempts++;
	}
	return null;
}

/**
 * Anqueue's wrapper function around prisma's table upsert method.
 * 
 * This method has an additional update fallback incase a unique constraint error occurs.
 * Additionally you can pass an onComplete callback to execute some code whenever the DB row has succeeded in updating.
 * 
 * @param dbTable 
 * @param where 
 * @param insert 
 * @param onComplete 
 * @returns 
 */
export async function safeUpsert<T>(
	dbTable: {
		update: (args: { where: any; data: any }) => Promise<T | null>;
		upsert: (args: {
			where: any;
			update: any;
			create: any;
		}) => Promise<T | null>;
	},
	where: unknown,
	insert: Record<string, unknown>,
	onComplete?: (result: any) => Promise<void>
) {
	try {
		const result = await dbTable.upsert({
			where,
			update: insert,
			create: insert,
		});

		if (onComplete && typeof onComplete === "function") {
			await onComplete(result);
		}
	} catch (err) {

		// If unique constraint error, try update
		if (hasProperty(err as { code: string }, "code", { type: "string", value: "P202" })) {
			try {
				const result = await dbTable.update({
					where,
					data: insert,
				});

				if (onComplete && typeof onComplete === "function") {
					await onComplete(result);
				}
			} catch (updateErr) {}
		} else {
		}
	}
}