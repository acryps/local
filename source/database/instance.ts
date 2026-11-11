import { DatabaseContext, DbClient, RunContext } from 'vlquery';
import { DatabaseConnection } from '../types/database-connection';
import { DatabaseContextConstructor } from '../types/database-configuration';

/**
 * Connection to a single database, opened on first use
 *
 * with an idle timeout, the connection is closed after being unused for that long and reopened on the next use
 */
export class DatabaseInstance<TContext extends DatabaseContext> {
	readonly tag: string;

	private session?: { client: DbClient, context: TContext };
	private opening?: Promise<TContext>;

	private activeOperations = 0;
	private idleTimer?: NodeJS.Timeout;

	constructor(
		private readonly connection: DatabaseConnection,
		private readonly contextConstructor: DatabaseContextConstructor<TContext>,
		private readonly runContext?: RunContext,
		private readonly idleTimeout?: number
	) {
		this.tag = connection.tag;
	}

	/**
	 * Context of the current connection, without opening it
	 */
	get context() {
		return this.currentSession().context;
	}

	/**
	 * Runs the operation on this database, the connection is kept open until the operation completes
	 */
	async use<TResult>(operation: (context: TContext) => Promise<TResult>): Promise<TResult> {
		this.activeOperations++;
		clearTimeout(this.idleTimer);

		try {
			return await operation(await this.open());
		} finally {
			this.activeOperations--;
			this.scheduleClose();
		}
	}

	open() {
		if (!this.opening) {
			const session = this.currentSession();

			this.opening = session.client.connect().then(() => session.context, error => {
				if (this.session == session) {
					this.close();
				}

				throw error;
			});
		}

		return this.opening;
	}

	async close() {
		clearTimeout(this.idleTimer);

		const session = this.session;

		this.session = undefined;
		this.opening = undefined;

		if (session?.client.connection) {
			// vlquery reconnects when the pool terminates
			session.client.connection.removeAllListeners();
			session.client.connected = false;

			await session.client.connection.close();
		}
	}

	private currentSession() {
		if (!this.session) {
			const client = new DbClient({
				...this.connection.options,

				host: this.connection.host,
				database: this.connection.database,
				user: this.connection.user,
				password: this.connection.password,
				min: this.connection.min,
				max: this.connection.max
			});

			// entities do not remember their context, so a new context per connection is fine
			this.session = { client, context: new this.contextConstructor(client, this.runContext) };
		}

		return this.session;
	}

	private scheduleClose() {
		if (this.idleTimeout === undefined || this.activeOperations || !this.session) {
			return;
		}

		this.idleTimer = setTimeout(() => this.close(), this.idleTimeout);

		// an idle connection should not keep the process alive
		this.idleTimer.unref();
	}
}
