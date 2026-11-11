import { DatabaseContext, DbClient, DbSet, Entity, ForeignReference, PrimaryReference, QueryProxy, Queryable, ViewSet } from 'vlquery';
import { DatabaseConfiguration } from '../types/database-configuration';
import { DatabaseInstance } from './instance';
import { RoutedQuery, RoutedQueryHooks } from './routed-query';

/**
 * Suffix of entity classes that are kept internal
 */
const pointerSuffix = '_Pointer';

/**
 * Milliseconds a remote connection stays open after its last use
 */
const defaultRemoteIdleTimeout = 60 * 1000;

/**
 * Methods exposed on a set, everything else (like the context) stays hidden
 */
const setMethods = [
	'find',
	'toQuery',
	'where',
	'first',
	'single',
	'toArray',
	'count',
	'include',
	'includeTree',
	'orderByAscending',
	'orderByDescending',
	'skip',
	'limit',
	'page'
] as const;

/**
 * Names of the sets which are not pointers
 *
 * the generator names sets after their tables, just like their entity classes, so they share the '_Pointer' suffix
 */
export type ExposedSetName<TContext> = {
	[Key in keyof TContext]: Key extends `${string}${typeof pointerSuffix}` ? never : TContext[Key] extends DbSet<any, any> ? Key : never
}[keyof TContext] & string;

/**
 * Set reduced to its public methods, find is located by the pointer of the cohort
 */
export type ExposedSet<TSet> = Omit<ExposedView<TSet>, 'find'> & {
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
export type ExposedView<TSet> = Pick<TSet, typeof setMethods[number] & keyof TSet>;

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
 * queries only read the local database
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

	private readonly setNames = new Map<Function, string>();

	/**
	 * Top level type to the name of its pointer set
	 */
	private readonly pointerSetNames = new Map<Function, string>();

	/**
	 * Pointer type to the name of the set it points to
	 */
	private readonly pointedSetNames = new Map<Function, string>();

	/**
	 * Type to the names of the pointer sets of the cohorts it belongs to
	 */
	private readonly cohortPointerSetNames = new Map<Function, string[]>();

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

		for (let name in this.schema) {
			const set = this.schema[name];

			if (set instanceof DbSet) {
				this.setNames.set(set.modelConstructor, name);
			}
		}

		for (let [type, name] of this.setNames) {
			if (name.endsWith(pointerSuffix)) {
				const pointedName = name.substring(0, name.length - pointerSuffix.length);
				const pointedSet = this.schema[pointedName as keyof TContext];

				if (pointedSet instanceof DbSet) {
					this.pointerSetNames.set(pointedSet.modelConstructor, name);
					this.pointedSetNames.set(type, pointedName);
				}
			}
		}

		const sets: Record<string, object> = {};

		for (let [type, name] of this.setNames) {
			if (!this.isPointer(type)) {
				this.cohortPointerSetNames.set(type, this.findCohortPointerSetNames(type, new Set()));

				// queries only read the local database
				sets[name] = this.exposeSet(
					(pointerId: string | number, id = pointerId) => this.find(type, pointerId, id),
					() => new RoutedQuery(async () => this.local, context => this.set(context, name).toQuery(), this.queryHooks(type))
				);
			}
		}

		this.sets = Object.freeze(sets) as ExposedSets<TContext>;

		const views: Record<string, object> = {};
		const schemaViews = (this.schema as { views?: Record<string, ViewSet<any, any>> }).views ?? {};

		for (let name in schemaViews) {
			const view = () => (this.local.context as unknown as { views: Record<string, ViewSet<any, any>> }).views[name];

			views[name] = this.exposeSet((id: string | number) => view().find(id), view);
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
	 */
	async create<TModel extends ExposedModel<TContext>>(item: TModel, comment?: string): Promise<TModel>;

	/**
	 * Creates the item in the database the pointer of its cohort targets
	 *
	 * @param pointerId id of the top level entity of the cohort (`create(chatId, message)`)
	 */
	async create<TModel extends ExposedModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<TModel>;

	async create<TModel extends ExposedModel<TContext>>(...args: [TModel, string?] | [string | number, TModel, string?]): Promise<TModel> {
		const [pointerId, item, comment] = args[0] instanceof Entity ? [undefined, args[0], args[1] as string | undefined] : args as [string | number, TModel, string?];

		this.requireExposed(item.constructor);

		const pointerSetName = this.pointerSetNames.get(item.constructor);

		if (pointerSetName) {
			// top level items are always created in the local database
			if (pointerId !== undefined) {
				throw new Error(`'${item.constructor.name}' is a top level entity and can only be created in database '${this.tag}'`);
			}

			return this.local.use(async context => {
				const pointer = this.createPointer(pointerSetName);
				await context.create(pointer);

				return createWithId(context, item, pointer.id, comment);
			});
		}

		if (this.cohortPointerSetNames.get(item.constructor)?.length) {
			if (pointerId === undefined) {
				throw new Error(`'${item.constructor.name}' is part of a cohort, the pointer id is required to create it`);
			}

			const instance = await this.requireCohortInstance(item.constructor, pointerId);

			return instance.use(context => context.create(item, comment));
		}

		return this.local.use(context => context.create(item, comment));
	}

	/**
	 * Updates the item in the database the pointer of its cohort targets
	 */
	async update<TModel extends ExposedModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<TModel> {
		this.requireExposed(item.constructor);

		const instance = await this.requireCohortInstance(item.constructor, pointerId);

		return instance.use(context => context.update(item, comment));
	}

	/**
	 * Deletes the item from the database the pointer of its cohort targets
	 *
	 * a top level item takes its pointer in that database along, pointers in other databases are left as they are
	 */
	async delete<TModel extends ExposedModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<void> {
		this.requireExposed(item.constructor);

		const instance = await this.requireCohortInstance(item.constructor, pointerId);
		const pointerSetName = this.pointerSetNames.get(item.constructor);

		await instance.use(async context => {
			await context.delete(item, comment);

			if (pointerSetName) {
				const pointer = this.createPointer(pointerSetName);
				pointer.id = item.id;

				await context.delete(pointer);
			}
		});
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
		if (reference.$relation && this.pointedSetNames.has(reference.$relation)) {
			const pointedType = this.set(this.schema, this.pointedSetNames.get(reference.$relation)!).modelConstructor;
			const stored = (reference as unknown as { $stored: unknown }).$stored;

			// included pointers have already been replaced by the entity they point to
			if (reference.hasPrefetched && stored instanceof pointedType) {
				return stored as PointedModel<TContext, TModel>;
			}

			return this.fetchPointed(reference as ForeignReference<TModel>);
		}

		return this.local.use(context => context.fetch(reference)) as Promise<PointedModel<TContext, TModel>>;
	}

	/**
	 * Query of all entities referencing the item, in the database the pointer of the cohort of the item targets
	 *
	 * @param reference primary reference of the item (`chat.messages`)
	 * @param pointerId id of the top level entity of the cohort (`related(message.pictures, chatId)`), defaults to the id of the item for top level entities (`related(chat.messages)`)
	 */
	related<TModel extends ExposedModel<TContext> & Entity<TQueryProxy>, TQueryProxy extends QueryProxy>(reference: PrimaryReference<TModel, TQueryProxy>, pointerId?: string | number): Queryable<TModel, TQueryProxy> {
		this.requireExposed(reference.$relation);

		const item = reference.$$item;

		return new RoutedQuery<TModel, TQueryProxy>(() => this.requireCohortInstance(item.constructor, pointerId ?? item.id), context => context.related(reference), this.queryHooks(reference.$relation));
	}

	private queryHooks(type: Function): RoutedQueryHooks<any> {
		return {
			prepareTree: tree => this.prepareTree(type, tree),
			resolve: (items, tree) => this.resolveIncludedPointers(items, tree)
		};
	}

	/**
	 * Loads missing referenced data defined in the tree
	 *
	 * references to pointers load the entity they point to from the targeted database, the subtree applies to that entity
	 */
	async backload(item: ExposedModel<TContext>, tree: any): Promise<void> {
		this.requireExposed(item.constructor);

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

		tasks.push(this.local.use(context => context.backload(item, localTree)));

		await Promise.all(tasks);
		await this.resolveIncludedPointers([item], tree);
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
	 */
	private async resolveIncludedPointers(items: unknown[], tree?: any) {
		const loads = new Map<string, Promise<unknown>>();
		const visited = new Set<object>();

		const visit = async (item: unknown, tree: any): Promise<void> => {
			if (!(item instanceof Entity) || visited.has(item)) {
				return;
			}

			visited.add(item);

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
						const load = `${pointedSetName}:${pointer.id}:${JSON.stringify(subtree ?? {})}`;

						if (!loads.has(load)) {
							loads.set(load, this.instance(pointer.target).use(context => this.queryPointed(context, pointedSetName, pointer.id, subtree)));
						}

						tasks.push(loads.get(load)!.then(pointed => {
							stored.$stored = pointed;

							return visit(pointed, subtree);
						}));
					} else {
						tasks.push(visit(stored.$stored, subtree));
					}
				} else if (reference instanceof PrimaryReference) {
					for (let child of (stored.$stored as unknown[] | undefined) ?? []) {
						tasks.push(visit(child, subtree));
					}
				}
			}

			await Promise.all(tasks);
		};

		await Promise.all(items.map(item => visit(item, tree)));
	}

	private async find(type: Function, pointerId: string | number, id: string | number) {
		const instance = await this.cohortInstance(type, pointerId);

		if (!instance) {
			return null;
		}

		return instance.use(context => this.set(context, this.setNames.get(type)!).find(id));
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
		await this.resolveIncludedPointers([pointed], tree);

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
	 * Database the pointer targets, pointers are looked up in the local database
	 */
	private async pointerInstance(pointerSetName: string, pointerId: string | number) {
		const pointer: { target: string } = await this.local.use(context => this.set(context, pointerSetName).find(pointerId));

		return pointer ? this.instance(pointer.target) : null;
	}

	/**
	 * Pointer sets of the top level types the type references, directly or through other entities
	 */
	private findCohortPointerSetNames(type: Function, visited: Set<Function>): string[] {
		const pointerSetName = this.pointerSetNames.get(type);

		if (pointerSetName) {
			return [pointerSetName];
		}

		if (visited.has(type)) {
			return [];
		}

		visited.add(type);

		const names = new Set<string>();
		const model = new (type as new () => Entity<QueryProxy>)();

		for (let key in model) {
			const reference = model[key as keyof typeof model];

			// a reference to a pointer leads into another cohort
			if (reference instanceof ForeignReference && reference.$relation && !this.isPointer(reference.$relation)) {
				for (let name of this.findCohortPointerSetNames(reference.$relation, visited)) {
					names.add(name);
				}
			}
		}

		return [...names];
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

	private createPointer(pointerSetName: string) {
		const pointer = new (this.set(this.schema, pointerSetName).modelConstructor)() as Entity<QueryProxy> & { target: string };
		pointer.target = this.tag;

		return pointer;
	}

	private set(context: DatabaseContext, name: string) {
		return context[name as keyof DatabaseContext] as unknown as DbSet<any, any>;
	}

	/**
	 * Exposes the set methods, bound instead of exposing the set itself, so the context can not be reached through it
	 */
	private exposeSet(find: Function, set: () => RoutedQuery<any, any> | ViewSet<any, any>) {
		const exposed: Record<string, Function> = { find };

		for (let method of setMethods) {
			if (method != 'find') {
				exposed[method] = (...args: any[]) => {
					const target = set();

					return (target[method] as Function).apply(target, args);
				};
			}
		}

		return Object.freeze(exposed);
	}

	private isPointer(type: Function) {
		return type.name.endsWith(pointerSuffix);
	}

	private requireExposed(type: Function | undefined) {
		if (type && this.isPointer(type)) {
			throw new Error(`'${type.name}' is not exposed by database '${this.tag}'`);
		}
	}
}

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
