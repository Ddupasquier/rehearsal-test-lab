# Ordinary PostgreSQL consumer

This project is both a synthetic PostgreSQL source and an ordinary Rehearsal consumer.
It proves the complete copy, sanitize, restore, application, and reset lifecycle without
Supabase services or metadata.

```bash
npm run postgresql:start
npm run postgresql:verify
```

It initializes the same synthetic owner scopes, 10,003-row stress shape, numeric
identity, generated column, JSON, and publication schema used by the Supabase consumer.
It remains runnable without Supabase.

For a complete Rehearsal candidate run, install the exact tarball in this directory,
then follow the [PostgreSQL runbook](../../docs/runbook.md#ordinary-postgresql-lifecycle).

If Docker Compose is unavailable on another machine, use
`npm run postgresql:fallback:start` and `npm run postgresql:fallback:stop` instead.

Stop the container without deleting its volume:

```bash
npm run postgresql:stop
```

Delete the named volume only during an explicitly approved clean-start scenario.
