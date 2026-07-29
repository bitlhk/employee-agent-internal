# Legacy SQL Notes

Files in this directory document historical deployment changes. They are not a
complete Drizzle migration journal and are not executed by the supported setup
flow.

These files must never be registered retroactively or replayed against an existing database.

The managed migration chain starts at the current baseline in `drizzle/managed/`. Apply it with:

```bash
pnpm db:deploy
```

`drizzle/schema.ts` remains the application schema source. `db:push` is limited to an empty, unbaselined development database; production changes require a new immutable SQL file in `drizzle/managed/`.
