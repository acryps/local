# Getting Started

## Install
```sh
npm install @acryps/local
```

## Schema
Every database uses the same schema. A cohort is a top level table with a pointer table, plus the tables referencing it (see [Cohorts](cohorts.md)).

```sql
CREATE TABLE account__pointer (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target text);
CREATE TABLE account (id uuid PRIMARY KEY REFERENCES account__pointer (id), username text);
CREATE TABLE picture (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES account (id), url text);
```

## Context
The context is generated from a database configured in `vlconfig.json`, the same file [vlquery](https://www.npmjs.com/package/vlquery) reads. It is looked up from the working directory upwards.

```json
{
	"context": {
		"outFile": "source/managed/database.ts",
		"connection": { "host": "localhost", "database": "app" },
		"active": "active",
		"audit": { "entity": "audit", "track": { "account": ["username"] } }
	}
}
```

| Option | Description |
| --- | --- |
| `outFile` | Path of the generated context, default `db-context.ts` |
| `connection` | postgrejs connection options, unset options are read from the `PG...` environment variables |
| `active` | Column deactivating rows instead of deleting them |
| `audit` | Audit entity and tracked columns, as in vlquery |
| `runContext` | Generate the context with a run context |

## CLI
| Command | Description |
| --- | --- |
| `acryps-local create-context` | Reads the schema, [validates the cohorts](cohorts.md#validation) and writes the context |
| `acryps-local compile` | Compiles the queries in the built output like `vlquery compile`, including the filters of `firstLocal`, `singleAll`, ... |

```json
"scripts": {
	"context": "acryps-local create-context",
	"build": "tsc && acryps-local compile"
}
```

## Connect
```ts
import { Database } from '@acryps/local';
import { DbContext } from './managed/database';

const database = new Database({
	context: DbContext,
	local: { tag: 'eu', host: 'eu.example.com', database: 'app', user: 'app', password: '...' },
	remotes: [
		{ tag: 'us', host: 'us.example.com', database: 'app', user: 'app', password: '...' }
	]
});

await database.connect();
```

See the [API reference](api.md) for all configuration options.
