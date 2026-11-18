#!/usr/bin/env node

import { CohortStructureError, generateContext } from './generator';

/**
 * Terminal methods of scoped queries taking a filter, compiled in addition to the methods configured for vlquery
 */
const scopedFilterMethods = ['first', 'single'].flatMap(method => ['Local', 'Remote', 'All'].map(scope => `${method}${scope}`));

const createContext = async () => {
	try {
		console.log(`created context '${await generateContext()}'`);
	} catch (error) {
		if (error instanceof CohortStructureError) {
			console.error(error.message);

			process.exit(1);
		}

		throw error;
	}
};

/**
 * Compiles the queries with the compiler of vlquery, its configuration is read from the vlconfig.json when loaded
 */
const compile = () => {
	const { config } = require('vlquery/dist/config');

	for (let method of scopedFilterMethods) {
		if (!config.compile.methods.includes(method)) {
			config.compile.methods.push(method);
		}
	}

	require('vlquery/dist/tools/parser').compileQueries();
};

const command = process.argv[2];

switch (command) {
	case 'create-context': {
		createContext().catch(error => {
			console.error(error);

			process.exit(1);
		});

		break;
	}

	case 'compile': {
		compile();

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
