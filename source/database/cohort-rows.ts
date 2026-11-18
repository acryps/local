import { DatabaseContext } from 'vlquery';
import { CohortTable } from './cohorts';
import { identifier } from './pointers';

/**
 * Rows of a cohort by table, each row by its id, serialized as json by the database
 */
export type CohortRows = Map<CohortTable, Map<string, string>>;

/**
 * Rows of the cohort, read as json so they can be inserted into another database as they are
 *
 * starts at the top level row and follows the references of the children until no new rows are found
 *
 * @param tables tables of the cohort, children first
 */
export const collectCohort = async (context: DatabaseContext, tables: CohortTable[], id: string | number): Promise<CohortRows> => {
	const cohort: CohortRows = new Map(tables.map(table => [table, new Map()]));
	const root = tables[tables.length - 1];

	const add = (table: CohortTable, rows: [string, string][]) => {
		const stored = cohort.get(table)!;
		const added: string[] = [];

		for (let [id, row] of rows) {
			if (!stored.has(id)) {
				stored.set(id, row);
				added.push(row);
			}
		}

		return added;
	};

	const queue: [CohortTable, string[]][] = [[root, add(root, await context.$$query(`SELECT t.id::text, row_to_json(t)::text FROM ${identifier(root.source)} t WHERE t.id = $1`, [id]))]];

	while (queue.length) {
		const [parent, rows] = queue.shift()!;

		for (let child of parent.children) {
			const added = add(child.table, await context.$$query(`SELECT t.id::text, row_to_json(t)::text FROM ${identifier(child.table.source)} t WHERE t.${identifier(child.column)} IN (SELECT id FROM json_populate_recordset(NULL::${identifier(parent.source)}, $1::json))`, [jsonArray(rows)]));

			if (added.length) {
				queue.push([child.table, added]);
			}
		}
	}

	return cohort;
};

/**
 * Rows of the pointers referenced by the cohort, by the name of the pointer table
 */
export const collectReferencedPointers = async (context: DatabaseContext, tables: CohortTable[], cohort: CohortRows) => {
	const pointers = new Map<string, Set<string>>();

	for (let table of tables) {
		const rows = cohort.get(table)!;

		if (rows.size) {
			for (let { pointer, column } of table.pointerColumns) {
				const found: [string][] = await context.$$query(`SELECT row_to_json(p)::text FROM ${identifier(pointer)} p WHERE p.id IN (SELECT ${identifier(column)} FROM json_populate_recordset(NULL::${identifier(table.source)}, $1::json))`, [jsonArray(rows.values())]);

				if (!pointers.has(pointer)) {
					pointers.set(pointer, new Set());
				}

				for (let [row] of found) {
					pointers.get(pointer)!.add(row);
				}
			}
		}
	}

	return pointers;
};

/**
 * Inserts the referenced pointers the database does not know yet, then the rows of the cohort, parents first
 */
export const insertCohort = async (context: DatabaseContext, tables: CohortTable[], cohort: CohortRows, pointers: Map<string, Set<string>>) => {
	for (let [pointer, rows] of pointers) {
		await context.$$query(`INSERT INTO ${identifier(pointer)} SELECT * FROM json_populate_recordset(NULL::${identifier(pointer)}, $1::json) ON CONFLICT (id) DO NOTHING`, [jsonArray(rows)]);
	}

	for (let table of [...tables].reverse()) {
		const rows = cohort.get(table)!;

		if (rows.size) {
			await context.$$query(`INSERT INTO ${identifier(table.source)} SELECT * FROM json_populate_recordset(NULL::${identifier(table.source)}, $1::json)`, [jsonArray(rows.values())]);
		}
	}
};

/**
 * Deletes the rows of the cohort, children first, pointers are kept
 */
export const deleteCohort = async (context: DatabaseContext, tables: CohortTable[], cohort: CohortRows) => {
	for (let table of tables) {
		const rows = cohort.get(table)!;

		if (rows.size) {
			await context.$$query(`DELETE FROM ${identifier(table.source)} WHERE id IN (SELECT id FROM json_populate_recordset(NULL::${identifier(table.source)}, $1::json))`, [jsonArray(rows.values())]);
		}
	}
};

/**
 * Json array of rows already serialized by the database, so their values never pass through javascript numbers
 */
const jsonArray = (rows: Iterable<string>) => `[${[...rows].join(',')}]`;
