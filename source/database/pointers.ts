import { DatabaseContext } from 'vlquery';
import { pointerTargetColumn } from '../structure';
import { Cohort } from './cohorts';
import { DatabaseInstance } from './instance';

/**
 * PostgreSQL error code of a violated foreign key
 */
const foreignKeyViolation = '23503';

/**
 * Quoted identifier, the same vlquery uses for table names
 */
export const identifier = (name: string) => JSON.stringify(name);

const target = identifier(pointerTargetColumn);

/**
 * Ids of the cohorts stored in a database
 */
export type PointerTarget = {
	instance: DatabaseInstance<DatabaseContext>;
	ids: (string | number)[];
};

/**
 * Pointers of the cohorts, written without audits, they are internal and audits may require a comment
 *
 * pointers are looked up in the local database
 * a pointer is followed through the pointers of the databases it targets until one targets itself, which is the database the cohort is stored in
 */
export class Pointers {
	constructor(
		private readonly local: DatabaseInstance<DatabaseContext>,
		private readonly instance: (tag: string) => DatabaseInstance<DatabaseContext>
	) {}

	/**
	 * Database the cohort is stored in, null if the cohort has been deleted or is not known by the origin
	 *
	 * @param origin database the pointer is looked up in, pointers of rows are stored along with them
	 */
	async locate(cohort: Cohort, id: string | number, origin = this.local) {
		const [pointer] = await origin.use(context => context.$$query(`SELECT ${target} FROM ${identifier(cohort.pointer)} WHERE id = $1`, [id]));

		return pointer ? this.follow(cohort, id, pointer[0], origin) : null;
	}

	/**
	 * Databases storing the cohorts the local database has pointers to, except the local database
	 *
	 * stale pointers are followed, which updates them, or deletes them if their cohort has been deleted
	 */
	async remoteTargets(cohort: Cohort): Promise<PointerTarget[]> {
		const pointers: [string | number, string][] = await this.local.use(context => context.$$query(`SELECT id, ${target} FROM ${identifier(cohort.pointer)} WHERE ${target} != $1`, [this.local.tag]));

		const targets = new Map<DatabaseInstance<DatabaseContext>, (string | number)[]>();
		const stale: [string | number, string][] = [];

		for (let [tag, ids] of group(pointers)) {
			const instance = this.instance(tag);

			// a cohort is stored in the database its own pointer targets
			const stored = new Set((await instance.use(context => context.$$query(`SELECT id FROM ${identifier(cohort.pointer)} WHERE id = ANY($1::${cohort.idType}[]) AND ${target} = $2`, [ids, tag]))).map(([id]: [string | number]) => `${id}`));

			targets.set(instance, ids.filter(id => stored.has(`${id}`)));
			stale.push(...ids.filter(id => !stored.has(`${id}`)).map(id => [id, tag] as [string | number, string]));
		}

		for (let [id, tag] of stale) {
			const instance = await this.follow(cohort, id, tag, this.local);

			// the cohort may have moved to the local database
			if (instance && instance != this.local) {
				targets.set(instance, [...targets.get(instance) ?? [], id]);
			}
		}

		return [...targets].filter(([, ids]) => ids.length).map(([instance, ids]) => ({ instance, ids }));
	}

	/**
	 * Database the cohort is stored in, the pointer is followed through the pointers of the databases it targets until one targets itself
	 *
	 * a move only updates the pointers of the databases it involves, so other databases may still target the database the cohort left (EU → US → AP)
	 * when the path is longer than one, the pointer in the origin database is updated to target the database the cohort is stored in (EU → AP)
	 *
	 * a deleted cohort takes its pointer along, when the path ends in a database without the pointer, the pointer in the origin database is deleted as well
	 *
	 * @param tag target of the pointer in the origin database
	 * @param origin database the pointer has been read from
	 * @returns null if the cohort has been deleted
	 */
	async follow(cohort: Cohort, id: string | number, tag: string, origin: DatabaseInstance<DatabaseContext>) {
		const path = [origin.tag];
		let instance = origin;

		while (tag != instance.tag) {
			if (path.includes(tag)) {
				throw new Error(`Pointer '${id}' in '${cohort.pointer}' runs in a circle (${[...path, tag].join(' → ')})`);
			}

			path.push(tag);
			instance = this.instance(tag);

			const [pointer] = await instance.use(context => context.$$query(`SELECT ${target} FROM ${identifier(cohort.pointer)} WHERE id = $1`, [id]));

			if (!pointer) {
				await origin.use(context => this.delete(context, cohort, id));

				return null;
			}

			tag = pointer[0];
		}

		if (path.length > 2) {
			await origin.use(context => this.set(context, cohort, id, instance.tag));
		}

		return instance;
	}

	/**
	 * Inserts a new pointer targeting the database of the context, returns the id generated for it
	 */
	async insert(context: DatabaseContext, cohort: Cohort, tag: string): Promise<string | number> {
		const [[id]] = await context.$$query(`INSERT INTO ${identifier(cohort.pointer)} (${target}) VALUES ($1) RETURNING id`, [tag]);

		return id;
	}

	/**
	 * Points the pointer to the database with the tag, creates the pointer if it does not exist yet when requested
	 */
	async set(context: DatabaseContext, cohort: Cohort, id: string | number, tag: string, create = false) {
		if (create) {
			await context.$$query(`INSERT INTO ${identifier(cohort.pointer)} (id, ${target}) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET ${target} = EXCLUDED.${target}`, [id, tag]);
		} else {
			await context.$$query(`UPDATE ${identifier(cohort.pointer)} SET ${target} = $2 WHERE id = $1`, [id, tag]);
		}
	}

	/**
	 * Deletes the pointer, unless it is still referenced
	 */
	async delete(context: DatabaseContext, cohort: Cohort, id: string | number) {
		try {
			await context.$$query(`DELETE FROM ${identifier(cohort.pointer)} WHERE id = $1`, [id]);
		} catch (error) {
			// rows of other cohorts referencing the pointer keep it alive
			if ((error as { code?: string }).code != foreignKeyViolation) {
				throw error;
			}
		}
	}
}

/**
 * Ids of the pointers by their target
 */
const group = (pointers: [string | number, string][]) => {
	const groups = new Map<string, (string | number)[]>();

	for (let [id, tag] of pointers) {
		if (!groups.has(tag)) {
			groups.set(tag, []);
		}

		groups.get(tag)!.push(id);
	}

	return groups;
};
