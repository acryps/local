# Querying
Queries are built like in vlquery (`where`, `include`, `includeTree`, `orderByAscending`, `orderByDescending`, `skip`, `limit`, `page`), the terminal method decides which databases are read.

## Scoped queries
Queries of top level tables name the databases they read in their terminal method:

| Suffix | Reads |
| --- | --- |
| `...Local` | the local database |
| `...Remote` | the remote databases storing the cohorts the local pointer table points to |
| `...All` | both |

Terminal methods: `first`, `single`, `toArray`, `count`, each with every suffix (`firstLocal`, `singleRemote`, `toArrayAll`, `countAll`, ...).

```ts
const chats = await database.sets.chat
	.where(chat => chat.fromAccountId == accountId)
	.orderByDescending(chat => chat.created)
	.limit(20)
	.toArrayAll();
```

Stale pointers met are followed and updated.

### Merging
A query reading a single database runs as it is. A query reading multiple databases runs in each of them without skip and limit (limited to `skip + limit` when a limit is set), the items are merged, ordered and cut afterwards, `count` sums the counts.

- merged queries can only be ordered by columns of the queried entity (`message => message.created`), ordering through references throws
- strings are compared by their code points, which may differ from the collation of the database
- nulls are ordered like in PostgreSQL (last ascending, first descending), equal items keep the order of their databases (local first)
- `single...` throws when the databases hold more than one match in total

## Other queries
Queries of other tables and views read the local database with the plain terminal methods (`first`, `single`, `toArray`, `count`).

```ts
const messages = await database.sets.message.toArray();
```

## Loading entities
| Method | Reads from |
| --- | --- |
| `find(id)` | top level entities: the database their pointer targets, entities not part of a cohort: the local database |
| `find(pointerId, id)` | cohort members: the database the pointer of their cohort targets (`sets.message.find(chatId, messageId)`) |
| `related(reference)` | entities of the cohort of the item: the database the item is stored in (`related(chat.messages)`), entities referencing the pointer of the item (`related(account.sentMessages)`) or not part of a cohort: the local database |
| `fetch(reference)` | a reference to a pointer: the database the pointer targets, a reference within a cohort: the database the cohort is stored in, others: the local database |

`related` returns a query reading a single database (`first`, `single`, `toArray`, `count`).

## Includes
`include`, `includeTree` and `backload(item, tree, pointerId?)` load references to pointers from the database the pointer targets, the subtree applies to that entity. References from other cohorts to the pointer of the item load from the local database, other references from the database the item is stored in.

```ts
const chat = await database.sets.chat
	.includeTree({ fromAccount: { id: true, username: true } })
	.firstAll(chat => chat.id == chatId);
```
