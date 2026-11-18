# Writing

## Create
`create(item)` creates top level entities and entities not part of a cohort in the local database. A top level entity gets a pointer to the local database first and shares its id. Top level entities can not be created in other databases.

The databases storing the cohorts the entity references through their pointers get a pointer to it as well, targeting the local database (a chat between an `eu` and a `us` account created in `eu` gets a pointer in `us`).

```ts
const account = new Account();
account.username = 'alice';

await database.create(account);
```

`create(pointerId, item)` creates cohort members in the database the pointer targets. Pointers referenced by the item are not copied, so the insert fails if the target database does not know them.

```ts
const message = new Message();
message.chatId = chatId;
message.text = 'hello';

await database.create(chatId, message);
```

## Update
`update(item)` and `update(pointerId, item)` write to the database the item is stored in.

## Delete
`delete(item)` and `delete(pointerId, item)` delete from the database the item is stored in. A top level entity takes its pointer in that database along, unless rows of other cohorts still reference it. A deactivated entity (`active` column) keeps its pointer, as its row is still stored. Pointers in other databases are deleted once they are used.

## Move
`move(item, target)` moves the cohort of a top level item to the database tagged `target`:
1. the cohort is replicated to the target database, replacing a fraction left there by an interrupted move
2. the pointer is created or updated in the target database
3. the pointer is updated in the source database
4. the cohort is deleted from the source database

Other databases still point to the source database until their pointers are used. Pointers referenced by the cohort are copied to the target database if it does not know them. Rows are copied as they are stored, without audits.

```ts
await database.move(account, 'us');
```

## Item databases
The database an item is stored in is remembered for every item loaded or written through the database (`find`, queries, `related`, included and fetched entities), so `update`, `delete` and `backload` operate on that database.

Items not part of a cohort are always stored in the local database, top level items are located by their pointer. Other cohort members not loaded through the database (created by hand, deserialized) need the pointer id of their cohort (`update(chatId, message)`), passing it always locates the database by the pointer.
