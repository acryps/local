import { DatabaseContext } from 'vlquery';
import { Database } from './database';

/**
 * Database at the current location
 */
export class LocalDatabase<TContext extends DatabaseContext> extends Database<TContext> {}
