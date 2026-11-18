import { DatabaseContext, DbClient, DbSet, Entity, ForeignReference, PrimaryReference, QueryProxy, ViewSet } from 'vlquery';
import { MemberSet, RootSet } from '../structure';
import { DatabaseConfiguration } from '../types/database-configuration';
import { collectCohort, collectReferencedPointers, deleteCohort, insertCohort } from './cohort-rows';
import { Cohort, Cohorts } from './cohorts';
import { DatabaseInstance } from './instance';
import { Pointers } from './pointers';
import { References } from './references';
import { LocalQueryable, QueryScope, QueryTarget, RoutedQuery, RoutedQueryHooks, ScopedQueryable, chainMethods, localMethods, scopedMethods } from './routed-query';

export { LocalQueryable, QueryScope, ScopedQueryable } from './routed-query';

/**
 * Milliseconds a remote connection stays open after its last use
 */
const defaultRemoteIdleTimeout = 60 * 1000;

/**
 * Methods exposed on a view, views only read the local database
 */
const viewMethods = ['find', 'toQuery', ...chainMethods, 'first', 'single', 'toArray', 'count'] as const;

/**
 * Names of the sets of the context
 */
export type SetName<TContext> = {
	[Key in keyof TContext]: TContext[Key] extends DbSet<any, any> ? Key : never
}[keyof TContext] & string;

/**
 * Set of a top level table, terminal methods name the databases they read, find is located by the pointer of the entity
 */
export type ExposedRootSet<TModel extends Entity<TQueryProxy>, TQueryProxy extends QueryProxy> = ScopedQueryable<TModel, TQueryProxy> & {
	toQuery(): ScopedQueryable<TModel, TQueryProxy>;

	/**
	 * Loads the entity from the database its pointer targets
	 */
	find(id: string | number): Promise<TModel>;
};

/**
 * Set of a table of a cohort below its top level table, queries read the local database, find is located by the pointer of the cohort
 */
export type ExposedMemberSet<TModel extends Entity<TQueryProxy>, TQueryProxy extends QueryProxy> = LocalQueryable<TModel, TQueryProxy> & {
	toQuery(): LocalQueryable<TModel, TQueryProxy>;

	/**
	 * Loads the entity from the database the pointer of its cohort targets
	 *
	 * @param pointerId id of the top level entity of the cohort (`message.find(chatId, messageId)`)
	 */
	find(pointerId: string | number, id: string | number): Promise<TModel>;
};

/**
 * Set of a table which is not part of a cohort, its rows are stored in the local database
 */
export type ExposedLocalSet<TModel extends Entity<TQueryProxy>, TQueryProxy extends QueryProxy> = LocalQueryable<TModel, TQueryProxy> & {
	toQuery(): LocalQueryable<TModel, TQueryProxy>;
	find(id: string | number): Promise<TModel>;
};

export type ExposedSet<TSet> = TSet extends RootSet<infer TModel, infer TQueryProxy> ? ExposedRootSet<TModel, TQueryProxy>
	: TSet extends MemberSet<infer TModel, infer TQueryProxy> ? ExposedMemberSet<TModel, TQueryProxy>
	: TSet extends DbSet<infer TModel, infer TQueryProxy> ? ExposedLocalSet<TModel, TQueryProxy>
	: never;

/**
 * View reduced to its public methods
 */
export type ExposedView<TSet> = Pick<TSet, typeof viewMethods[number] & keyof TSet>;

export type ExposedSets<TContext> = { readonly [Name in SetName<TContext>]: ExposedSet<TContext[Name]> };
export type ExposedViews<TContext> = TContext extends { views: infer TViews } ? { readonly [Name in keyof TViews]: ExposedView<TViews[Name]> } : {};

/**
 * Model of a set, distributes over unions of sets
 */
export type ModelOf<TSet> = TSet extends DbSet<infer TModel, any> ? TModel : never;

/**
 * Entities of the context
 */
export type ExposedModel<TContext> = ModelOf<TContext[SetName<TContext>]>;

/**
 * Entities of the tables of cohorts below their top level tables
 */
export type MemberModel<TContext> = {
	[Name in SetName<TContext>]: TContext[Name] extends MemberSet<any, any> ? ModelOf<TContext[Name]> : never
}[SetName<TContext>];

/**
 * Single database distributed over multiple locations
 *
 * the top level table of a cohort has a pointer table, which names the database (by its tag) the cohort is stored in
 * the other tables of the cohort reference the top level table, so their rows are stored in the same database
 *
 * queries of top level tables read the local database, the remote databases or all of them, as named by their terminal method (`toArrayLocal`, `toArrayRemote`, `toArrayAll`)
 * queries of other tables read the local database
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

	private readonly cohorts: Cohorts;
	private readonly pointers: Pointers;
	private readonly references: References;

	/**
	 * Database each loaded or written entity is stored in, entities do not remember it themselves
	 */
	private readonly origins = new WeakMap<object, DatabaseInstance<DatabaseContext>>();

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

		this.cohorts = new Cohorts(this.schema, configuration.context.$$cohorts);
		this.pointers = new Pointers(this.local, tag => this.instance(tag));
		this.references = new References(this.cohorts, this.pointers, this.local, this.origins, (context, type) => this.set(context, type));

		const sets: Record<string, object> = {};

		for (let type of this.cohorts.setNames.keys()) {
			const cohort = this.cohorts.cohort(type);
			const query = (route: (scope: QueryScope) => Promise<QueryTarget[]>) => new RoutedQuery(type, route, context => this.set(context, type).toQuery(), this.queryHooks(type));

			if (cohort?.root == type) {
				sets[this.cohorts.setNames.get(type)!] = this.exposeSet(
					(id: string | number) => this.find(type, id, id),
					() => query(scope => this.rootTargets(cohort, scope)),
					scopedMethods
				);
			} else {
				sets[this.cohorts.setNames.get(type)!] = this.exposeSet(
					cohort ? (pointerId: string | number, id: string | number) => this.find(type, pointerId, id) : (id: string | number) => this.find(type, id, id),
					() => query(async () => [{ instance: this.local }]),
					localMethods
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
	async create<TModel extends MemberModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<TModel>;

	async create<TModel extends ExposedModel<TContext>>(...args: [TModel, string?] | [string | number, TModel, string?]): Promise<TModel> {
		const [pointerId, item, comment] = splitItemArguments(args);
		const type = item.constructor;

		this.requireExposed(type);

		const cohort = this.cohorts.cohort(type);

		if (cohort?.root == type) {
			// top level items are always created in the local database
			if (pointerId !== undefined) {
				throw new Error(`'${type.name}' is a top level entity and can only be created in database '${this.tag}'`);
			}

			const created = await this.local.use(async context => createWithId(context, item, await this.pointers.insert(context, cohort, this.tag), comment));
			this.origins.set(created, this.local);

			await this.createReferencingPointers(created, cohort);

			return created;
		}

		if (cohort) {
			if (pointerId === undefined) {
				throw new Error(`'${type.name}' is part of the cohort of '${cohort.root.name}', the pointer id is required to create it`);
			}

			const instance = await this.requireCohortInstance(cohort, pointerId);

			return this.remember(await instance.use(context => context.create(item, comment)), instance);
		}

		if (pointerId !== undefined) {
			throw new Error(`'${type.name}' is not part of a cohort and can only be created in database '${this.tag}'`);
		}

		return this.remember(await this.local.use(context => context.create(item, comment)), this.local);
	}

	/**
	 * Updates the item in the database it is stored in
	 *
	 * a top level item, or an item which is not part of a cohort, does not have to be loaded through this database
	 */
	async update<TModel extends ExposedModel<TContext>>(item: TModel, comment?: string): Promise<TModel>;

	/**
	 * Updates the item in the database the pointer of its cohort targets
	 *
	 * @param pointerId id of the top level entity of the cohort (`update(chatId, message)`)
	 */
	async update<TModel extends MemberModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<TModel>;

	async update<TModel extends ExposedModel<TContext>>(...args: [TModel, string?] | [string | number, TModel, string?]): Promise<TModel> {
		const [pointerId, item, comment] = splitItemArguments(args);

		this.requireExposed(item.constructor);

		const instance = await this.itemInstance(item, pointerId);

		return this.remember(await instance.use(context => context.update(item, comment)), instance);
	}

	/**
	 * Deletes the item from the database it is stored in
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
	async delete<TModel extends MemberModel<TContext>>(pointerId: string | number, item: TModel, comment?: string): Promise<void>;

	async delete<TModel extends ExposedModel<TContext>>(...args: [TModel, string?] | [string | number, TModel, string?]): Promise<void> {
		const [pointerId, item, comment] = splitItemArguments(args);

		this.requireExposed(item.constructor);

		const instance = await this.itemInstance(item, pointerId);
		const cohort = this.cohorts.rootCohort(item.constructor);

		await instance.use(async context => {
			await context.delete(item, comment);

			if (cohort && !item.$$meta.active) {
				await this.pointers.delete(context, cohort, item.id);
			}
		});
	}

	/**
	 * Moves the cohort of the top level item to the database with the tag
	 *
	 * the cohort is replicated to the target database, replacing a fraction left there by an interrupted move
	 * then the pointer is created or updated in the target database, the pointer is updated in the source database and the cohort is deleted from the source database
	 * other databases still target the source database, their pointers are updated once they are followed
	 * pointers referenced by the cohort which the target database does not know are copied along
	 *
	 * rows are copied as they are stored, without audits
	 */
	async move<TModel extends ExposedModel<TContext>>(item: TModel, target: string): Promise<void> {
		this.requireExposed(item.constructor);

		const cohort = this.cohorts.rootCohort(item.constructor);

		if (!cohort) {
			throw new Error(`'${item.constructor.name}' is not a top level entity, only cohorts can be moved`);
		}

		const targetInstance = this.instance(target);
		const sourceInstance = await this.requireCohortInstance(cohort, item.id);

		if (sourceInstance == targetInstance) {
			return;
		}

		const { rows, pointers } = await sourceInstance.use(async context => {
			const rows = await collectCohort(context, cohort.tables, item.id);

			return { rows, pointers: await collectReferencedPointers(context, cohort.tables, rows) };
		});

		await targetInstance.use(async context => {
			// an interrupted move may have left a fraction of the cohort
			await deleteCohort(context, cohort.tables, await collectCohort(context, cohort.tables, item.id));
			await insertCohort(context, cohort.tables, rows, pointers);

			await this.pointers.set(context, cohort, item.id, target, true);
		});

		await sourceInstance.use(async context => {
			await this.pointers.set(context, cohort, item.id, target);
			await deleteCohort(context, cohort.tables, rows);
		});

		this.origins.set(item, targetInstance);
	}

	createDuplicate<TModel extends ExposedModel<TContext>>(item: TModel): TModel {
		this.requireExposed(item.constructor);

		return this.schema.createDuplicate(item);
	}

	/**
	 * Loads the referenced entity
	 *
	 * a reference to a pointer loads the entity it points to from the database the pointer targets
	 * a reference within a cohort loads from the database the cohort is stored in, other references load from the local database
	 */
	async fetch<TModel extends Entity<QueryProxy>>(reference: Partial<ForeignReference<TModel>>): Promise<TModel> {
		if (reference.hasPrefetched) {
			return (reference as unknown as { $stored: TModel }).$stored;
		}

		if (reference.id === null || reference.id === undefined) {
			return null as unknown as TModel;
		}

		const item = reference.$$item!;
		const pointed = this.cohorts.pointedCohort(item.constructor, reference.$column);

		if (pointed) {
			// the database storing the item knows the pointer
			return await this.references.loadPointed(pointed, reference.id, undefined, this.origins.get(item) ?? this.local) as TModel;
		}

		const cohort = this.cohorts.cohort(reference.$relation!);
		let instance: DatabaseInstance<DatabaseContext> = this.local;

		if (cohort) {
			instance = this.origins.get(item) ?? (cohort.root == reference.$relation ? await this.requireCohortInstance(cohort, reference.id) : await this.itemInstance(item));
		}

		return this.remember(await instance.use(context => context.fetch(reference)), instance);
	}

	/**
	 * Query of the entities referencing the item (`related(chat.messages).toArray()`)
	 *
	 * entities of the cohort of the item are read from the database the cohort is stored in
	 * entities referencing the pointer of the item, or which are not part of its cohort, are read from the local database
	 *
	 * @param reference primary reference of the item (`chat.messages`)
	 */
	related<TModel extends ExposedModel<TContext> & Entity<TQueryProxy>, TQueryProxy extends QueryProxy>(reference: PrimaryReference<TModel, TQueryProxy>): LocalQueryable<TModel, TQueryProxy> {
		const type = reference.$relation;

		this.requireExposed(type);

		const item = reference.$$item;
		const cohort = this.cohorts.cohort(type);
		const withinCohort = !this.cohorts.pointedCohort(type, reference.$column) && cohort && cohort == this.cohorts.cohort(item.constructor);

		return new RoutedQuery<TModel, TQueryProxy>(type, async () => [{ instance: withinCohort ? await this.itemInstance(item) : this.local }], context => context.related(reference), this.queryHooks(type));
	}

	/**
	 * Loads missing referenced data defined in the tree
	 *
	 * references to pointers load the entity they point to from the database the pointer targets, the subtree applies to that entity
	 * other references load from the database the item is stored in, like related entities referencing pointers of the item load from the local database
	 *
	 * @param pointerId id of the top level entity of the cohort, only required for items not loaded through this database which are not top level entities
	 */
	async backload(item: ExposedModel<TContext>, tree: any, pointerId?: string | number): Promise<void> {
		this.requireExposed(item.constructor);

		const instance = await this.itemInstance(item, pointerId);
		this.origins.set(item, instance);

		await instance.use(context => context.backload(item, this.references.prepareTree(item.constructor, tree)));
		await this.references.resolve([item], tree, instance);
	}

	/**
	 * Databases a query of the top level table of the cohort reads
	 *
	 * the remote databases are the ones storing the cohorts the local database has pointers to, each limited to those cohorts
	 */
	private async rootTargets(cohort: Cohort, scope: QueryScope): Promise<QueryTarget[]> {
		switch (scope) {
			case 'local': return [{ instance: this.local }];
			case 'remote': return this.pointers.remoteTargets(cohort);
			case 'all': return [{ instance: this.local }, ...await this.pointers.remoteTargets(cohort)];
		}

		throw new Error(`Unknown query scope '${scope}'`);
	}

	private queryHooks(type: Function): RoutedQueryHooks<any> {
		return {
			prepareTree: tree => this.references.prepareTree(type, tree),
			resolve: (items, tree, instance) => this.references.resolve(items, tree, instance)
		};
	}

	private async find(type: Function, pointerId: string | number, id: string | number) {
		const cohort = this.cohorts.cohort(type);
		const instance = cohort ? await this.pointers.locate(cohort, pointerId) : this.local;

		if (!instance) {
			return null;
		}

		return this.remember(await instance.use(context => this.set(context, type).find(id)), instance);
	}

	/**
	 * Remembers the database the entity is stored in
	 */
	private remember<TItem>(item: TItem, instance: DatabaseInstance<DatabaseContext>) {
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
		const cohort = this.cohorts.cohort(type);

		if (!cohort) {
			return this.local;
		}

		if (pointerId !== undefined) {
			return this.requireCohortInstance(cohort, pointerId);
		}

		const origin = this.origins.get(item);

		if (origin) {
			return origin;
		}

		if (cohort.root == type) {
			return this.requireCohortInstance(cohort, item.id);
		}

		throw new Error(`'${type.name}' '${item.id}' has not been loaded through database '${this.tag}', the pointer id of its cohort is required`);
	}

	private async requireCohortInstance(cohort: Cohort, pointerId: string | number) {
		const instance = await this.pointers.locate(cohort, pointerId);

		if (!instance) {
			throw new Error(`No pointer '${pointerId}' found for '${cohort.root.name}' in database '${this.tag}'`);
		}

		return instance;
	}

	/**
	 * Creates the pointer of the top level item, targeting the local database, in the databases storing the cohorts the item references through their pointers
	 *
	 * a chat between an eu and a us account is created in eu, the us database gets a pointer to it as well
	 */
	private async createReferencingPointers(item: Entity<QueryProxy>, cohort: Cohort) {
		const instances = new Set<DatabaseInstance<DatabaseContext>>();

		for (let [column, referenced] of this.cohorts.pointerColumns(item.constructor)) {
			const id = item[column as keyof typeof item] as string | number | null;

			if (id !== null && id !== undefined) {
				const instance = await this.pointers.locate(referenced, id);

				// a deleted cohort has no database to inform
				if (instance && instance != this.local) {
					instances.add(instance);
				}
			}
		}

		await Promise.all([...instances].map(instance => instance.use(context => this.pointers.set(context, cohort, item.id, this.tag, true))));
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

	private set(context: DatabaseContext, type: Function) {
		return context[this.cohorts.setNames.get(type) as keyof DatabaseContext] as unknown as DbSet<any, any>;
	}

	/**
	 * Exposes the set methods, bound instead of exposing the set itself, so the context can not be reached through it
	 */
	private exposeSet(find: Function, set: () => RoutedQuery<any, any> | ViewSet<any, any>, methods: readonly string[]) {
		const exposed: Record<string, Function> = { find };

		for (let method of ['toQuery', ...chainMethods, ...methods]) {
			if (method != 'find') {
				exposed[method] = (...args: any[]) => {
					const target = set();

					return (target[method as keyof typeof target] as Function).apply(target, args);
				};
			}
		}

		return Object.freeze(exposed);
	}

	private requireExposed(type: Function | undefined) {
		if (type && !this.cohorts.setNames.has(type)) {
			throw new Error(`'${type.name}' is not part of the context of database '${this.tag}'`);
		}
	}
}

/**
 * Splits the arguments of an operation taking an optional pointer id before the item
 */
const splitItemArguments = <TModel>(args: [TModel, string?] | [string | number, TModel, string?]) => (args[0] instanceof Entity ? [undefined, args[0], args[1]] : args) as [string | number | undefined, TModel, string?];

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
