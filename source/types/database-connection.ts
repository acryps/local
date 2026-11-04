import { DbClient } from 'vlquery';

/**
 * Pool configuration of postgrejs, taken from vlquery to not depend on postgrejs directly
 */
type PoolConfiguration = DbClient['connection']['config'];

/**
 * Postgres specific options, without the ones set by the connection itself
 *
 * ssl is excluded, as vlquery always overwrites it
 */
export type DatabaseConnectionOptions = Omit<PoolConfiguration, 'host' | 'database' | 'user' | 'password' | 'min' | 'max' | 'ssl'>;

/**
 * Connection details for a database
 */
export type DatabaseConnection = {
	/**
	 * Unique identifier used to reference across multiple databases
	 */
	tag: string;

	/**
	 * Hostname or IP address of the database server
	 */
	host: string;

	/**
	 * Name of the database to connect to
	 */
	database: string;

	/**
	 * Username used to authenticate against the database
	 */
	user: string;

	/**
	 * Password used to authenticate against the database
	 */
	password: string;

	/**
	 * Minimum number of pooled connections
	 * @default 1
	 */
	min?: number;

	/**
	 * Maximum number of pooled connections
	 * @default 8
	 */
	max?: number;

	/**
	 * Further postgres specific options (port, timeouts, ...)
	 */
	options?: DatabaseConnectionOptions;
}
