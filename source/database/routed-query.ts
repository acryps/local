import { DatabaseContext, Entity, Query, QueryProxy, Queryable, View } from 'vlquery';
import { DatabaseInstance } from './instance';

/**
 * Databases a query reads, the local database, the remote databases or all of them
 */
export type QueryScope = 'local' | 'remote' | 'all';

/**
 * Database a query runs in, limited to the rows with the ids when set
 */
export type QueryTarget = {
	instance: DatabaseInstance<DatabaseContext>;
	ids?: (string | number)[];
};

/**
 * Methods building a query, the query is run by its terminal method
 */
interface QueryChain<TModel, TQueryProxy extends QueryProxy, TQuery> {
	where(query: (item: TQueryProxy) => any): TQuery;
	include(selector: (item: TModel) => any): TQuery;
	includeTree(tree: any): TQuery;
	orderByAscending(sorter: (item: TQueryProxy) => any): TQuery;
	orderByDescending(sorter: (item: TQueryProxy) => any): TQuery;
	skip(count: number): TQuery;
	limit(count: number): TQuery;
	page(index: number, size?: number): TQuery;
}

/**
 * Query of a top level table, its terminal method names the databases it reads
 *
 * `...Local` reads the local database, `...Remote` the remote databases storing the cohorts the local database has pointers to, `...All` both
 */
export interface ScopedQueryable<TModel extends Entity<TQueryProxy> | View<TQueryProxy>, TQueryProxy extends QueryProxy> extends QueryChain<TModel, TQueryProxy, ScopedQueryable<TModel, TQueryProxy>> {
	firstLocal(query?: (item: TQueryProxy) => any): Promise<TModel>;
	firstRemote(query?: (item: TQueryProxy) => any): Promise<TModel>;
	firstAll(query?: (item: TQueryProxy) => any): Promise<TModel>;

	singleLocal(query?: (item: TQueryProxy) => any): Promise<TModel>;
	singleRemote(query?: (item: TQueryProxy) => any): Promise<TModel>;
	singleAll(query?: (item: TQueryProxy) => any): Promise<TModel>;

	toArrayLocal(): Promise<TModel[]>;
	toArrayRemote(): Promise<TModel[]>;
	toArrayAll(): Promise<TModel[]>;

	countLocal(): Promise<number>;
	countRemote(): Promise<number>;
	countAll(): Promise<number>;
}

/**
 * Query reading a single database
 */
export interface LocalQueryable<TModel extends Entity<TQueryProxy> | View<TQueryProxy>, TQueryProxy extends QueryProxy> extends QueryChain<TModel, TQueryProxy, LocalQueryable<TModel, TQueryProxy>> {
	first(query?: (item: TQueryProxy) => any): Promise<TModel>;
	single(query?: (item: TQueryProxy) => any): Promise<TModel>;
	toArray(): Promise<TModel[]>;
	count(): Promise<number>;
}

/**
 * Methods building a query
 */
export const chainMethods = ['where', 'include', 'includeTree', 'orderByAscending', 'orderByDescending', 'skip', 'limit', 'page'] as const;

/**
 * Terminal methods of a scoped query, each exposed once per scope (`firstLocal`, `firstRemote`, `firstAll`)
 */
export const scopedMethods = ['first', 'single', 'toArray', 'count'].flatMap(method => ['Local', 'Remote', 'All'].map(scope => `${method}${scope}`)) as readonly (keyof ScopedQueryable<any, any>)[];

/**
 * Terminal methods of a query reading a single database
 */
export const localMethods = ['first', 'single', 'toArray', 'count'] as const;

type QueryStep = {
	method: typeof chainMethods[number];
	args: any[];
};

/**
 * Compiled sorter, a column path or the coalesce of sorters
 */
type Sorter = { path?: string[], logical?: { left: Sorter, right: Sorter } };

type Order = { sorter: Sorter, direction: 1 | -1 };

export type RoutedQueryHooks<TModel> = {
	/**
	 * Rewrites the tree before it is passed to vlquery
	 */
	prepareTree?(tree: any): any;

	/**
	 * Called with the loaded items, the tree and the database they have been loaded from, before they are returned
	 */
	resolve?(items: TModel[], tree: any, instance: DatabaseInstance<DatabaseContext>): Promise<void>;
};

/**
 * Query executed in the databases its route leads to
 *
 * the steps are recorded and replayed on the context of each database, as a vlquery query is bound to its context
 * includes are merged into a single tree, which is passed to vlquery after the hooks prepared it
 */
export class RoutedQuery<TModel extends Entity<TQueryProxy> | View<TQueryProxy>, TQueryProxy extends QueryProxy> implements ScopedQueryable<TModel, TQueryProxy>, LocalQueryable<TModel, TQueryProxy> {
	/**
	 * @param route databases the query reads for the scope, the plain terminal methods read the 'local' scope
	 */
	constructor(
		private readonly type: Function,
		private readonly route: (scope: QueryScope) => Promise<QueryTarget[]>,
		private readonly source: (context: DatabaseContext) => Queryable<TModel, TQueryProxy>,
		private readonly hooks: RoutedQueryHooks<TModel> = {},
		private readonly steps: QueryStep[] = []
	) {}

	toQuery() {
		return this;
	}

	where(query: (item: TQueryProxy) => any) {
		return this.chain('where', query);
	}

	include(selector: (item: TModel) => any) {
		return this.chain('include', selector);
	}

	includeTree(tree: any) {
		return this.chain('includeTree', tree);
	}

	orderByAscending(sorter: (item: TQueryProxy) => any) {
		return this.chain('orderByAscending', sorter);
	}

	orderByDescending(sorter: (item: TQueryProxy) => any) {
		return this.chain('orderByDescending', sorter);
	}

	skip(count: number) {
		return this.chain('skip', count);
	}

	limit(count: number) {
		return this.chain('limit', count);
	}

	page(index: number, size?: number) {
		return this.chain('page', index, size);
	}

	first(query?: (item: TQueryProxy) => any) {
		return this.loadFirst('local', query);
	}

	firstLocal(query?: (item: TQueryProxy) => any) {
		return this.loadFirst('local', query);
	}

	firstRemote(query?: (item: TQueryProxy) => any) {
		return this.loadFirst('remote', query);
	}

	firstAll(query?: (item: TQueryProxy) => any) {
		return this.loadFirst('all', query);
	}

	single(query?: (item: TQueryProxy) => any) {
		return this.loadSingle('local', query);
	}

	singleLocal(query?: (item: TQueryProxy) => any) {
		return this.loadSingle('local', query);
	}

	singleRemote(query?: (item: TQueryProxy) => any) {
		return this.loadSingle('remote', query);
	}

	singleAll(query?: (item: TQueryProxy) => any) {
		return this.loadSingle('all', query);
	}

	toArray() {
		return this.load('local', this.steps);
	}

	toArrayLocal() {
		return this.load('local', this.steps);
	}

	toArrayRemote() {
		return this.load('remote', this.steps);
	}

	toArrayAll() {
		return this.load('all', this.steps);
	}

	count() {
		return this.loadCount('local');
	}

	countLocal() {
		return this.loadCount('local');
	}

	countRemote() {
		return this.loadCount('remote');
	}

	countAll() {
		return this.loadCount('all');
	}

	private async loadFirst(scope: QueryScope, query?: (item: TQueryProxy) => any) {
		const [item] = await this.load(scope, this.filtered(query), 1);

		return item;
	}

	private async loadSingle(scope: QueryScope, query?: (item: TQueryProxy) => any) {
		const items = await this.load(scope, this.filtered(query), 2);

		if (items.length != 1) {
			throw new Error(`Single query returned ${items.length == 0 ? 'no' : 'multiple'} items`);
		}

		return items[0];
	}

	private async loadCount(scope: QueryScope) {
		const targets = await this.route(scope);
		const counts = await Promise.all(targets.map(target => target.instance.use(context => this.replay(context, target, this.steps).count())));

		return counts.reduce((sum, count) => sum + count, 0);
	}

	private chain(method: QueryStep['method'], ...args: any[]) {
		return new RoutedQuery(this.type, this.route, this.source, this.hooks, [...this.steps, { method, args }]);
	}

	private filtered(query?: (item: TQueryProxy) => any): QueryStep[] {
		return query ? [...this.steps, { method: 'where', args: [query] }] : this.steps;
	}

	/**
	 * Loads the items from the databases of the scope
	 *
	 * a single database runs the steps as they are, multiple databases are queried without skip and limit, the merged items are ordered and cut afterwards
	 *
	 * @param take overrides the limit, like vlquery does for first and single
	 */
	private async load(scope: QueryScope, steps: QueryStep[], take?: number) {
		const targets = await this.route(scope);
		const tree = this.tree(steps);

		if (targets.length == 1) {
			const [target] = targets;
			const items = await target.instance.use(context => this.replay(context, target, take === undefined ? steps : [...steps, { method: 'limit', args: [take] }], tree).toArray());

			await this.resolve(items, tree, target.instance);

			return items;
		}

		let { skip, limit } = window(steps);

		if (take !== undefined) {
			limit = take;
		}

		const orders = steps.filter(step => step.method == 'orderByAscending' || step.method == 'orderByDescending').map(step => ({
			sorter: step.args[0],
			direction: step.method == 'orderByAscending' ? 1 : -1
		}) as Order);

		// the merge compares the sorted columns, a tree may leave them out
		const columns = orders.flatMap(order => this.sortColumns(order.sorter));
		const mergeTree = tree && { ...tree, ...Object.fromEntries(columns.map(column => [column, true])) };

		const targetSteps = steps.filter(step => step.method != 'skip' && step.method != 'limit' && step.method != 'page');

		if (limit !== undefined) {
			targetSteps.push({ method: 'limit', args: [skip + limit] });
		}

		const loaded = await Promise.all(targets.map(target => target.instance.use(context => this.replay(context, target, targetSteps, mergeTree).toArray()).then(items => items.map(item => [item, target.instance] as const))));

		// the sort is stable, equal items keep the order of their databases
		const merged = loaded.flat().sort((left, right) => compareItems(orders, left[0], right[0]));
		const kept = merged.slice(skip, limit === undefined ? undefined : skip + limit);

		await Promise.all(targets.map(({ instance }) => {
			const items = kept.filter(([, origin]) => origin == instance).map(([item]) => item);

			return items.length ? this.resolve(items, tree, instance) : undefined;
		}));

		return kept.map(([item]) => item);
	}

	/**
	 * Columns the sorter compares, throws when it can not be compared after loading
	 */
	private sortColumns(sorter: Sorter): string[] {
		if (sorter.logical) {
			return [...this.sortColumns(sorter.logical.left), ...this.sortColumns(sorter.logical.right)];
		}

		const columns = new (this.type as new () => Entity<QueryProxy>)().$$meta.columns;

		if (sorter.path?.length == 1 && sorter.path[0] in columns) {
			return [sorter.path[0]];
		}

		throw new Error(`Query of '${this.type.name}' reading multiple databases can only be ordered by its columns, ${JSON.stringify(sorter)} can not be merged`);
	}

	/**
	 * Tree of the includes, include adds the path of its selector to the tree, includeTree replaces it, like in vlquery
	 */
	private tree(steps: QueryStep[]) {
		let tree: any;

		for (let step of steps) {
			if (step.method == 'includeTree') {
				tree = structuredClone(step.args[0]);
			} else if (step.method == 'include') {
				tree = selectorTree(this.type, step.args[0], tree ?? {});
			}
		}

		return tree;
	}

	private replay(context: DatabaseContext, target: QueryTarget, steps: QueryStep[], tree?: any) {
		let queryable = this.source(context);

		if (target.ids) {
			queryable = queryable.where({ call: { stack: ['id', { name: 'includedIn', parameters: [{ value: target.ids }] }] } } as any);
		}

		for (let step of steps) {
			if (step.method != 'include' && step.method != 'includeTree') {
				queryable = (queryable[step.method] as Function).apply(queryable, step.args);
			}
		}

		if (tree) {
			queryable = queryable.includeTree(this.hooks.prepareTree ? this.hooks.prepareTree(tree) : tree);
		}

		return queryable;
	}

	private async resolve(items: TModel[], tree: any, instance: DatabaseInstance<DatabaseContext>) {
		await this.hooks.resolve?.(items, tree ?? {}, instance);
	}
}

/**
 * Adds the path of the selector to the tree, with the columns of every entity along it, the same way vlquery does
 */
const selectorTree = (type: Function, selector: Function, tree: any) => {
	const [parameter, body] = selector.toString().split('=>');
	const path = body.replace(`${parameter.trim().replace(/\(|\)/g, '')}.`, '').trim().split('.');

	let model = new (type as new () => Entity<QueryProxy>)();
	let leaf = tree;

	for (let key in model.$$meta.columns) {
		tree[key] = true;
	}

	for (let property of path) {
		const relation = (model[property as keyof typeof model] as unknown as { $relation: new () => Entity<QueryProxy> }).$relation;

		if (typeof leaf[property] != 'object') {
			leaf[property] = {};
		}

		leaf = leaf[property];
		model = new relation();

		for (let key in model.$$meta.columns) {
			leaf[key] = true;
		}
	}

	return tree;
};

/**
 * Skip and limit of the steps, the last step setting them wins, like in vlquery
 */
const window = (steps: QueryStep[]) => {
	let skip = 0;
	let limit: number | undefined;

	for (let step of steps) {
		if (step.method == 'skip') {
			skip = step.args[0];
		} else if (step.method == 'limit') {
			limit = step.args[0];
		} else if (step.method == 'page') {
			const size = step.args[1] || Query.defaultPageSize;

			limit = size;
			skip = step.args[0] * size;
		}
	}

	return { skip, limit };
};

const compareItems = (orders: Order[], left: any, right: any) => {
	for (let order of orders) {
		const compared = compareValues(sortValue(order.sorter, left), sortValue(order.sorter, right)) * order.direction;

		if (compared) {
			return compared;
		}
	}

	return 0;
};

const sortValue = (sorter: Sorter, item: any): unknown => sorter.logical ? sortValue(sorter.logical.left, item) ?? sortValue(sorter.logical.right, item) : item[sorter.path![0]];

/**
 * Compares like postgres, nulls are larger than any value (last ascending, first descending)
 *
 * strings are compared by their code points, which may differ from the collation of the database
 */
const compareValues = (left: any, right: any) => {
	if (left === null || left === undefined) {
		return right === null || right === undefined ? 0 : 1;
	}

	if (right === null || right === undefined) {
		return -1;
	}

	return left < right ? -1 : left > right ? 1 : 0;
};
