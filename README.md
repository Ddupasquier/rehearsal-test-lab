# Rehearsal Test Lab

This private repository is a clean-room consumer of
[`@rehearsal-db/core`](https://www.npmjs.com/package/@rehearsal-db/core). It tests
Rehearsal the way an application developer uses it: through the published or packed
package and its public CLI.

It does **not** contain BlendCalc data, credentials, or private application code. Its
seed is deterministic, synthetic, and intentionally shaped like a demanding real app.

## Testing policy

This lab is being prepared as Rehearsal's primary development and release-validation
environment. It becomes the official primary environment after BlendCalc removes its
remaining legacy Rehearsal code and that removal passes acceptance. New reusable behavior
should already be reproducible here with synthetic data and public package interfaces.

During that transition, BlendCalc remains the required final consumer-retirement check.
Afterward, BlendCalc and other real applications become additional downstream integration
checks used when a change depends on consumer-specific behavior that the lab cannot
faithfully reproduce. A reusable consumer failure should become a synthetic lab regression
whenever practical.

## What lives here

- `projects/supabase` — a fully local synthetic Supabase source and disposable target.
- `projects/postgresql` — an independent PostgreSQL source and consumer lifecycle.
- `docs` — the safety rules, data model, and instructions for adding another provider.
- `scripts` — provider-neutral checks and candidate-install helpers.

Each future database gets its own directory and credentials. A test for one provider
must not depend on another provider being available.

## First check

Use Node.js 22, 24, or 26, Docker or another Docker-compatible engine, and Supabase CLI
2.117.0 or newer.

```bash
nvm use
npm run check
```

The repository has intentionally not been committed yet. Review every file before the
first commit, especially the migrations, synthetic seed, and safety rules.

## Running one consumer

The project-specific guides contain exact commands:

- [Supabase consumer](projects/supabase/README.md)
- [PostgreSQL consumer](projects/postgresql/README.md)
- [Complete local runbook](docs/runbook.md)

For an unpublished Rehearsal candidate, install the exact tarball with `--no-save` in
the selected consumer directory. Always record its SHA-256 in the acceptance report.

## Non-negotiable safety boundary

- Never point routine tests at BlendCalc or another production database.
- Never commit hosted credentials, real owner IDs, or privacy keys. Deliberately public
  localhost fixture credentials must remain synthetic and loopback-only.
- Never copy production rows into this repository.
- Normal tests must not create or contact a hosted Supabase project.
- A hosted-provider check is exceptional, temporary, and separately approved because it
  may incur hourly compute charges.
- Destructive tests may target only resources whose names and labels identify this lab.

See [Lab architecture](docs/architecture.md) and [Safety rules](docs/safety.md).

## Cost model

Routine lab runs use Colima/Docker on this Mac and create no Supabase cloud compute.
The repository intentionally has no linked Supabase project. GitHub Actions may consume
the account's included Actions minutes after the first reviewed commit.
