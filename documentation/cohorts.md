# Cohorts
A cohort is a set of rows stored together in one database. Its top level table (`account`) has a pointer table (`account__pointer`), the other tables of the cohort (`picture`) reference the top level table, directly or through other tables of the cohort.

## Pointers
A pointer table `<table>__pointer (id, target)` names the database a cohort is stored in by its tag. The top level row shares the id of its pointer.

Pointers are looked up in the local database and written without audits. A pointer is followed through the pointers of the databases it targets until one targets itself, which is the database the cohort is stored in.

A move only updates the pointers of the databases it involves, so other databases may still target the database the cohort left (`EU → US → AP`). When such a stale pointer is used, it is updated to target the database the cohort is stored in (`EU → AP`).

When the path ends in a database without the pointer, the cohort has been deleted and the used pointer is deleted as well, unless rows still reference it.

## References between cohorts
Tables reference other cohorts through their pointer tables, never directly, as the referenced rows may be stored in another database.

```sql
CREATE TABLE chat__pointer (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target text);
CREATE TABLE chat (
	id uuid PRIMARY KEY REFERENCES chat__pointer (id),
	from_account_id uuid REFERENCES account__pointer (id),
	to_account_id uuid REFERENCES account__pointer (id)
);
CREATE TABLE message (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_id uuid REFERENCES chat (id), text text);
```

Pointer tables are not part of the context: a foreign key to a pointer references the table the pointer points to (`chat.fromAccount` is a `ForeignReference<Account>`, `account.fromChats` a `PrimaryReference<Chat>`).

References to pointers can not be used in queries (`where`, `orderBy...`), their columns can (`chat => chat.fromAccountId == accountId`).

## Sets
| Set | Tables | Queries read |
| --- | --- | --- |
| `RootSet` | top level tables | local, remote or all databases ([scoped](querying.md#scoped-queries)) |
| `MemberSet` | other tables of a cohort | local database |
| `DbSet` | tables not part of a cohort | local database |

The cohort structure is generated into `DbContext.$$cohorts`, which `new Database(...)` reads.

## Validation
`acryps-local create-context` stops with an error listing every problem found, without writing the context:
- a pointer table points to an existing table, whose id references the pointer
- a pointer table consists of an `id` with a default, of the type of the id of the table it points to, and a `target` of type `text`, it references no other tables
- a table belongs to one cohort at most, as its rows are stored in one database
- a table of a cohort has an id of type `uuid`, as its rows are created in and moved between databases (sequences would collide)
- a top level table references the tables of other cohorts through their pointer tables
