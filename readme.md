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
await database.update(account);

const message = await database.sets.message.find(chatId, messageId);
message.text = 'edited';
await database.update(message);
```

## Cohorts
The top level table of a cohort (`account`) has a pointer table `account__pointer (id, target)`, which names the database the cohort is stored in by its tag.
The other tables of the cohort (`picture`) reference the top level table, so they are stored in the same database.
Pointers are looked up in the local database. They are written without audits.

A pointer is followed through the pointers of the databases it targets until one targets itself, which is the database the cohort is stored in.
A move only updates the pointers of the databases it involves, so other databases may still target the database the cohort left (`EU → US → AP`).
When such a stale pointer is used, it is updated to target the database the cohort is stored in (`EU → AP`).
When the path ends in a database without the pointer, the cohort has been deleted and the used pointer is deleted as well, unless rows still reference it.

### Validation
`acryps-local create-context` parses the database structure into cohorts and stops the build with an error listing every problem found, `new Database(...)` throws a `CohortStructureError` for the same problems:
- a pointer table points to an existing table, has a `target` column, shares the id type of the table it points to and references no other tables
- a table belongs to one cohort at most, as its rows are stored in one database
- a table of a cohort has an id of type `uuid`, as its rows are created in and moved between databases (sequences would collide)
- a top level table references the tables of other cohorts through their pointer tables

## Operations
- queries (`where`, `orderByAscending`, `limit`, ...): the terminal method names the databases read, `...Local` the local database, `...Remote` every remote database, `...All` the local and every remote database (`firstLocal`, `singleRemote`, `toArrayAll`, `countAll`, ...: `database.sets.message.where(...).toArrayAll()`)
- `find(pointerId, id?)`: from the database the pointer targets, `id` defaults to `pointerId` for top level tables
- `related(reference)`: a query like any other (`related(chat.messages).toArrayLocal()`)
- `fetch`: a foreign key to a pointer table loads from the database the pointer targets, other foreign keys load from the local database
- `backload(item, tree, pointerId?)`: a foreign key to a pointer table loads from the database the pointer targets, other foreign keys load from the database the item is stored in
- included pointers (`include`, `includeTree`, `backload`) are replaced by the entity they point to, loaded from the database the pointer targets. in `includeTree` the subtree of a pointer reference describes that entity (`{ fromAccount: { id: true, username: true } }`)
- `create(item)`: top level entities in the local database, they get a pointer to the local database first and share its id. top level entities can not be created in other databases. the databases storing the cohorts the entity references through their pointers get a pointer to it as well, targeting the local database (a chat between an `eu` and a `us` account created in `eu` gets a pointer in `us`)
- `create(pointerId, item)`: cohort members in the database the pointer targets (`create(chatId, message)`). pointers referenced by the item are not copied, so the insert fails if the target database does not know them
- `update(item)`, `update(pointerId, item)`: in the database the item is stored in
- `delete(item)`, `delete(pointerId, item)`: in the database the item is stored in, a top level entity takes its pointer in that database along, unless rows of other cohorts still reference it. a deactivated entity (`active` column) keeps its pointer, as its row is still stored. pointers in other databases are deleted once they are used
- `move(item, target)`: moves the cohort of the top level item to the database tagged `target`. the cohort is replicated to the target database, replacing a fraction left there by an interrupted move, then the pointer is created or updated in the target database, the pointer is updated in the source database (and the local database, when it is neither) and the cohort is deleted from the source database. pointers referenced by the cohort are copied to the target database if it does not know them. rows are copied as they are stored, without audits
- views: local database only, with the plain terminal methods (`first`, `single`, `toArray`, `count`)

### Scoped queries
A query reading a single database runs as it is.
A query reading multiple databases runs in each of them without skip and limit (limited to `skip + limit` when a limit is set), the items are merged, ordered and cut afterwards, `count` sums the counts.
Merged queries can only be ordered by columns of the queried entity (`message => message.created`), ordering through references throws. Strings are compared by their code points, which may differ from the collation of the database. Nulls are ordered like in PostgreSQL (last ascending, first descending), equal items keep the order of their databases (local first).
`single...` throws when the databases hold more than one match in total.

### Item databases
The database an item is stored in is remembered for every item loaded or written through the database (`find`, queries, `related`, included and fetched entities), so `update`, `delete` and `backload` operate on that database.
Items which are not part of a cohort are always stored in the local database, top level items are located by their pointer.
Other cohort members which have not been loaded through the database (created by hand, deserialized) need the pointer id of their cohort (`update(chatId, message)`), passing it always locates the database by the pointer.

The local connection stays open, remote connections are opened on demand and closed after `remoteIdleTimeout`.
