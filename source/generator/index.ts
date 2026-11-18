import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { parseCohorts } from './cohorts';
import { readContextConfiguration } from './configuration';
import { emitContext } from './emitter';
import { readSchema } from './schema';

export { CohortStructureError } from './cohorts';

/**
 * Creates the context of the database configured in the vlconfig.json
 *
 * throws a CohortStructureError, without writing the context, if the schema can not be parsed into cohorts
 */
export const generateContext = async () => {
	const configuration = readContextConfiguration();
	const schema = await readSchema(configuration.connection);

	const source = emitContext(schema, parseCohorts(schema), configuration);

	mkdirSync(dirname(configuration.outFile), { recursive: true });
	writeFileSync(configuration.outFile, source);

	return configuration.outFile;
};
