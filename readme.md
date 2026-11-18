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

## Context
`acryps-local create-context` reads the database configured in the `vlconfig.json` (like vlquery) and creates the context.
Pointer tables are not part of the context: a foreign key to a pointer references the table the pointer points to (`chat.fromAccount` is a `ForeignReference<Account>`, `account.fromChats` a `PrimaryReference<Chat>`).
References to pointers can not be used in queries (`where`, `orderBy...`), as the referenced rows may be stored in another database. Their columns can (`chat => chat.fromAccountId == accountId`).

The sets of top level tables are `RootSet`s, the sets of the other tables of cohorts `MemberSet`s, the cohort structure is described in `DbContext.$$cohorts`, which `new Database(...)` reads.

`acryps-local compile` compiles the queries like `vlquery compile`, including the filters passed to `firstLocal`, `singleAll`, ...

### Validation
`acryps-local create-context` parses the database structure into cohorts and stops with an error listing every problem found, without writing the context:
- a pointer table points to an existing table, whose id references the pointer
- a pointer table consists of an `id` with a default, of the type of the id of the table it points to, and a `target` of type `text`, it references no other tables
- a table belongs to one cohort at most, as its rows are stored in one database
- a table of a cohort has an id of type `uuid`, as its rows are created in and moved between databases (sequences would collide)
- a top level table references the tables of other cohorts through their pointer tables

## Operations
- queries of top level tables (`where`, `orderByAscending`, `limit`, ...): the terminal method names the databases read, `...Local` the local database, `...Remote` the remote databases storing the cohorts the local pointer table points to, `...All` both (`firstLocal`, `singleRemote`, `toArrayAll`, `countAll`, ...: `database.sets.chat.where(...).limit(20).toArrayAll()`). stale pointers met are followed and updated
- queries of other tables (`first`, `single`, `toArray`, `count`): the local database (`database.sets.message.toArray()`)
- `find(id)`: top level entities from the database their pointer targets, entities which are not part of a cohort from the local database
- `find(pointerId, id)`: cohort members from the database the pointer of their cohort targets (`database.sets.message.find(chatId, messageId)`)
- `related(reference)`: a query reading a single database (`first`, `single`, `toArray`, `count`). entities of the cohort of the item from the database the item is stored in (`related(chat.messages)`), entities referencing the pointer of the item (`related(account.sentMessages)`) or not part of a cohort from the local database
- `fetch(reference)`: a reference to a pointer loads from the database the pointer targets, a reference within a cohort from the database the cohort is stored in, other references from the local database
- `include`, `includeTree`, `backload(item, tree, pointerId?)`: references to pointers load from the database the pointer targets, the subtree applies to that entity (`{ fromAccount: { id: true, username: true } }`). references from other cohorts to the pointer of the item load from the local database, other references from the database the item is stored in
- `create(item)`: top level entities in the local database, they get a pointer to the local database first and share its id. top level entities can not be created in other databases. the databases storing the cohorts the entity references through their pointers get a pointer to it as well, targeting the local database (a chat between an `eu` and a `us` account created in `eu` gets a pointer in `us`)
- `create(pointerId, item)`: cohort members in the database the pointer targets (`create(chatId, message)`). pointers referenced by the item are not copied, so the insert fails if the target database does not know them
- `update(item)`, `update(pointerId, item)`: in the database the item is stored in
- `delete(item)`, `delete(pointerId, item)`: in the database the item is stored in, a top level entity takes its pointer in that database along, unless rows of other cohorts still reference it. a deactivated entity (`active` column) keeps its pointer, as its row is still stored. pointers in other databases are deleted once they are used
- `move(item, target)`: moves the cohort of the top level item to the database tagged `target`. the cohort is replicated to the target database, replacing a fraction left there by an interrupted move, then the pointer is created or updated in the target database, the pointer is updated in the source database and the cohort is deleted from the source database. other databases still point to the source database until their pointers are used. pointers referenced by the cohort are copied to the target database if it does not know them. rows are copied as they are stored, without audits
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
