import { DatabaseContext, Entity, QueryProxy, Queryable, View } from 'vlquery';
import { DatabaseInstance } from './instance';

type QueryStep = {
	method: 'where' | 'include' | 'includeTree' | 'orderByAscending' | 'orderByDescending' | 'skip' | 'limit' | 'page';
	args: any[];
};

export type RoutedQueryHooks<TModel> = {
	/**
	 * Rewrites a tree before it is passed to vlquery
	 */
	prepareTree?(tree: any): any;

	/**
	 * Called with the loaded items and the trees they have been loaded with, before they are returned
	 */
	resolve?(items: TModel[], tree: any): Promise<void>;
};

/**
 * Query executed in a database which is only known once the query runs
 *
 * the steps are recorded and replayed on the context of that database, as a vlquery query is bound to its context
 */
export class RoutedQuery<TModel extends Entity<TQueryProxy> | View<TQueryProxy>, TQueryProxy extends QueryProxy> implements Queryable<TModel, TQueryProxy> {
	constructor(
		private readonly instance: () => Promise<DatabaseInstance<DatabaseContext>>,
		private readonly source: (context: DatabaseContext) => Queryable<TModel, TQueryProxy>,
		private readonly hooks: RoutedQueryHooks<TModel> = {},
		private readonly steps: QueryStep[] = []
	) {}

	toQuery(): Queryable<TModel, TQueryProxy> {
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

	async first(query?: (item: TQueryProxy) => any) {
		const item = await this.run(queryable => queryable.first(query));

		if (item) {
			await this.resolve([item]);
		}

		return item;
	}

	async single(query?: (item: TQueryProxy) => any) {
		const item = await this.run(queryable => queryable.single(query));
		await this.resolve([item]);

		return item;
	}

	async toArray() {
		const items = await this.run(queryable => queryable.toArray());
		await this.resolve(items);

		return items;
	}

	count() {
		return this.run(queryable => queryable.count());
	}

	private chain(method: QueryStep['method'], ...args: any[]) {
		return new RoutedQuery(this.instance, this.source, this.hooks, [...this.steps, { method, args }]);
	}

	private async run<TResult>(terminal: (queryable: Queryable<TModel, TQueryProxy>) => Promise<TResult>) {
		const instance = await this.instance();

		return instance.use(context => {
			let queryable = this.source(context);

			for (let step of this.steps) {
				let args = step.args;

				if (step.method == 'includeTree' && this.hooks.prepareTree) {
					args = [this.hooks.prepareTree(args[0])];
				}

				queryable = (queryable[step.method] as Function).apply(queryable, args);
			}

			return terminal(queryable);
		});
	}

	private async resolve(items: TModel[]) {
		if (this.hooks.resolve) {
			const tree = {};

			for (let step of this.steps) {
				if (step.method == 'includeTree') {
					Object.assign(tree, step.args[0]);
				}
			}

			await this.hooks.resolve(items, tree);
		}
	}
}
