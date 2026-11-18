import { DbSet, Entity, QueryProxy } from 'vlquery';

/**
 * Column of a pointer table naming the database the cohort is stored in, by its tag
 */
export const pointerTargetColumn = 'target';

/**
 * Cohort structure of the schema, generated into the context by `acryps-local create-context`
 *
 * pointer tables are not part of the context, they are only named here
 */
export type CohortStructure = {
	cohorts: CohortDescription[];

	/**
	 * Foreign keys to pointer tables, they lead to the top level entity of a cohort which may be stored in another database
	 */
	pointerReferences: PointerReferenceDescription[];
};

export type CohortDescription = {
	/**
	 * Top level table, its rows share the id of their pointer
	 */
	root: Function;

	/**
	 * Name of the pointer table, which names the database the cohort is stored in
	 */
	pointer: string;

	/**
	 * Other tables of the cohort, every table after the tables of the cohort it references
	 */
	members: CohortMemberDescription[];
};

export type CohortMemberDescription = {
	type: Function;

	/**
	 * Tables of the cohort the member references directly, by the referencing property
	 */
	parents: { type: Function, column: string }[];
};

export type PointerReferenceDescription = {
	type: Function;

	/**
	 * Property of the column referencing the pointer
	 */
	column: string;

	/**
	 * Top level table of the cohort the pointer belongs to
	 */
	root: Function;
};

/**
 * Set of the top level table of a cohort, its queries read the local database, the remote databases or all of them
 */
export class RootSet<TModel extends Entity<TQueryProxy>, TQueryProxy extends QueryProxy> extends DbSet<TModel, TQueryProxy> {
	declare private readonly $$root: never;
}

/**
 * Set of a table of a cohort below its top level table, its rows are located by the pointer of their top level entity
 */
export class MemberSet<TModel extends Entity<TQueryProxy>, TQueryProxy extends QueryProxy> extends DbSet<TModel, TQueryProxy> {
	declare private readonly $$member: never;
}
