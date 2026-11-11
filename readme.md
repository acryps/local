# ACRYPS LOCAL
Geo-Distributed PostgreSQL Data Management

Multiple PostgreSQL databases with the same schema, used as one database.

```ts
const database = new Database({
	context: DbContext,
	local: { tag: 'eu', host: '...', database: '...', user: '...', password: '...' },
	remotes: [
		{ tag: 'us', host: '...', database: '...', user: '...', password: '...' }
	],
	remoteIdleTimeout: 60000
});

await database.connect();

const account = await database.sets.account.find(accountId);
await database.update(account.id, account);

const message = await database.sets.message.find(chatId, messageId);
```

## Cohorts
The top level table of a cohort (`account`) has a pointer table `account__pointer (id, target)`, which names the database the cohort is stored in by its tag.
The other tables of the cohort (`picture`) reference the top level table, so they are stored in the same database.
Pointers are looked up in the local database.

## Operations
- queries (`where`, `first`, `toArray`, ...): local database only
- `find(pointerId, id?)`: from the database the pointer targets, `id` defaults to `pointerId` for top level tables
- `related(reference, pointerId?)`: from the database the pointer of the cohort of the item targets, `pointerId` defaults to the id of the item for top level tables
- `fetch`, `backload`: a foreign key to a pointer table loads from the database the pointer targets, other foreign keys load from the local database
- included pointers (`include`, `includeTree`, `backload`) are replaced by the entity they point to, loaded from the database the pointer targets. in `includeTree` the subtree of a pointer reference describes that entity (`{ fromAccount: { id: true, username: true } }`)
- `create`: in the local database, a top level entity gets a pointer to the local database first and shares its id
- `update(pointerId, item)`: in the database the pointer targets
- `delete(pointerId, item)`: in the database the pointer targets, a top level entity takes its pointer in that database along. pointers in other databases are left as they are
- views: local database only

The local connection stays open, remote connections are opened on demand and closed after `remoteIdleTimeout`.
