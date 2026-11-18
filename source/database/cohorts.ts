import { DatabaseContext, DbSet, Entity, QueryProxy } from 'vlquery';
import { CohortStructure } from '../structure';

/**
 * Cohort of the schema, read from the structure generated into the context
 */
export type Cohort = {
	root: Function;

	/**
	 * Name of the pointer table
	 */
	pointer: string;

	/**
	 * Type of the id shared by the root and its pointer
	 */
	idType: string;

	/**
	 * Tables of the cohort, every table after the tables referencing it (children first)
	 */
	tables: CohortTable[];
};

/**
 * Table of a cohort, with the tables of the cohort referencing it and its columns referencing pointers
 */
export type CohortTable = {
	type: Function;
	source: string;
	children: { table: CohortTable, column: string }[];
	pointerColumns: { pointer: string, column: string }[];
};

/**
 * Cohort structure of a generated context, indexed by type
 */
export class Cohorts {
	/**
	 * Name of the set of each type
	 */
	readonly setNames = new Map<Function, string>();

	private readonly cohorts = new Map<Function, Cohort>();

	/**
	 * Cohort each pointer reference leads to, by type and property of the referencing column
	 */
	private readonly pointerReferences = new Map<Function, Map<string, Cohort>>();

	constructor(schema: DatabaseContext, structure: CohortStructure | undefined) {
		if (!structure) {
			throw new Error(`Context '${schema.constructor.name}' has no cohort structure, create it with 'acryps-local create-context'`);
		}

		for (let name in schema) {
			const set = schema[name as keyof DatabaseContext];

			if (set instanceof DbSet) {
				this.setNames.set(set.modelConstructor, name);
			}
		}

		const roots = new Map<Function, Cohort>();

		for (let description of structure.cohorts) {
			const cohort: Cohort = { root: description.root, pointer: description.pointer, idType: meta(description.root).columns.id.type, tables: [] };
			const tables = new Map<Function, CohortTable>();

			for (let type of [description.root, ...description.members.map(member => member.type)]) {
				tables.set(type, { type, source: meta(type).source, children: [], pointerColumns: [] });
				this.cohorts.set(type, cohort);
			}

			for (let member of description.members) {
				for (let parent of member.parents) {
					tables.get(parent.type)!.children.push({ table: tables.get(member.type)!, column: meta(member.type).columns[parent.column].name });
				}
			}

			// members are described after their parents
			cohort.tables = [...tables.values()].reverse();
			roots.set(description.root, cohort);
		}

		for (let reference of structure.pointerReferences) {
			const cohort = roots.get(reference.root)!;

			if (!this.pointerReferences.has(reference.type)) {
				this.pointerReferences.set(reference.type, new Map());
			}

			this.pointerReferences.get(reference.type)!.set(reference.column, cohort);
			this.cohorts.get(reference.type)?.tables.find(table => table.type == reference.type)!.pointerColumns.push({ pointer: cohort.pointer, column: meta(reference.type).columns[reference.column].name });
		}
	}

	/**
	 * Cohort the type belongs to, as root or member
	 */
	cohort(type: Function) {
		return this.cohorts.get(type);
	}

	/**
	 * Cohort of which the type is the root
	 */
	rootCohort(type: Function) {
		const cohort = this.cohorts.get(type);

		return cohort?.root == type ? cohort : undefined;
	}

	/**
	 * Cohort the column of the type leads to through its pointer, undefined if the column does not reference a pointer
	 */
	pointedCohort(type: Function | undefined, column: string | undefined) {
		return type && column ? this.pointerReferences.get(type)?.get(column) : undefined;
	}

	/**
	 * Columns of the type referencing pointers, by their property
	 */
	pointerColumns(type: Function) {
		return [...this.pointerReferences.get(type) ?? []];
	}
}

export const meta = (type: Function) => new (type as new () => Entity<QueryProxy>)().$$meta;
