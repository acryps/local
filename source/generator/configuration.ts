import { existsSync, readFileSync } from 'fs';
import { dirname, join, parse, resolve } from 'path';

/**
 * Context section of the vlconfig.json, the same vlquery reads
 */
export type ContextConfiguration = {
	/**
	 * Absolute path of the generated context
	 */
	outFile: string;

	/**
	 * Connection options passed to postgrejs, unset options are read from the PG environment variables
	 */
	connection: object;

	/**
	 * Column deactivating rows instead of deleting them
	 */
	active?: string;

	audit?: {
		entity: string;
		track: Record<string, string | string[]>;
		commentRequired?: boolean;
	};

	runContext?: boolean;
};

/**
 * Reads the context configuration from the vlconfig.json, looked up from the working directory upwards like vlquery does
 */
export const readContextConfiguration = (): ContextConfiguration => {
	let root = process.cwd();

	while (!existsSync(join(root, 'vlconfig.json'))) {
		if (parse(root).root == root) {
			throw new Error(`No vlconfig.json configuration found in '${process.cwd()}'!`);
		}

		root = dirname(root);
	}

	const context = JSON.parse(readFileSync(join(root, 'vlconfig.json')).toString()).context ?? {};

	if (context.audit) {
		if (!context.audit.entity) {
			throw new Error('No audit entity set!');
		}

		if (!context.audit.track) {
			throw new Error('No audit track set!');
		}
	}

	return {
		outFile: resolve(root, context.outFile ?? 'db-context.ts'),
		connection: context.connection ?? {},
		active: context.active,
		audit: context.audit,
		runContext: context.runContext
	};
};
