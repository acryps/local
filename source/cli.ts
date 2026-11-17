#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, parse, resolve } from 'path';
import { DatabaseContext, DbClient } from 'vlquery';
import { CohortStructureError, parseCohorts } from './database/cohorts';

/**
 * Module generated contexts import from, instead of vlquery
 */
const contextModule = '@acryps/local';

/**
 * Runs the vlquery tool bundled with this package, so the user does not need it installed
 */
const runVlquery = (command: string) => {
	const result = spawnSync(process.execPath, [require.resolve('vlquery/bin/vlquery.js'), command], { stdio: 'inherit' });

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
};

/**
 * Finds the generated context file, the same way vlquery looks up its vlconfig.json
 */
const findContextFile = () => {
	let root = process.cwd();

	while (!existsSync(join(root, 'vlconfig.json'))) {
		if (parse(root).root == root) {
			throw new Error(`No vlconfig.json configuration found in '${process.cwd()}'!`);
		}

		root = dirname(root);
	}

	const config = JSON.parse(readFileSync(join(root, 'vlconfig.json')).toString());

	return resolve(root, config.context?.outFile ?? 'db-context.ts');
};

/**
 * Loads the context class from the generated typescript file
 *
 * the file is transpiled with the typescript of the project, the context module resolves to this package
 */
const loadContext = (path: string, source: string) => {
	const projectRequire = createRequire(path);
	const typescript: typeof import('typescript') = projectRequire('typescript');

	const { outputText } = typescript.transpileModule(source, {
		compilerOptions: {
			module: typescript.ModuleKind.CommonJS,
			target: typescript.ScriptTarget.ESNext
		}
	});

	const module = { exports: {} as Record<string, unknown> };

	new Function('require', 'module', 'exports', outputText)(
		(id: string) => id == contextModule ? require('./context') : projectRequire(id),
		module,
		module.exports
	);

	const context = Object.values(module.exports).find(value => typeof value == 'function' && value.prototype instanceof DatabaseContext);

	if (!context) {
		throw new Error(`No database context found in '${path}'`);
	}

	return context as new (client: DbClient) => DatabaseContext;
};

/**
 * Parses the database structure into cohorts, stops the build if it can not be parsed
 */
const validateCohorts = (path: string, source: string) => {
	const context = loadContext(path, source);

	try {
		parseCohorts(new context(new DbClient()));
	} catch (error) {
		if (error instanceof CohortStructureError) {
			console.error(error.message);

			process.exit(1);
		}

		throw error;
	}
};

const createContext = () => {
	runVlquery('create-context');

	const path = findContextFile();
	const source = readFileSync(path).toString().replace(/from 'vlquery';/g, `from '${contextModule}';`);

	writeFileSync(path, source);

	validateCohorts(path, source);
};

const command = process.argv[2];

switch (command) {
	case 'create-context': {
		createContext();

		break;
	}

	case 'compile': {
		runVlquery('compile');

		break;
	}

	default: {
		console.warn(`invalid command: ${command}`);
		console.group();
		console.log('create-context: Create database context, validates its cohorts');
		console.log('compile: Compile queries in built output');
		console.groupEnd();

		process.exit(1);
	}
}
