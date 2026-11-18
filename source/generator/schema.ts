import { createRequire } from 'module';

/**
 * Structure of the public schema of a database
 */
export type Schema = {
	/**
	 * Labels of each enum, sorted
	 */
	enums: Map<string, string[]>;

	tables: Table[];
	views: View[];
};

export type Table = {
	name: string;

	/**
	 * Columns, sorted by their name
	 */
	columns: Column[];

	/**
	 * Single column foreign keys of the table, sorted by their name
	 */
	foreignKeys: ForeignKey[];
};

export type Column = {
	name: string;
	type: string;
	hasDefault: boolean;
};

export type ForeignKey = {
	name: string;
	table: string;
	column: string;
	foreignTable: string;
	foreignColumn: string;
};

export type View = {
	name: string;
	columns: Column[];
};

/**
 * Reads the public schema of the database
 *
 * postgrejs is resolved through vlquery, so this package does not depend on it directly
 */
export const readSchema = async (connectionOptions: object): Promise<Schema> => {
	const { Connection } = createRequire(require.resolve('vlquery'))('postgrejs') as typeof import('postgrejs');
	const connection = new Connection(connectionOptions);

	const query = async <TRow>(sql: string, params: unknown[] = []) => (await connection.query(sql, { params, objectRows: true })).rows as TRow[];

	await connection.connect();

	try {
		const enums = new Map<string, string[]>();

		for (let row of await query<{ name: string, value: string }>(`
			SELECT t.typname AS name, e.enumlabel AS value
			FROM pg_type t
				JOIN pg_enum e ON t.oid = e.enumtypid
				JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
			WHERE n.nspname = 'public'
		`)) {
			enums.set(row.name, [...enums.get(row.name) ?? [], row.value]);
		}

		for (let values of enums.values()) {
			values.sort();
		}

		const columns = await query<{ table: string, name: string, type: string, has_default: boolean }>(`
			SELECT table_name AS table, column_name AS name, udt_name AS type, column_default IS NOT NULL AS has_default
			FROM information_schema.columns
			WHERE table_schema = 'public'
			ORDER BY column_name
		`);

		const columnsOf = (table: string) => columns.filter(column => column.table == table).map(column => ({
			name: column.name,
			type: column.type,
			hasDefault: column.has_default
		}));

		const foreignKeys = await query<{ name: string, table: string, column: string, foreign_table: string, foreign_column: string }>(`
			SELECT
				c.conname AS name,
				source_table.relname AS table,
				source_column.attname AS column,
				target_table.relname AS foreign_table,
				target_column.attname AS foreign_column
			FROM pg_constraint c
				JOIN pg_class source_table ON source_table.oid = c.conrelid
				JOIN pg_namespace n ON n.oid = source_table.relnamespace
				JOIN pg_attribute source_column ON source_column.attrelid = c.conrelid AND source_column.attnum = c.conkey[1]
				JOIN pg_class target_table ON target_table.oid = c.confrelid
				JOIN pg_attribute target_column ON target_column.attrelid = c.confrelid AND target_column.attnum = c.confkey[1]
			WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1
			ORDER BY c.conname
		`);

		const tables = await query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
		const views = await query<{ name: string }>(`SELECT viewname AS name FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`);

		return {
			enums,

			tables: tables.map(({ name }) => ({
				name,
				columns: columnsOf(name),
				foreignKeys: foreignKeys.filter(key => key.table == name).map(key => ({
					name: key.name,
					table: key.table,
					column: key.column,
					foreignTable: key.foreign_table,
					foreignColumn: key.foreign_column
				}))
			})),

			views: views.map(({ name }) => ({ name, columns: columnsOf(name) }))
		};
	} finally {
		await connection.close();
	}
};
