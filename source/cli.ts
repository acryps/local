#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, parse, resolve } from 'path';

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

const createContext = () => {
	runVlquery('create-context');

	const path = findContextFile();
	const source = readFileSync(path).toString();

	writeFileSync(path, source.replace(/from 'vlquery';/g, `from '${contextModule}';`));
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
		console.log('create-context: Create database context');
		console.log('compile: Compile queries in built output');
		console.groupEnd();

		process.exit(1);
	}
}
