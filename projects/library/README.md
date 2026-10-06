# Neighbourhood library

An ordinary lending app: catalog inventory, active loans, and transactional checkout.
Its small synthetic dataset is unrelated to any downstream application.

Start without installing any database rehearsal tool:

```bash
npm ci
docker compose up -d --wait
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.example)"
npm run migrate
npm run seed
npm run dev
```

In another terminal, run `npm test`. The catalog has two books; one is fully on loan.
`POST /loans` checks stock under a database row lock. Requests for a checked-out book
return 409; malformed requests return 400. All examples use synthetic data on localhost.

For migration experiments, add another dated SQL file under `database/migrations`.
The migration command records applied files in the application's own ledger.

To try Rehearsal later, copy this app into a separate project directory first, keeping
the lab's original template clean. In that copy, install an exact package with `npm install --save-dev
/path/to/rehearsal-db-core.tgz`, then use `npx rehearsal init`, `npx rehearsal setup`,
and the public guide. Review the generated configuration, data policy, source access,
and confirmation digests. This app ships with no Rehearsal dependency or configuration.

From the lab root, `npm run adoption:verify -- /path/to/rehearsal-db-core.tgz` tests
that complete adoption in a disposable copy, keeping this original app clean.
