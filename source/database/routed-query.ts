import { DatabaseContext, Entity, Query, QueryProxy, Queryable, View } from 'vlquery';
import { DatabaseInstance } from './instance';

/**
 * Databases a query reads, the local database, all remote databases or all of them
 */
export type QueryScope = 'local' | 'remote' | 'all';

/**
 * Query which runs in the local database, the remote databases or all of them, chosen by its terminal method
 *
 * a query reading multiple databases is merged: ordered by the sorters, then skip and limit are applied to the merged items
 * sorters can only be merged when they select columns of the queried entity (`message => message.created`)
 */
export interface ScopedQueryable<TModel extends Entity<TQueryProxy> | View<TQueryProxy>, TQueryProxy extends QueryProxy> {
	where(query: (item: TQueryProxy) => any): ScopedQueryable<TModel, TQueryProxy>;
	include(selector: (item: TModel) => any): ScopedQueryable<TModel, TQueryProxy>;
	includeTree(tree: any): ScopedQueryable<TModel, TQueryProxy>;
	orderByAscending(sorter: (item: TQueryProxy) => any): ScopedQueryable<TModel, TQueryProxy>;
	orderByDescending(sorter: (item: TQueryProxy) => any): ScopedQueryable<TModel, TQueryProxy>;
	skip(count: number): ScopedQueryable<TModel, TQueryProxy>;
	limit(count: number): ScopedQueryable<TModel, TQueryProxy>;
	page(index: number, size?: number): ScopedQueryable<TModel, TQueryProxy>;

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
 * Terminal methods of a scoped query, each exposed once per scope (`firstLocal`, `firstRemote`, `firstAll`)
 */
export const scopedQueryMethods = ['first', 'single', 'toArray', 'count'].flatMap(method => ['Local', 'Remote', 'All'].map(scope => `${method}${scope}`)) as readonly (keyof ScopedQueryable<any, any>)[];

type QueryStep = {
	method: 'where' | 'include' | 'includeTree' | 'orderByAscending' | 'orderByDescending' | 'skip' | 'limit' | 'page';
	args: any[];
};

/**
 * Compiled sorter, a column path or the coalesce of sorters
 */
type Sorter = { path?: string[], logical?: { left: Sorter, right: Sorter } };

type Order = { sorter: Sorter, direction: 1 | -1 };

export type RoutedQueryHooks<TModel> = {
	/**
	 * Rewrites a tree before it is passed to vlquery
	 */
	prepareTree?(tree: any): any;

	/**
	 * Called with the loaded items, the trees and the database they have been loaded with, before they are returned
	 */
	resolve?(items: TModel[], tree: any, instance: DatabaseInstance<DatabaseContext>): Promise<void>;
};

/**
 * Query executed in the databases of the scope of its terminal method
 *
 * the steps are recorded and replayed on the context of each database, as a vlquery query is bound to its context
 */
export class RoutedQuery<TModel extends Entity<TQueryProxy> | View<TQueryProxy>, TQueryProxy extends QueryProxy> implements ScopedQueryable<TModel, TQueryProxy> {
	constructor(
		private readonly type: Function,
		private readonly instances: (scope: QueryScope) => DatabaseInstance<DatabaseContext>[],
		private readonly source: (context: DatabaseContext) => Queryable<TModel, TQueryProxy>,
		private readonly hooks: RoutedQueryHooks<TModel> = {},
		private readonly steps: QueryStep[] = []
	) {}

	toQuery(): ScopedQueryable<TModel, TQueryProxy> {
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

	firstLocal(query?: (item: TQueryProxy) => any) {
		return this.first('local', query);
	}

	firstRemote(query?: (item: TQueryProxy) => any) {
		return this.first('remote', query);
	}

	firstAll(query?: (item: TQueryProxy) => any) {
		return this.first('all', query);
	}

	singleLocal(query?: (item: TQueryProxy) => any) {
		return this.single('local', query);
	}

	singleRemote(query?: (item: TQueryProxy) => any) {
		return this.single('remote', query);
	}

	singleAll(query?: (item: TQueryProxy) => any) {
		return this.single('all', query);
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

	countLocal() {
		return this.count('local');
	}

	countRemote() {
		return this.count('remote');
	}

	countAll() {
		return this.count('all');
	}

	private async first(scope: QueryScope, query?: (item: TQueryProxy) => any) {
		const [item] = await this.load(scope, this.filtered(query), 1);

		return item;
	}

	private async single(scope: QueryScope, query?: (item: TQueryProxy) => any) {
		const items = await this.load(scope, this.filtered(query), 2);

		if (items.length != 1) {
			throw new Error(`Single query returned ${items.length == 0 ? 'no' : 'multiple'} items`);
		}

		return items[0];
	}

	private async count(scope: QueryScope) {
		const counts = await Promise.all(this.instances(scope).map(instance => instance.use(context => this.replay(context, this.steps).count())));

		return counts.reduce((sum, count) => sum + count, 0);
	}

	private chain(method: QueryStep['method'], ...args: any[]) {
		return new RoutedQuery(this.type, this.instances, this.source, this.hooks, [...this.steps, { method, args }]);
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
		const instances = this.instances(scope);

		if (instances.length == 1) {
			const [instance] = instances;
			const items = await instance.use(context => this.replay(context, take === undefined ? steps : [...steps, { method: 'limit', args: [take] }]).toArray());

			await this.resolve(items, instance);

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

		const columns = new Set(orders.flatMap(order => this.sortColumns(order.sorter)));

		const instanceSteps: QueryStep[] = steps.filter(step => step.method != 'skip' && step.method != 'limit' && step.method != 'page').map(step => {
			// the merge compares the sorted columns, a tree may leave them out
			if (step.method == 'includeTree' && columns.size) {
				return { method: step.method, args: [{ ...step.args[0], ...Object.fromEntries([...columns].map(column => [column, true])) }] };
			}

			return step;
		});

		if (limit !== undefined) {
			instanceSteps.push({ method: 'limit', args: [skip + limit] });
		}

		const loaded = await Promise.all(instances.map(instance => instance.use(context => this.replay(context, instanceSteps).toArray()).then(items => items.map(item => [item, instance] as const))));

		// the sort is stable, equal items keep the order of their databases
		const merged = loaded.flat().sort((left, right) => compareItems(orders, left[0], right[0]));
		const kept = merged.slice(skip, limit === undefined ? undefined : skip + limit);

		await Promise.all(instances.map(instance => {
			const items = kept.filter(([, origin]) => origin == instance).map(([item]) => item);

			return items.length ? this.resolve(items, instance) : undefined;
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

	private replay(context: DatabaseContext, steps: QueryStep[]) {
		let queryable = this.source(context);

		for (let step of steps) {
			let args = step.args;

			if (step.method == 'includeTree' && this.hooks.prepareTree) {
				args = [this.hooks.prepareTree(args[0])];
			}

			queryable = (queryable[step.method] as Function).apply(queryable, args);
		}

		return queryable;
	}

	private async resolve(items: TModel[], instance: DatabaseInstance<DatabaseContext>) {
		if (this.hooks.resolve) {
			const tree = {};

			for (let step of this.steps) {
				if (step.method == 'includeTree') {
					Object.assign(tree, step.args[0]);
				}
			}

			await this.hooks.resolve(items, tree, instance);
		}
	}
}

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
