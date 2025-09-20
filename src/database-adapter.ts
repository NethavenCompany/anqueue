import { PrismaClient, MySQLClient } from "@types";
import { hasProperty } from "./lib/util.js";

export enum AdapterType {
	Prisma = "prisma",
	MySQL = "mysql",
}

export interface DBAdapterInterface {
	type: AdapterType;
	findFirst(table: string, data: any): Promise<any>;
	findMany(table: string, data: any): Promise<any>;
	update(table: string, data: any): Promise<any>;
	delete(table: string, data: any): Promise<any>;
	create(table: string, data: any): Promise<any>;
	upsert(table: string, data: any): Promise<any>;
}

// Prisma Specific Adaptor (Stores database operator methods for prisma)
export class PrismaAdapter<C extends PrismaClient = PrismaClient>
	implements DBAdapterInterface
{
	public type: AdapterType = AdapterType.Prisma;
	public db: C;

	constructor(db: C) {
		this.db = db;
	}

	async findFirst<T extends keyof C>(
		table: T,
		args: Parameters<C[T]["findFirst"]>[0]
	): Promise<ReturnType<C[T]["findFirst"]>> {
		return await this.db[table].findFirst(args as any);
	}

	async findMany<T extends keyof C>(
		table: T,
		args: Parameters<C[T]["findMany"]>[0]
	): Promise<ReturnType<C[T]["findMany"]>> {
		return await this.db[table].findMany(args as any);
	}

	async update<T extends keyof C>(
		table: T,
		args: Parameters<C[T]["update"]>[0]
	): Promise<ReturnType<C[T]["update"]>> {
		return await this.db[table].update(args as any);
	}

	async delete<T extends keyof C>(
		table: T,
		args: Parameters<C[T]["delete"]>[0]
	): Promise<ReturnType<C[T]["delete"]>> {
		return await this.db[table].delete(args as any);
	}

	async create<T extends keyof C>(
		table: T,
		args: Parameters<C[T]["create"]>[0]
	): Promise<ReturnType<C[T]["create"]>> {
		return await this.db[table].create(args as any);
	}

	async upsert<T extends keyof C>(
		table: T,
		data: {
			where: any;
			update: any;
			create: any;
		}
	): Promise<ReturnType<C[T]["upsert"]>> {
		const { where, update, create } = data;
		let r;

		try {
			const result = await this.db[table].upsert({
				where,
				update,
				create,
			});
			r = result;
		} catch (err) {
			// If unique constraint error, try update
			if (
				hasProperty(err as { code: string }, "code", {
					type: "string",
					value: "P202",
				})
			) {
				try {
					const result = await this.db[table].update({
						where,
						data: update,
					});
					r = result;
				} catch (updateErr) {}
			}
		}

		return r;
	}
}

export class MySQLAdapter implements DBAdapterInterface {
	public type: AdapterType = AdapterType.MySQL;
	public db: MySQLClient;

	constructor(db: MySQLClient) {
		this.db = db;
	}

	async findFirst(table: string, data: any): Promise<any> {}
	async findMany(table: string, data: any): Promise<any> {}
	async create(table: string, data: any): Promise<any> {}
	async delete(table: string, data: any): Promise<any> {}
	async update(table: string, data: any): Promise<any> {}
	async upsert(table: string, data: any): Promise<any> {}
}
