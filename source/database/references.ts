import { DatabaseContext, DbSet, Entity, ForeignReference, PrimaryReference, QueryProxy } from 'vlquery';
import { Cohort, Cohorts } from './cohorts';
import { DatabaseInstance } from './instance';
import { Pointers } from './pointers';

/**
 * Stored state of a reference, private in vlquery
 */
type StoredReference = { $stored: unknown, $fetched: boolean };

/**
 * Loads references leading into other cohorts, which may be stored in other databases
 *
 * a foreign key to a pointer loads the entity the pointer points to, from the database the pointer targets
 * a foreign key referencing a pointer of the item loads the referencing entities from the local database
 * other references are loaded by vlquery from the database the item is stored in
 */
export class References {
	constructor(
		private readonly cohorts: Cohorts,
		private readonly pointers: Pointers,
		private readonly local: DatabaseInstance<DatabaseContext>,
		private readonly origins: WeakMap<object, DatabaseInstance<DatabaseContext>>,
		private readonly set: (context: DatabaseContext, type: Function) => DbSet<any, any>
	) {}

	/**
	 * Removes the references leading into other cohorts from the tree, as vlquery would join them in the database the query runs in
	 *
	 * the columns referencing pointers are loaded instead, so the references can be followed once loaded
	 */
	prepareTree(type: Function, tree: any) {
		const model = new (type as new () => Entity<QueryProxy>)();
		const prepared: Record<string, any> = {};

		for (let property in tree) {
			const reference = model[property as keyof typeof model];

			if (reference instanceof ForeignReference && this.cohorts.pointedCohort(type, reference.$column)) {
				prepared[reference.$column!] = true;
			} else if (reference instanceof PrimaryReference && this.cohorts.pointedCohort(reference.$relation, reference.$column)) {
				// related entities are queried by the id of the item
				prepared.id = true;
			} else if ((reference instanceof ForeignReference || reference instanceof PrimaryReference) && typeof tree[property] == 'object') {
				prepared[property] = this.prepareTree(reference.$relation!, tree[property]);
			} else {
				prepared[property] = tree[property];
			}
		}

		return prepared;
	}

	/**
	 * Loads the references of the tree leading into other cohorts, which have not been loaded yet
	 *
	 * every entity reached is remembered with the database it has been loaded from
	 *
	 * @param origin database the items have been loaded from
	 */
	async resolve(items: unknown[], tree: any, origin: DatabaseInstance<DatabaseContext>) {
		const visited = new Set<object>();

		const visit = async (item: unknown, tree: any, origin: DatabaseInstance<DatabaseContext>): Promise<void> => {
			if (!(item instanceof Entity) || visited.has(item)) {
				return;
			}

			visited.add(item);

			// entities loaded before keep their database
			origin = this.origins.get(item) ?? origin;
			this.origins.set(item, origin);

			const tasks: Promise<void>[] = [];

			for (let property in tree) {
				const reference = item[property as keyof typeof item];
				const stored = reference as unknown as StoredReference;
				const subtree = typeof tree[property] == 'object' ? tree[property] : undefined;

				if (reference instanceof ForeignReference) {
					const cohort = this.cohorts.pointedCohort(item.constructor, reference.$column);

					if (cohort && !reference.hasPrefetched) {
						tasks.push(this.loadPointed(cohort, reference.id, subtree, origin).then(pointed => store(stored, pointed)));
					} else {
						tasks.push(visit(stored.$stored, subtree, origin));
					}
				} else if (reference instanceof PrimaryReference) {
					if (this.cohorts.pointedCohort(reference.$relation, reference.$column) && !reference.hasPrefetched) {
						tasks.push(this.loadReferencing(reference, subtree).then(referencing => store(stored, referencing)));
					} else {
						for (let child of (stored.$stored as unknown[] | undefined) ?? []) {
							tasks.push(visit(child, subtree, origin));
						}
					}
				}
			}

			await Promise.all(tasks);
		};

		await Promise.all(items.map(item => visit(item, tree, origin)));
	}

	/**
	 * Loads the top level entity of the cohort from the database its pointer targets
	 *
	 * @param origin database the pointer is looked up in, the database storing the referencing item knows the pointer
	 */
	async loadPointed(cohort: Cohort, id: string | number | null | undefined, tree?: any, origin = this.local) {
		if (id === null || id === undefined) {
			return null;
		}

		const instance = await this.pointers.locate(cohort, id, origin);

		if (!instance) {
			return null;
		}

		const pointed = await instance.use(context => {
			let query = this.set(context, cohort.root).toQuery();

			// vlquery finds nothing with an empty tree
			if (tree && Object.keys(tree).length) {
				query = query.includeTree(this.prepareTree(cohort.root, tree));
			}

			return query.first(byId(id));
		});

		await this.resolve([pointed], tree ?? {}, instance);

		return pointed;
	}

	/**
	 * Loads the entities referencing the pointer of the item from the local database
	 */
	private async loadReferencing(reference: PrimaryReference<Entity<QueryProxy>, QueryProxy>, tree?: any) {
		const referencing = await this.local.use(context => {
			const query = context.related(reference);

			return (tree && Object.keys(tree).length ? query.includeTree(this.prepareTree(reference.$relation, tree)) : query).toArray();
		});

		await this.resolve(referencing, tree ?? {}, this.local);

		return referencing;
	}
}

const store = (reference: StoredReference, value: unknown) => {
	reference.$stored = value;
	reference.$fetched = true;
};

/**
 * Compiled query matching the id, the same vlquery uses for find
 */
export const byId = (id: string | number) => ({ compare: { left: { path: ['id'] }, right: { value: id }, operator: '=' } }) as any;
