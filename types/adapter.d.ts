// Custom type definition for various database clients to avoid import issues
// This allows the package to work without requiring any unnecessary dependencies
export interface PrismaClient {
    // For now, we'll use a generic interface
    [key: string]: any;
}

export interface MySQLClient {
    // For now, we'll use a generic interface
    [key: string]: any;
}

export interface DBAdapterInterface {
	type: DBAdaptorType;
	findFirst(table: string, data: any): Promise<any>;
	findMany(table: string, data: any): Promise<any>;
	update(table: string, data: any): Promise<any>;
	delete(table: string, data: any): Promise<any>;
	create(table: string, data: any): Promise<any>;
	upsert(table: string, data: any): Promise<any>;
}

export type DatabaseClient = PrismaClient | MySQLClient;
export type AdapterImplementation = PrismaAdaptor | MySQLAdaptor;