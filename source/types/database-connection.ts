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
}
