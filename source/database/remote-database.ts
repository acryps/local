import { DatabaseContext } from 'vlquery';
import { Database } from './database';

/**
 * Database at another location
 */
export class RemoteDatabase<TContext extends DatabaseContext> extends Database<TContext> {}
