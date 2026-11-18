# ACRYPS LOCAL
Geo-Distributed PostgreSQL Data Management

Multiple PostgreSQL databases with the same schema, used as one database. Rows are grouped into cohorts, each stored in a single database and located through pointer tables. Built on [vlquery](https://www.npmjs.com/package/vlquery).

```sh
npm install @acryps/local
acryps-local create-context
```

```ts
const database = new Database({
	context: DbContext,
	local: { tag: 'eu', host: '...', database: '...', user: '...', password: '...' },
	remotes: [
		{ tag: 'us', host: '...', database: '...', user: '...', password: '...' }
	]
});

await database.connect();

const account = await database.sets.account.find(accountId);
await database.update(account);

const chats = await database.sets.chat.where(chat => chat.fromAccountId == accountId).toArrayAll();

const message = await database.sets.message.find(chatId, messageId);
message.text = 'edited';
await database.update(message);

await database.move(account, 'us');
```

## Documentation
- [Getting Started](documentation/getting-started.md): schema, `vlconfig.json`, CLI, connecting
- [Cohorts](documentation/cohorts.md): pointers, references between cohorts, validation
- [Querying](documentation/querying.md): scoped queries, loading entities, includes
- [Writing](documentation/writing.md): create, update, delete, move
- [API Reference](documentation/api.md)

## License
GPL-3.0-only
