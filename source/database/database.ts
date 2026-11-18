import { DatabaseContext, DbClient, DbSet, Entity, ForeignReference, PrimaryReference, QueryProxy, ViewSet } from 'vlquery';
import { DatabaseConfiguration } from '../types/database-configuration';
import { isPointer, parseCohorts, pointerSuffix } from './cohorts';
import { DatabaseInstance } from './instance';
import { QueryScope, RoutedQuery, RoutedQueryHooks, ScopedQueryable, scopedQueryMethods } from './routed-query';

export { QueryScope, ScopedQueryable } from './routed-query';

/**
 * Milliseconds a remote connection stays open after its last use
 */
const defaultRemoteIdleTimeout = 60 * 1000;

/**
 * PostgreSQL error code of a violated foreign key
 */
const foreignKeyViolation = '23503';

/**
 * Methods exposed on sets and views, everything else (like the context) stays hidden
 */
const queryMethods = [
	'find',
	'toQuery',
	'where',
	'include',
	'includeTree',
	'orderByAscending',
	'orderByDescending',
	'skip',
	'limit',
	'page'
] as const;

/**
 * Methods exposed on a view, views only read the local database
 */
const viewMethods = [...queryMethods, 'first', 'single', 'toArray', 'count'] as const;

/**
 * Methods exposed on a set, its terminal methods name the databases they read (`toArrayLocal`, `toArrayRemote`, `toArrayAll`)
 */
const setMethods = [...queryMethods, ...scopedQueryMethods];

/**
 * Names of the sets which are not pointers
 *
 * the generator names sets after their tables, just like their entity classes, so they share the '_Pointer' suffix
 */
export type ExposedSetName<TContext> = {
	[Key in keyof TContext]: Key extends `${string}${typeof pointerSuffix}` ? never : TContext[Key] extends DbSet<any, any> ? Key : never
}[keyof TContext] & string;

/**
 * Set reduced to its public methods, terminal methods name the databases they read, find is located by the pointer of the cohort
 */
export type ExposedSet<TSet> = (TSet extends DbSet<infer TModel, infer TQueryProxy> ? ScopedQueryable<TModel, TQueryProxy> & {
	toQuery(): ScopedQueryable<TModel, TQueryProxy>;
} : never) & {
	/**
	 * Loads the entity from the database the pointer of its cohort targets
	 *
	 * @param pointerId id of the top level entity of the cohort (`message.find(chatId, messageId)`)
	 * @param id id of the entity, defaults to the pointer id for top level entities (`account.find(accountId)`)
	 */
	find(pointerId: string | number, id?: string | number): Promise<ModelOf<TSet>>;
};

/**
 * View reduced to its public methods
 */
export type ExposedView<TSet> = Pick<TSet, typeof viewMethods[number] & keyof TSet>;

export type ExposedSets<TContext> = { readonly [Name in ExposedSetName<TContext>]: ExposedSet<TContext[Name]> };
export type ExposedViews<TContext> = TContext extends { views: infer TViews } ? { readonly [Name in keyof TViews]: ExposedView<TViews[Name]> } : {};

/**
 * Model of a set, distributes over unions of sets
 */
export type ModelOf<TSet> = TSet extends DbSet<infer TModel, any> ? TModel : never;

/**
 * Entities of the sets which are not pointers
 */
export type ExposedModel<TContext> = ModelOf<TContext[ExposedSetName<TContext>]>;

/**
 * Entity a pointer model points to, or the model itself if it is not a pointer
 */
export type PointedModel<TContext, TModel> = [TModel] extends [ModelOf<TContext[keyof TContext]>] ? ({
	[Key in keyof TContext]: Key extends `${infer Base}${typeof pointerSuffix}`
		? (ModelOf<TContext[Key]> extends TModel ? (Base extends keyof TContext ? ModelOf<TContext[Base]> : never) : never)
		: never
}[keyof TContext] extends infer TPointed ? ([TPointed] extends [never] ? TModel : TPointed) : never) : TModel;

/**
 * Single database distributed over multiple locations
 *
 * the top level table of a cohort has a pointer table, which names the database (by its tag) the cohort is stored in
 * the other tables of the cohort reference the top level table, so their rows are stored in the same database
 *
 * queries read the local database, the remote databases or all of them, as named by their terminal method (`toArrayLocal`, `toArrayRemote`, `toArrayAll`)
 * entities are loaded from remote databases by following a pointer, either a reference to a pointer or the pointer id passed to find, update and delete
 */
export class Database<TContext extends DatabaseContext> {
	/**
	 * Tag of the local database
	 */
	readonly tag: string;

	readonly sets: ExposedSets<TContext>;
	readonly views: ExposedViews<TContext>;

	private readonly local: DatabaseInstance<TContext>;
	private readonly remotes = new Map<string, DatabaseInstance<TContext>>();

	/**
	 * Context without a connection, only used to read the schema
	 */
	private readonly schema: TContext;

	private readonly setNames: Map<Function, string>;

	/**
	 * Top level type to the name of its pointer set
	 */
	private readonly pointerSetNames: Map<Function, string>;

	/**
	 * Pointer type to the name of the set it points to
	 */
	private readonly pointedSetNames: Map<Function, string>;

	/**
	 * Type to the names of the pointer sets of the cohorts it belongs to
	 */
	private readonly cohortPointerSetNames: Map<Function, string[]>;

	/**
	 * Database each loaded or written entity is stored in, entities do not remember it themselves
	 */
	private readonly origins = new WeakMap<object, DatabaseInstance<TContext>>();

	constructor(configuration: DatabaseConfiguration<TContext>) {
		this.tag = configuration.local.tag;
		this.local = new DatabaseInstance(configuration.local, configuration.context, configuration.runContext);

		for (let connection of configuration.remotes ?? []) {
			if (connection.tag == this.tag || this.remotes.has(connection.tag)) {
				throw new Error(`Database tag '${connection.tag}' is not unique`);
			}

			this.remotes.set(connection.tag, new DatabaseInstance(connection, configuration.context, configuration.runContext, configuration.remoteIdleTimeout ?? defaultRemoteIdleTimeout));
		}

		this.schema = new configuration.context(new DbClient(), configuration.runContext);

		// throws if the structure can not be parsed into cohorts
		({
			setNames: this.setNames,
			pointerSetNames: this.pointerSetNames,
			pointedSetNames: this.pointedSetNames,
			cohortPointerSetNames: this.cohortPointerSetNames
		} = parseCohorts(this.schema));

		const sets: Record<string, object> = {};

		for (let [type, name] of this.setNames) {
			if (!this.isPointer(type)) {
				sets[name] = this.exposeSet(
					(pointerId: string | number, id = pointerId) => this.find(type, pointerId, id),
					() => new RoutedQuery(type, scope => this.scopeInstances(scope), context => this.set(context, name).toQuery(), this.queryHooks(type)),
					setMethods
				);
			}
		}

		this.sets = Object.freeze(sets) as ExposedSets<TContext>;

		const views: Record<string, object> = {};
		const schemaViews = (this.schema as { views?: Record<string, ViewSet<any, any>> }).views ?? {};

		for (let name in schemaViews) {
			const view = () => (this.local.context as unknown as { views: Record<string, ViewSet<any, any>> }).views[name];

			views[name] = this.exposeSet((id: string | number) => view().find(id), view, viewMethods);
		}

		this.views = Object.freeze(views) as ExposedViews<TContext>;
	}

	/**
	 * Connects to the local database, remote databases are connected on demand
	 */
	async connect() {
		await this.local.open();
	}

	/**
	 * Closes all connections
	 */
	async close() {
		await Promise.all([this.local, ...this.remotes.values()].map(instance => instance.close()));
	}

	/**
	 * Creates a top level item, or an item which is not part of a cohort, in the local database
	 *
	 * a top level item gets a pointer to the local database first, the item is created with the id of the pointer
	 * the databases storing the cohorts the top level item references through their pointers get a pointer to it as well
	 */
	async create<TModel extends ExposedModel<TContext>>(item: TModel, comment?: string): Promise<TModel>;

	/**
	 * Creates the item in the database the pointer of its cohort targets
	 *
	 * @param pointerId id of the top level entity of the cohort (`create(chatId, message)`)
	 */
	async create<TModel extends ExposedModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<TModel>;

	async create<TModel extends ExposedModel<TContext>>(...args: [TModel, string?] | [string | number, TModel, string?]): Promise<TModel> {
		const [pointerId, item, comment] = splitItemArguments(args);

		this.requireExposed(item.constructor);

		const pointerSetName = this.pointerSetNames.get(item.constructor);

		if (pointerSetName) {
			// top level items are always created in the local database
			if (pointerId !== undefined) {
				throw new Error(`'${item.constructor.name}' is a top level entity and can only be created in database '${this.tag}'`);
			}

			const created = await this.local.use(async context => createWithId(context, item, await this.insertPointer(context, pointerSetName), comment));
			this.origins.set(created, this.local);

			await this.createReferencingPointers(created, pointerSetName);

			return created;
		}

		if (this.cohortPointerSetNames.get(item.constructor)?.length) {
			if (pointerId === undefined) {
				throw new Error(`'${item.constructor.name}' is part of a cohort, the pointer id is required to create it`);
			}

			const instance = await this.requireCohortInstance(item.constructor, pointerId);

			return this.remember(await instance.use(context => context.create(item, comment)), instance);
		}

		return this.remember(await this.local.use(context => context.create(item, comment)), this.local);
	}

	/**
	 * Updates the item in the database it has been loaded from
	 *
	 * a top level item, or an item which is not part of a cohort, does not have to be loaded through this database
	 */
	async update<TModel extends ExposedModel<TContext>>(item: TModel, comment?: string): Promise<TModel>;

	/**
	 * Updates the item in the database the pointer of its cohort targets
	 *
	 * @param pointerId id of the top level entity of the cohort (`update(chatId, message)`)
	 */
	async update<TModel extends ExposedModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<TModel>;

	async update<TModel extends ExposedModel<TContext>>(...args: [TModel, string?] | [string | number, TModel, string?]): Promise<TModel> {
		const [pointerId, item, comment] = splitItemArguments(args);

		this.requireExposed(item.constructor);

		const instance = await this.itemInstance(item, pointerId);

		return this.remember(await instance.use(context => context.update(item, comment)), instance);
	}

	/**
	 * Deletes the item from the database it has been loaded from
	 *
	 * a top level item, or an item which is not part of a cohort, does not have to be loaded through this database
	 * a top level item takes its pointer in that database along, unless rows of other cohorts still reference it, pointers in other databases are left as they are
	 * a deactivated item keeps its pointer, as its rows are still stored
	 */
	async delete<TModel extends ExposedModel<TContext>>(item: TModel, comment?: string): Promise<void>;

	/**
	 * Deletes the item from the database the pointer of its cohort targets
	 *
	 * @param pointerId id of the top level entity of the cohort (`delete(chatId, message)`)
	 */
	async delete<TModel extends ExposedModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<void>;

	async delete<TModel extends ExposedModel<TContext>>(...args: [TModel, string?] | [string | number, TModel, string?]): Promise<void> {
		const [pointerId, item, comment] = splitItemArguments(args);

		this.requireExposed(item.constructor);

		const instance = await this.itemInstance(item, pointerId);
		const pointerSetName = this.pointerSetNames.get(item.constructor);

		await instance.use(async context => {
			await context.delete(item, comment);

			if (pointerSetName && !item.$$meta.active) {
				await this.deletePointer(context, pointerSetName, item.id);
			}
		});
	}

	/**
	 * Moves the cohort of the top level item to the database with the tag
	 *
	 * the cohort is replicated to the target database, replacing a fraction left there by an interrupted move
	 * then the pointer is created or updated in the target database, the pointer is updated in the source database (and the local database, when it is neither) and the cohort is deleted from the source database
	 * pointers referenced by the cohort which the target database does not know are copied along
	 *
	 * rows are copied as they are stored, without audits
	 */
	async move<TModel extends ExposedModel<TContext>>(item: TModel, target: string): Promise<void> {
		this.requireExposed(item.constructor);

		const pointerSetName = this.pointerSetNames.get(item.constructor);

		if (!pointerSetName) {
			throw new Error(`'${item.constructor.name}' is not a top level entity, only cohorts can be moved`);
		}

		const targetInstance = this.instance(target);
		const sourceInstance = await this.pointerInstance(pointerSetName, item.id);

		if (!sourceInstance) {
			throw new Error(`No pointer '${item.id}' found for '${item.constructor.name}' in database '${this.tag}'`);
		}

		if (sourceInstance == targetInstance) {
			return;
		}

		const tables = this.cohortTables(item.constructor);

		const { cohort, pointers } = await sourceInstance.use(async context => {
			const cohort = await this.collectCohort(context, tables, item.id);

			return { cohort, pointers: await this.collectReferencedPointers(context, tables, cohort) };
		});

		await targetInstance.use(async context => {
			// an interrupted move may have left a fraction of the cohort
			await this.deleteCohort(context, tables, await this.collectCohort(context, tables, item.id));

			for (let [source, rows] of pointers) {
				await context.$$query(`INSERT INTO ${identifier(source)} SELECT * FROM json_populate_recordset(NULL::${identifier(source)}, $1::json) ON CONFLICT (id) DO NOTHING`, [jsonArray(rows)]);
			}

			for (let table of [...tables].reverse()) {
				const rows = cohort.get(table)!;

				if (rows.size) {
					await context.$$query(`INSERT INTO ${identifier(table.source)} SELECT * FROM json_populate_recordset(NULL::${identifier(table.source)}, $1::json)`, [jsonArray(rows.values())]);
				}
			}

			await this.setPointer(context, pointerSetName, item.id, target, true);
		});

		await sourceInstance.use(context => this.setPointer(context, pointerSetName, item.id, target));

		// pointers are looked up in the local database
		if (this.local != sourceInstance && this.local != targetInstance) {
			await this.local.use(context => this.setPointer(context, pointerSetName, item.id, target));
		}

		await sourceInstance.use(context => this.deleteCohort(context, tables, cohort));
	}

	createDuplicate<TModel extends ExposedModel<TContext>>(item: TModel): TModel {
		this.requireExposed(item.constructor);

		return this.schema.createDuplicate(item);
	}

	/**
	 * Loads the referenced entity
	 *
	 * a reference to a pointer loads the entity it points to from the targeted database, other references load from the local database
	 */
	async fetch<TModel extends Entity<QueryProxy>>(reference: Partial<ForeignReference<TModel>>): Promise<PointedModel<TContext, TModel>> {
		const stored = (reference as unknown as { $stored: unknown }).$stored;

		if (reference.$relation && this.pointedSetNames.has(reference.$relation)) {
			const pointedType = this.set(this.schema, this.pointedSetNames.get(reference.$relation)!).modelConstructor;

			// included pointers have already been replaced by the entity they point to
			if (reference.hasPrefetched && stored instanceof pointedType) {
				return stored as PointedModel<TContext, TModel>;
			}

			return this.fetchPointed(reference as ForeignReference<TModel>);
		}

		if (reference.hasPrefetched) {
			return stored as PointedModel<TContext, TModel>;
		}

		if (reference.id === null || reference.id === undefined) {
			return null as PointedModel<TContext, TModel>;
		}

		return this.remember(await this.local.use(context => context.fetch(reference)), this.local) as PointedModel<TContext, TModel>;
	}

	/**
	 * Query of all entities referencing the item, in the databases named by its terminal method (`related(chat.messages).toArrayLocal()`)
	 *
	 * @param reference primary reference of the item (`chat.messages`)
	 */
	related<TModel extends ExposedModel<TContext> & Entity<TQueryProxy>, TQueryProxy extends QueryProxy>(reference: PrimaryReference<TModel, TQueryProxy>): ScopedQueryable<TModel, TQueryProxy> {
		this.requireExposed(reference.$relation);

		return new RoutedQuery<TModel, TQueryProxy>(reference.$relation, scope => this.scopeInstances(scope), context => context.related(reference), this.queryHooks(reference.$relation));
	}

	/**
	 * Databases a query with the scope reads, the local database first
	 */
	private scopeInstances(scope: QueryScope): DatabaseInstance<TContext>[] {
		const remotes = [...this.remotes.values()];

		switch (scope) {
			case 'local': return [this.local];
			case 'remote': return remotes;
			case 'all': return [this.local, ...remotes];
		}

		throw new Error(`Unknown query scope '${scope}'`);
	}

	private queryHooks(type: Function): RoutedQueryHooks<any> {
		return {
			prepareTree: tree => this.prepareTree(type, tree),
			resolve: (items, tree, instance) => this.resolveIncludedPointers(items, tree, instance as DatabaseInstance<TContext>)
		};
	}

	/**
	 * Loads missing referenced data defined in the tree
	 *
	 * references to pointers load the entity they point to from the targeted database, the subtree applies to that entity
	 * other references load from the database the item has been loaded from
	 *
	 * @param pointerId id of the top level entity of the cohort, only required for items not loaded through this database which are not top level entities
	 */
	async backload(item: ExposedModel<TContext>, tree: any, pointerId?: string | number): Promise<void> {
		this.requireExposed(item.constructor);

		const instance = await this.itemInstance(item, pointerId);

		const localTree: Record<string, any> = {};
		const tasks: Promise<void>[] = [];

		for (let property in tree) {
			const reference = item[property as keyof typeof item];

			if (reference instanceof ForeignReference && reference.$relation && this.pointedSetNames.has(reference.$relation)) {
				const pointedType = this.set(this.schema, this.pointedSetNames.get(reference.$relation)!).modelConstructor;
				const stored = reference as unknown as { $stored: unknown, $fetched: boolean };

				// an included pointer is replaced by the entity it points to
				if (!(stored.$stored instanceof pointedType)) {
					tasks.push(this.fetchPointed(reference, tree[property]).then(pointed => {
						stored.$stored = pointed;
						stored.$fetched = true;
					}));
				}
			} else {
				if (reference instanceof ForeignReference || reference instanceof PrimaryReference) {
					this.requireExposed(reference.$relation);

					localTree[property] = typeof tree[property] == 'object' ? this.prepareTree(reference.$relation!, tree[property]) : tree[property];
				} else {
					localTree[property] = tree[property];
				}
			}
		}

		tasks.push(instance.use(context => context.backload(item, localTree)));

		await Promise.all(tasks);
		await this.resolveIncludedPointers([item], tree, instance);
	}

	/**
	 * Replaces the subtrees of pointer references with the pointer columns, so vlquery includes the pointers
	 *
	 * the subtree is applied to the entity which replaces the pointer once loaded
	 */
	private prepareTree(type: Function, tree: any) {
		const model = new (type as new () => Entity<QueryProxy>)();
		const prepared: Record<string, any> = {};

		for (let property in tree) {
			const reference = model[property as keyof typeof model];

			if (reference instanceof ForeignReference && reference.$relation && this.pointedSetNames.has(reference.$relation)) {
				prepared[property] = { id: true, target: true };
			} else if ((reference instanceof ForeignReference || reference instanceof PrimaryReference) && reference.$relation && typeof tree[property] == 'object') {
				prepared[property] = this.prepareTree(reference.$relation, tree[property]);
			} else {
				prepared[property] = tree[property];
			}
		}

		return prepared;
	}

	/**
	 * Replaces included pointers with the entities they point to, loaded from the databases the pointers target
	 *
	 * the subtree of a pointer reference in the tree is included in the entity replacing it
	 * every entity reached is remembered with the database it has been loaded from
	 *
	 * @param instance database the items have been loaded from, the included pointers are followed from there
	 */
	private async resolveIncludedPointers(items: unknown[], tree: any, instance: DatabaseInstance<TContext>) {
		const loads = new Map<string, Promise<[unknown, DatabaseInstance<TContext> | null]>>();
		const visited = new Set<object>();

		const visit = async (item: unknown, tree: any, origin: DatabaseInstance<TContext>): Promise<void> => {
			if (!(item instanceof Entity) || visited.has(item)) {
				return;
			}

			visited.add(item);

			// entities loaded before, like the ones backload replaced pointers with, keep their database
			origin = this.origins.get(item) ?? origin;
			this.origins.set(item, origin);

			const tasks: Promise<void>[] = [];

			for (let key in item) {
				const reference = item[key as keyof typeof item];
				const stored = reference as unknown as { $stored: unknown };

				// foreign references are stored in a '$' prefixed property
				const subtree = typeof tree?.[key.replace(/^\$/, '')] == 'object' ? tree[key.replace(/^\$/, '')] : undefined;

				if (reference instanceof ForeignReference) {
					const pointedSetName = reference.$relation && this.pointedSetNames.get(reference.$relation);

					if (pointedSetName && stored.$stored instanceof reference.$relation!) {
						const pointer = stored.$stored as Entity<QueryProxy> & { target: string };
						const load = `${origin.tag}:${pointedSetName}:${pointer.id}:${JSON.stringify(subtree ?? {})}`;

						if (!loads.has(load)) {
							loads.set(load, this.followPointer(this.setNames.get(reference.$relation!)!, pointer.id, pointer.target, origin).then(async instance => [
								instance && await instance.use(context => this.queryPointed(context, pointedSetName, pointer.id, subtree)),
								instance
							]));
						}

						tasks.push(loads.get(load)!.then(([pointed, instance]) => {
							stored.$stored = pointed;

							// pointers included in the pointed entity have been loaded from its database
							return instance ? visit(pointed, subtree, instance) : undefined;
						}));
					} else {
						tasks.push(visit(stored.$stored, subtree, origin));
					}
				} else if (reference instanceof PrimaryReference) {
					for (let child of (stored.$stored as unknown[] | undefined) ?? []) {
						tasks.push(visit(child, subtree, origin));
					}
				}
			}

			await Promise.all(tasks);
		};

		await Promise.all(items.map(item => visit(item, tree, instance)));
	}

	private async find(type: Function, pointerId: string | number, id: string | number) {
		const instance = await this.cohortInstance(type, pointerId);

		if (!instance) {
			return null;
		}

		return this.remember(await instance.use(context => this.set(context, this.setNames.get(type)!).find(id)), instance);
	}

	/**
	 * Remembers the database the entity is stored in
	 */
	private remember<TItem>(item: TItem, instance: DatabaseInstance<TContext>) {
		if (item instanceof Entity) {
			this.origins.set(item, instance);
		}

		return item;
	}

	/**
	 * Database the item is stored in
	 *
	 * the local database if the item is not part of a cohort, otherwise the database the pointer targets, the item has been loaded from or the pointer of a top level item targets
	 *
	 * @param pointerId id of the top level entity of the cohort, overrides the database the item has been loaded from
	 */
	private async itemInstance(item: Entity<QueryProxy>, pointerId?: string | number) {
		const type = item.constructor;

		if (!this.cohortPointerSetNames.get(type)?.length) {
			return this.local;
		}

		if (pointerId !== undefined) {
			return this.requireCohortInstance(type, pointerId);
		}

		const origin = this.origins.get(item);

		if (origin) {
			return origin;
		}

		if (this.pointerSetNames.has(type)) {
			return this.requireCohortInstance(type, item.id);
		}

		throw new Error(`'${type.name}' '${item.id}' has not been loaded through database '${this.tag}', the pointer id of its cohort is required`);
	}

	/**
	 * Loads the entity a pointer reference points to from the database the pointer targets
	 */
	private async fetchPointed(reference: ForeignReference<Entity<QueryProxy>>, tree?: any) {
		const id = reference.id;

		if (id === null || id === undefined) {
			return null;
		}

		const pointedSetName = this.pointedSetNames.get(reference.$relation!)!;
		const instance = await this.pointerInstance(this.setNames.get(reference.$relation!)!, id);

		if (!instance) {
			return null;
		}

		const pointed = await instance.use(context => this.queryPointed(context, pointedSetName, id, tree));
		await this.resolveIncludedPointers([pointed], tree, instance);

		return pointed;
	}

	private queryPointed(context: DatabaseContext, pointedSetName: string, id: string | number, tree?: any) {
		const set = this.set(context, pointedSetName);
		let query = set.toQuery();

		// vlquery finds nothing with an empty tree
		if (tree && Object.keys(tree).length) {
			query = query.includeTree(this.prepareTree(set.modelConstructor, tree));
		}

		return query.first(byId(id));
	}

	/**
	 * Database the pointer of the cohort of the type targets, the local database if the type is not part of a cohort
	 */
	private async cohortInstance(type: Function, pointerId: string | number) {
		const pointerSetNames = this.cohortPointerSetNames.get(type) ?? [];

		if (!pointerSetNames.length) {
			return this.local;
		}

		for (let pointerSetName of pointerSetNames) {
			const instance = await this.pointerInstance(pointerSetName, pointerId);

			if (instance) {
				return instance;
			}
		}

		return null;
	}

	private async requireCohortInstance(type: Function, pointerId: string | number) {
		const instance = await this.cohortInstance(type, pointerId);

		if (!instance) {
			throw new Error(`No pointer '${pointerId}' found for '${type.name}' in database '${this.tag}'`);
		}

		return instance;
	}

	/**
	 * Database the pointer leads to, pointers are looked up in the local database
	 */
	private async pointerInstance(pointerSetName: string, pointerId: string | number) {
		const pointer: { target: string } = await this.local.use(context => this.set(context, pointerSetName).find(pointerId));

		return pointer ? this.followPointer(pointerSetName, pointerId, pointer.target, this.local) : null;
	}

	/**
	 * Database the cohort is stored in, the pointer is followed through the pointers of the databases it targets until one targets itself
	 *
	 * a move only updates the pointers of the databases it involves, so other databases may still target the database the cohort left (EU → US → AP)
	 * when the path is longer than one, the pointer in the origin database is updated to target the database the cohort is stored in (EU → AP)
	 *
	 * a deleted cohort takes its pointer along, when the path ends in a database without the pointer, the pointer in the origin database is deleted as well
	 *
	 * @param target target of the pointer in the origin database
	 * @param origin database the pointer has been read from
	 * @returns null if the cohort has been deleted
	 */
	private async followPointer(pointerSetName: string, pointerId: string | number, target: string, origin: DatabaseInstance<TContext>) {
		const path = [origin.tag];
		let instance = origin;

		while (target != instance.tag) {
			if (path.includes(target)) {
				throw new Error(`Pointer '${pointerId}' in '${pointerSetName}' runs in a circle (${[...path, target].join(' → ')})`);
			}

			path.push(target);
			instance = this.instance(target);

			const pointer: { target: string } | null = await instance.use(context => this.set(context, pointerSetName).find(pointerId));

			if (!pointer) {
				await origin.use(context => this.deletePointer(context, pointerSetName, pointerId));

				return null;
			}

			target = pointer.target;
		}

		if (path.length > 2) {
			await origin.use(context => this.setPointer(context, pointerSetName, pointerId, instance.tag));
		}

		return instance;
	}

	/**
	 * Tables of the cohort of the top level type, every table after the tables referencing it (children first)
	 *
	 * the children of a table are the tables referencing it, except for pointers and top level tables
	 */
	private cohortTables(type: Function) {
		const tables = new Map<Function, CohortTable>();
		const ordered: CohortTable[] = [];

		const visit = (type: Function) => {
			if (tables.has(type)) {
				return tables.get(type)!;
			}

			const model = new (type as new () => Entity<QueryProxy>)();
			const table: CohortTable = { source: model.$$meta.source, children: [], pointerColumns: [] };

			tables.set(type, table);

			for (let key in model) {
				const reference = model[key as keyof typeof model];

				if (reference instanceof PrimaryReference && !this.isPointer(reference.$relation) && !this.pointerSetNames.has(reference.$relation)) {
					const child = visit(reference.$relation);

					table.children.push({ table: child, column: new reference.$relation().$$meta.columns[reference.$column].name });
				} else if (reference instanceof ForeignReference && reference.$relation && this.isPointer(reference.$relation)) {
					table.pointerColumns.push({ source: new reference.$relation().$$meta.source, column: model.$$meta.columns[reference.$column!].name });
				}
			}

			ordered.push(table);

			return table;
		};

		visit(type);

		return ordered;
	}

	/**
	 * Rows of the cohort, by their id, read as json so they can be inserted into another database as they are
	 *
	 * starts at the top level row and follows the references of the children until no new rows are found
	 */
	private async collectCohort(context: DatabaseContext, tables: CohortTable[], pointerId: string | number) {
		const cohort = new Map<CohortTable, Map<string, string>>(tables.map(table => [table, new Map()]));
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

		const queue: [CohortTable, string[]][] = [[root, add(root, await context.$$query(`SELECT t.id::text, row_to_json(t)::text FROM ${identifier(root.source)} t WHERE t.id = $1`, [pointerId]))]];

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
	}

	/**
	 * Rows of the pointers referenced by the cohort, by the table of the pointer
	 */
	private async collectReferencedPointers(context: DatabaseContext, tables: CohortTable[], cohort: Map<CohortTable, Map<string, string>>) {
		const pointers = new Map<string, Set<string>>();

		for (let table of tables) {
			const rows = cohort.get(table)!;

			if (rows.size) {
				for (let { source, column } of table.pointerColumns) {
					const found: [string][] = await context.$$query(`SELECT row_to_json(p)::text FROM ${identifier(source)} p WHERE p.id IN (SELECT ${identifier(column)} FROM json_populate_recordset(NULL::${identifier(table.source)}, $1::json))`, [jsonArray(rows.values())]);

					if (!pointers.has(source)) {
						pointers.set(source, new Set());
					}

					for (let [row] of found) {
						pointers.get(source)!.add(row);
					}
				}
			}
		}

		return pointers;
	}

	/**
	 * Deletes the rows of the cohort, children first, pointers are kept
	 */
	private async deleteCohort(context: DatabaseContext, tables: CohortTable[], cohort: Map<CohortTable, Map<string, string>>) {
		for (let table of tables) {
			const rows = cohort.get(table)!;

			if (rows.size) {
				await context.$$query(`DELETE FROM ${identifier(table.source)} WHERE id IN (SELECT id FROM json_populate_recordset(NULL::${identifier(table.source)}, $1::json))`, [jsonArray(rows.values())]);
			}
		}
	}

	/**
	 * Points the pointer to the database with the tag, creates the pointer if it does not exist yet when requested
	 */
	private async setPointer(context: DatabaseContext, pointerSetName: string, pointerId: string | number, target: string, create = false) {
		const meta = this.pointerMeta(pointerSetName);
		const column = identifier(meta.columns.target.name);

		if (create) {
			await context.$$query(`INSERT INTO ${identifier(meta.source)} (id, ${column}) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET ${column} = EXCLUDED.${column}`, [pointerId, target]);
		} else {
			await context.$$query(`UPDATE ${identifier(meta.source)} SET ${column} = $2 WHERE id = $1`, [pointerId, target]);
		}
	}

	/**
	 * Inserts a new pointer targeting the local database, returns the id generated for it
	 *
	 * pointers are written without audits, they are internal and audits may require a comment
	 */
	private async insertPointer(context: DatabaseContext, pointerSetName: string): Promise<string | number> {
		const meta = this.pointerMeta(pointerSetName);
		const [[id]] = await context.$$query(`INSERT INTO ${identifier(meta.source)} (${identifier(meta.columns.target.name)}) VALUES ($1) RETURNING id`, [this.tag]);

		return id;
	}

	/**
	 * Creates the pointer of the top level item, targeting the local database, in the databases storing the cohorts the item references through their pointers
	 *
	 * a chat between an eu and a us account is created in eu, the us database gets a pointer to it as well
	 */
	private async createReferencingPointers(item: Entity<QueryProxy>, pointerSetName: string) {
		const instances = new Set<DatabaseInstance<TContext>>();

		for (let key in item) {
			const reference = item[key as keyof typeof item];

			if (reference instanceof ForeignReference && reference.$relation && this.isPointer(reference.$relation) && reference.id !== null && reference.id !== undefined) {
				const instance = await this.pointerInstance(this.setNames.get(reference.$relation)!, reference.id);

				// a deleted cohort has no database to inform
				if (instance && instance != this.local) {
					instances.add(instance);
				}
			}
		}

		await Promise.all([...instances].map(instance => instance.use(context => this.setPointer(context, pointerSetName, item.id, this.tag, true))));
	}

	/**
	 * Deletes the pointer, unless it is still referenced
	 */
	private async deletePointer(context: DatabaseContext, pointerSetName: string, pointerId: string | number) {
		const meta = this.pointerMeta(pointerSetName);

		try {
			await context.$$query(`DELETE FROM ${identifier(meta.source)} WHERE id = $1`, [pointerId]);
		} catch (error) {
			// rows of other cohorts referencing the pointer keep it alive
			if ((error as { code?: string }).code != foreignKeyViolation) {
				throw error;
			}
		}
	}

	private instance(tag: string) {
		if (tag == this.tag) {
			return this.local;
		}

		const remote = this.remotes.get(tag);

		if (!remote) {
			throw new Error(`No database with tag '${tag}' configured`);
		}

		return remote;
	}

	private pointerMeta(pointerSetName: string) {
		return new (this.set(this.schema, pointerSetName).modelConstructor)().$$meta as Entity<QueryProxy>['$$meta'];
	}

	private set(context: DatabaseContext, name: string) {
		return context[name as keyof DatabaseContext] as unknown as DbSet<any, any>;
	}

	/**
	 * Exposes the set methods, bound instead of exposing the set itself, so the context can not be reached through it
	 */
	private exposeSet(find: Function, set: () => RoutedQuery<any, any> | ViewSet<any, any>, methods: readonly string[]) {
		const exposed: Record<string, Function> = { find };

		for (let method of methods) {
			if (method != 'find') {
				exposed[method] = (...args: any[]) => {
					const target = set();

					return (target[method as keyof typeof target] as Function).apply(target, args);
				};
			}
		}

		return Object.freeze(exposed);
	}

	private isPointer(type: Function) {
		return isPointer(type);
	}

	private requireExposed(type: Function | undefined) {
		if (type && this.isPointer(type)) {
			throw new Error(`'${type.name}' is not exposed by database '${this.tag}'`);
		}
	}
}

/**
 * Splits the arguments of an operation taking an optional pointer id before the item
 */
const splitItemArguments = <TModel>(args: [TModel, string?] | [string | number, TModel, string?]) => (args[0] instanceof Entity ? [undefined, args[0], args[1]] : args) as [string | number | undefined, TModel, string?];

/**
 * Compiled query matching the id, the same vlquery uses for find
 */
const byId = (id: string | number) => ({ compare: { left: { path: ['id'] }, right: { value: id }, operator: '=' } }) as any;

/**
 * Creates the item with the given id, vlquery always lets the database generate it
 *
 * only the insert of the item gets the id, not the audit created along
 */
const createWithId = <TModel extends Entity<QueryProxy>>(context: DatabaseContext, item: TModel, id: string | number, comment?: string) => {
	delete (item as Partial<Entity<QueryProxy>>).id;

	let injected = false;

	const shadow: DatabaseContext = Object.create(context, {
		$$query: {
			value: (sql: string, params: any[]) => {
				if (!injected) {
					injected = true;

					sql = sql.replace('VALUES (DEFAULT', `VALUES ($${params.length + 1}`);
					params = [...params, id];
				}

				return context.$$query(sql, params);
			}
		}
	});

	return shadow.create(item, comment);
};

/**
 * Table of a cohort, with the tables referencing it and its references to pointers
 */
type CohortTable = {
	source: string;
	children: { table: CohortTable, column: string }[];
	pointerColumns: { source: string, column: string }[];
};

/**
 * Quoted identifier, the same vlquery uses for table names
 */
const identifier = (name: string) => JSON.stringify(name);

/**
 * Json array of rows already serialized by the database, so their values never pass through javascript numbers
 */
const jsonArray = (rows: Iterable<string>) => `[${[...rows].join(',')}]`;
