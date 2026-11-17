import { DatabaseContext, DbSet, Entity, ForeignReference, QueryProxy } from 'vlquery';

/**
 * Suffix of entity classes that are kept internal
 */
export const pointerSuffix = '_Pointer';

/**
 * Database structure which can not be parsed into cohorts
 */
export class CohortStructureError extends Error {
	constructor(readonly problems: string[]) {
		super(`Invalid cohort structure:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
	}
}

/**
 * Sets of the schema parsed into cohorts
 */
export type Cohorts = {
	setNames: Map<Function, string>;

	/**
	 * Top level type to the name of its pointer set
	 */
	pointerSetNames: Map<Function, string>;

	/**
	 * Pointer type to the name of the set it points to
	 */
	pointedSetNames: Map<Function, string>;

	/**
	 * Type to the names of the pointer sets of the cohorts it belongs to, at most one
	 */
	cohortPointerSetNames: Map<Function, string[]>;
};

export const isPointer = (type: Function) => type.name.endsWith(pointerSuffix);

/**
 * Parses the sets of the schema into cohorts
 *
 * the structure is validated along, every problem found is collected before throwing a CohortStructureError
 * - a pointer table points to a table, has a target column, shares the id type of the table it points to and references no other tables
 * - a table belongs to one cohort at most, as its rows are stored in one database
 * - a top level table references the tables of other cohorts through their pointer tables
 */
export const parseCohorts = (schema: DatabaseContext): Cohorts => {
	const problems: string[] = [];

	const cohorts: Cohorts = {
		setNames: new Map(),
		pointerSetNames: new Map(),
		pointedSetNames: new Map(),
		cohortPointerSetNames: new Map()
	};

	for (let name in schema) {
		const set = schema[name as keyof DatabaseContext];

		if (set instanceof DbSet) {
			cohorts.setNames.set(set.modelConstructor, name);
		}
	}

	for (let [type, name] of cohorts.setNames) {
		if (isPointer(type)) {
			const pointer = createModel(type);
			const pointedName = name.substring(0, name.length - pointerSuffix.length);
			const pointedSet = schema[pointedName as keyof DatabaseContext];

			if (!(pointedSet instanceof DbSet)) {
				problems.push(`Pointer table '${pointer.$$meta.source}' does not point to a table, no table '${pointer.$$meta.source.replace(/__pointer$/, '')}' found`);

				continue;
			}

			const pointed = createModel(pointedSet.modelConstructor);

			if (!pointer.$$meta.columns.target) {
				problems.push(`Pointer table '${pointer.$$meta.source}' has no column 'target'`);
			}

			if (pointer.$$meta.columns.id?.type != pointed.$$meta.columns.id?.type) {
				problems.push(`Pointer table '${pointer.$$meta.source}' has an id of type '${pointer.$$meta.columns.id?.type}', but '${pointed.$$meta.source}' has an id of type '${pointed.$$meta.columns.id?.type}'`);
			}

			for (let [column, relation] of foreignReferences(pointer)) {
				problems.push(`Pointer table '${pointer.$$meta.source}' references '${createModel(relation).$$meta.source}' (column '${column}'), pointer tables are stored in every database and can not reference other tables`);
			}

			cohorts.pointerSetNames.set(pointedSet.modelConstructor, name);
			cohorts.pointedSetNames.set(type, pointedName);
		}
	}

	for (let type of cohorts.setNames.keys()) {
		if (!isPointer(type)) {
			cohorts.cohortPointerSetNames.set(type, findCohortPointerSetNames(cohorts, type, new Set()));
		}
	}

	// cohorts are named after their top level table
	const cohortSource = (pointerSetName: string) => createModel([...cohorts.pointerSetNames].find(([, name]) => name == pointerSetName)![0]).$$meta.source;

	for (let [type, pointerSetNames] of cohorts.cohortPointerSetNames) {
		const model = createModel(type);

		if (pointerSetNames.length > 1) {
			problems.push(`Table '${model.$$meta.source}' belongs to multiple cohorts (${pointerSetNames.map(name => `'${cohortSource(name)}'`).join(', ')}), its rows can only be stored in one database. Reference all but one of them through their pointer tables`);
		}

		const pointerSetName = cohorts.pointerSetNames.get(type);

		// tables below the top level table join the cohorts they reference, which is covered above
		if (pointerSetName) {
			for (let [column, relation] of foreignReferences(model)) {
				const referenced = isPointer(relation) ? [] : cohorts.cohortPointerSetNames.get(relation) ?? [];

				if (referenced.length && !referenced.includes(pointerSetName)) {
					problems.push(`Top level table '${model.$$meta.source}' references '${createModel(relation).$$meta.source}' of the cohort of '${cohortSource(referenced[0])}' directly (column '${column}'), its rows can be stored in another database. Reference '${cohortSource(referenced[0])}' through its pointer table instead`);
				}
			}
		}
	}

	if (problems.length) {
		throw new CohortStructureError(problems);
	}

	return cohorts;
};

/**
 * Pointer sets of the top level types the type references, directly or through other entities
 */
const findCohortPointerSetNames = (cohorts: Cohorts, type: Function, visited: Set<Function>): string[] => {
	const pointerSetName = cohorts.pointerSetNames.get(type);

	if (pointerSetName) {
		return [pointerSetName];
	}

	if (visited.has(type)) {
		return [];
	}

	visited.add(type);

	const names = new Set<string>();

	// a reference to a pointer leads into another cohort
	for (let [, relation] of foreignReferences(createModel(type))) {
		if (!isPointer(relation)) {
			for (let name of findCohortPointerSetNames(cohorts, relation, visited)) {
				names.add(name);
			}
		}
	}

	return [...names];
};

/**
 * Foreign references of the model, by the name of their column
 */
const foreignReferences = (model: Entity<QueryProxy>) => {
	const references: [string, Function][] = [];

	for (let key in model) {
		const reference = model[key as keyof typeof model];

		if (reference instanceof ForeignReference && reference.$relation) {
			references.push([model.$$meta.columns[reference.$column!]?.name ?? reference.$column, reference.$relation]);
		}
	}

	return references;
};

const createModel = (type: Function) => new (type as new () => Entity<QueryProxy>)();
