# Legacy SQL Notes

Files in this directory document historical deployment changes. They are not a
complete Drizzle migration journal and are not executed by the supported setup
flow.

`drizzle/schema.ts` is the schema source of truth. Apply schema changes with:

```bash
pnpm db:push
```

Do not run `drizzle-kit migrate` against this directory.
