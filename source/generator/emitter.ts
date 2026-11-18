import { DatabaseContext } from 'vlquery';
import { ContextConfiguration } from './configuration';
import { Cohorts, isRootKey } from './cohorts';
import { ForeignKey, Schema, Table } from './schema';

/**
 * Module generated contexts import from, instead of vlquery
 */
export const contextModule = '@acryps/local';

const typeMappings: Record<string, string> = {
	text: 'string',
	int4: 'number',
	int8: 'number',
	integer: 'number',
	bool: 'boolean',
	boolean: 'boolean',
	float: 'number',
	float4: 'number',
	float8: 'number',
	real: 'number',
	uuid: 'string',
	timestamp: 'Date',
	timestamptz: 'Date',
	time: 'Date',
	date: 'Date',
	json: 'any',
	jsonb: 'any',
	bytea: 'Buffer'
};

const proxyTypeMappings: Record<string, string> = {
	text: 'QueryString',
	int4: 'QueryNumber',
	int8: 'QueryNumber',
	integer: 'QueryNumber',
	float: 'QueryNumber',
	float4: 'QueryNumber',
	float8: 'QueryNumber',
	real: 'QueryNumber',
	bool: 'QueryBoolean',
	boolean: 'QueryBoolean',
	uuid: 'QueryUUID',
	timestamp: 'QueryTimeStamp',
	timestamptz: 'QueryTimeStamp',
	time: 'QueryTime',
	date: 'QueryDate',
	json: 'QueryJSON',
	jsonb: 'QueryJSON',
	bytea: 'QueryBuffer'
};

const proxyGetterBody = '{ throw new Error("Invalid use of QueryModels. QueryModels cannot be used during runtime"); }';

/**
 * Names are converted the same way vlquery does, so contexts stay compatible
 */
const modelName = (name: string) => name.replace(/\_[a-z]/g, match => match[1].toUpperCase());
const className = (name: string) => name[0].toUpperCase() + modelName(name.substring(1));
const queryProxyName = (name: string) => `${className(name)}QueryProxy`;
const viewClassName = (name: string) => `${className(name)}View`;
const viewQueryProxyName = (name: string) => `${viewClassName(name)}Proxy`;

/**
 * Names of the properties a foreign key creates, `from_account__from_chats` creates `fromAccount` and `fromChats`
 *
 * foreign keys not named like this are not exposed as references, just like in vlquery
 */
const referenceNames = (key: ForeignKey) => {
	const parts = key.name.split('__');

	if (parts.length != 2) {
		return { foreign: undefined, primary: undefined };
	}

	return { foreign: parts[0] ? modelName(parts[0]) : undefined, primary: parts[1] ? modelName(parts[1]) : undefined };
};

/**
 * Creates the source of the context
 *
 * pointer tables are left out, references to them reference the table they point to instead (`ForeignReference<Account>`)
 * the cohort structure is described in the static `$$cohorts` of the context
 */
export const emitContext = (schema: Schema, cohorts: Cohorts, configuration: ContextConfiguration) => {
	const typeOf = (type: string, location: string) => {
		if (schema.enums.has(type)) {
			return className(type);
		}

		if (!(type in typeMappings)) {
			throw new Error(`Unsupported column type '${type}' in ${location}`);
		}

		return typeMappings[type];
	};

	const proxyTypeOf = (type: string) => schema.enums.has(type) ? schema.enums.get(type)!.map(value => JSON.stringify(value)).join(' | ') : `Partial<${proxyTypeMappings[type]}>`;

	const tables = schema.tables.filter(table => !cohorts.pointers.has(table.name));
	const keys = tables.flatMap(table => table.foreignKeys).filter(key => !isRootKey(key, key.foreignTable)).sort((left, right) => left.name.localeCompare(right.name));

	// references to a pointer reference the table the pointer points to
	const relationOf = (key: ForeignKey) => cohorts.pointers.get(key.foreignTable)?.root.name ?? key.foreignTable;

	const storedColumns = (table: Table) => table.columns.filter(column => column.name != configuration.active);

	if (configuration.audit) {
		const audit = tables.find(table => modelName(table.name) == configuration.audit!.entity);

		if (!audit) {
			throw new Error(`Cannot find audit table '${configuration.audit.entity}'. Check the spelling and be sure to use camel-case instead of '_' in vlconfig.json`);
		}

		for (let column in configuration.audit.track) {
			if (!audit.columns.some(stored => modelName(stored.name) == column)) {
				throw new Error(`Cannot find tracked audit column '${column}' in audit table '${audit.name}'. Check the spelling and be sure to use camel-case instead of '_' in vlconfig.json`);
			}
		}
	}

	const sections = [
		`import { Entity, DbSet, RootSet, MemberSet, type CohortStructure, DbClient, DatabaseContext, RunContext, QueryUUID, QueryProxy, QueryString, QueryJSON, QueryTimeStamp, QueryNumber, QueryTime, QueryDate, QueryBoolean, QueryBuffer, QueryEnum, ForeignReference, PrimaryReference, View, ViewSet } from '${contextModule}';`
	];

	for (let [name, values] of schema.enums) {
		sections.push(`export class ${className(name)} extends QueryEnum {
	${values.map(value => `static readonly ${modelName(value)} = ${JSON.stringify(value)};`).join('\n\t')}
}`);
	}

	for (let table of tables) {
		const name = className(table.name);
		const proxy = queryProxyName(table.name);
		const columns = storedColumns(table);

		const columnOf = (key: ForeignKey) => columns.find(column => column.name == key.column);

		const proxyMembers: string[] = [];
		const members: string[] = [];
		const initializers: string[] = [];
		const references: string[] = [];

		for (let key of keys) {
			const { foreign, primary } = referenceNames(key);

			if (foreign && key.table == table.name && columnOf(key)) {
				const relation = className(relationOf(key));
				const column = modelName(key.column);

				// a pointer leads into a cohort which may be stored in another database, it can not be joined in queries
				if (!cohorts.pointers.has(key.foreignTable)) {
					proxyMembers.push(`get ${foreign}(): Partial<${queryProxyName(relationOf(key))}> ${proxyGetterBody}`);
				}

				initializers.push(`this.$${foreign} = new ForeignReference<${relation}>(this, ${JSON.stringify(column)}, ${relation});`);

				references.push(`private $${foreign}: ForeignReference<${relation}>;

	get ${foreign}(): Partial<ForeignReference<${relation}>> { return this.$${foreign}; }

	set ${foreign}(value: Partial<ForeignReference<${relation}>>) {
		if (value) {
			if (!value.id) { throw new Error("Invalid null id. Save the referenced model prior to creating a reference to it."); }

			this.${column} = ${typeOf(columnOf(key)!.type, `column '${key.column}' of '${table.name}'`) == 'number' ? '+value.id' : 'value.id as string'};
		} else {
			this.${column} = null;
		}
	}`);
			}

			if (primary && relationOf(key) == table.name) {
				const source = className(key.table);

				members.push(`${primary}: PrimaryReference<${source}, ${queryProxyName(key.table)}>;`);
				initializers.push(`this.${primary} = new PrimaryReference<${source}, ${queryProxyName(key.table)}>(this, ${JSON.stringify(modelName(key.column))}, ${source});`);
			}
		}

		for (let column of columns) {
			members.push(`${column.name == 'id' ? 'declare ' : ''}${modelName(column.name)}: ${typeOf(column.type, `column '${column.name}' of '${table.name}'`)};`);

			if (column.name != 'id') {
				proxyMembers.push(`get ${modelName(column.name)}(): ${proxyTypeOf(column.type)} ${proxyGetterBody}`);
			}
		}

		sections.push(`export class ${proxy} extends QueryProxy {
	${proxyMembers.join('\n\t')}
}`);

		sections.push(`export class ${name} extends Entity<${proxy}> {
	${members.join('\n\t')}

	$$meta = {
		source: ${JSON.stringify(table.name)},
		columns: {
			${columns.map(column => `${modelName(column.name)}: { type: ${JSON.stringify(column.type)}, name: ${JSON.stringify(column.name)} }`).join(',\n\t\t\t')}
		},
		get set(): DbSet<${name}, ${proxy}> {
			return new DbSet<${name}, ${proxy}>(${name}, null);
		}${configuration.active ? `,

		active: ${JSON.stringify(configuration.active)}` : ''}
	};${initializers.length ? `

	constructor() {
		super();

		${initializers.join('\n\t\t')}
	}` : ''}${references.length ? `

	${references.join('\n\n\t')}` : ''}
}`);
	}

	for (let view of schema.views) {
		const proxy = viewQueryProxyName(view.name);
		const name = viewClassName(view.name);

		sections.push(`export class ${proxy} extends QueryProxy {
	${view.columns.filter(column => column.name != 'id').map(column => `get ${modelName(column.name)}(): ${proxyTypeOf(column.type)} ${proxyGetterBody}`).join('\n\t')}
}`);

		sections.push(`export class ${name} extends View<${proxy}> {
	$$meta = {
		source: ${JSON.stringify(view.name)},
		get set(): ViewSet<${name}, ${proxy}> {
			return new ViewSet<${name}, ${proxy}>(${name}, null);
		},

		columns: {
			${view.columns.map(column => `${modelName(column.name)}: { type: ${JSON.stringify(column.type)}, name: ${JSON.stringify(column.name)} }`).join(',\n\t\t\t')}
		}
	};

	${view.columns.map(column => `${modelName(column.name)}: ${typeOf(column.type, `column '${column.name}' of view '${view.name}'`)};`).join('\n\t')}
}`);
	}

	if (configuration.audit) {
		sections.push(emitAudit(configuration.audit));
	}

	const sets = tables.map(table => {
		const cohort = cohorts.cohortOf.get(table.name);
		const type = cohort ? cohort.root == table ? 'RootSet' : 'MemberSet' : 'DbSet';

		return { name: modelName(table.name), source: `new ${type}<${className(table.name)}, ${queryProxyName(table.name)}>(${className(table.name)}, this)` };
	});

	const viewSets = schema.views.map(view => ({ name: modelName(view.name), source: `new ViewSet<${viewClassName(view.name)}, ${viewQueryProxyName(view.name)}>(${viewClassName(view.name)}, this)` }));

	// sets are named after the tables, they must not hide the members of the database context
	const reservedNames = [...Object.getOwnPropertyNames(DatabaseContext.prototype), 'views'];

	for (let set of [...sets, ...viewSets]) {
		if (reservedNames.includes(set.name)) {
			throw new Error(`Table or view '${set.name}' collides with the DatabaseContext member '${set.name}'. Rename it in the database`);
		}
	}

	sections.push(`export class DbContext extends DatabaseContext {
	${sets.map(set => `${set.name} = ${set.source};`).join('\n\t')}${viewSets.length ? `

	views = {
		${viewSets.map(set => `${set.name}: ${set.source}`).join(',\n\t\t')}
	};` : ''}

	static readonly $$cohorts: CohortStructure = ${emitCohorts(cohorts)};

	constructor(client: DbClient${configuration.runContext ? ', runContext: RunContext' : ''}) {
		super(client${configuration.runContext ? ', runContext' : ''});
	}
}`);

	return `${sections.join('\n\n')}\n`;
};

const emitCohorts = (cohorts: Cohorts) => {
	const reference = (key: ForeignKey) => `{ type: ${className(key.foreignTable)}, column: ${JSON.stringify(modelName(key.column))} }`;

	return `{
		cohorts: [${cohorts.cohorts.map(cohort => `
			{
				root: ${className(cohort.root.name)},
				pointer: ${JSON.stringify(cohort.pointer.name)},
				members: [${cohort.members.map(member => `
					{ type: ${className(member.table.name)}, parents: [${member.parents.map(reference).join(', ')}] }`).join(',')}${cohort.members.length ? '\n\t\t\t\t' : ''}]
			}`).join(',')}
		],
		pointerReferences: [${cohorts.pointerReferences.map(key => `
			{ type: ${className(key.table)}, column: ${JSON.stringify(modelName(key.column))}, root: ${className(cohorts.pointers.get(key.foreignTable)!.root.name)} }`).join(',')}
		]
	}`;
};

/**
 * Audit hook of vlquery, created like vlquery does
 */
const emitAudit = (audit: NonNullable<ContextConfiguration['audit']>) => {
	const assignments = Object.keys(audit.track).map(column => {
		const value = audit.track[column];

		if (Array.isArray(value)) {
			// await all values just in case
			return `audit.${column} = ${'await ('.repeat(value.length - 1)}await runContext${value.map(part => `[${JSON.stringify(part)}]`).join(')')};`;
		}

		switch (value) {
			case 'timestamp': return `audit.${column} = new Date();`;
			case 'comment': return `audit.${column} = comment;`;
			case 'action': return `audit.${column} = action;`;
			case 'entity': return `audit.${column} = entity.$$meta.source;`;
			case 'id': return `audit.${column} = entity.id.toString();`;

			case 'object': return `const object = {};

		for (let key in entity.$$meta.columns) {
			object[key] = entity[key];
		}

		audit.${column} = object;`;
		}

		throw new Error(`Unknown tracked audit attribute '${value}'`);
	});

	return `DbSet.$audit = {
	table: ${JSON.stringify(audit.entity)},
	contextRequired: ${JSON.stringify(Object.values(audit.track).some(value => Array.isArray(value)))},
	commentRequired: ${JSON.stringify(!!audit.commentRequired)},

	async createAudit(action: "create" | "update" | "delete", comment: string, entity: Entity<any>, runContext?: any) {
		const audit = new ${className(audit.entity)}();
		${assignments.join('\n\t\t')}

		return audit;
	}
}`;
};
