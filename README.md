# Rehearsal Test Lab

This private repository is a clean-room consumer of
[`@rehearsal-db/core`](https://www.npmjs.com/package/@rehearsal-db/core). It tests
Rehearsal the way an application developer uses it: through the published or packed
package and its public CLI.

## Guiding rule

**Test Lab represents a new developer adopting Rehearsal for their own application.
Its domain, schema, application code, and acceptance criteria are independent of BlendCalc.**

The primary consumer is a neighbourhood library lending app. It runs, migrates, and
passes its own tests before Rehearsal is installed. Adoption then uses the exact public
package, generated setup, explicit developer review, source-access confirmations, and
ordinary application proofs. Success must not require another application's repository,
integration code, credentials, or retirement milestone.

The larger PostgreSQL and Supabase profiles remain additional regression coverage for
privacy, Storage, identities, provider behavior, and upgrades. Their prepared configurations
are not a substitute for a new user's first experience. A reusable downstream failure can
be reproduced synthetically here without copying that consumer's schema or business logic.

## What lives here

- `projects/library` — the primary, ordinary app with no preinstalled Rehearsal integration.
- `projects/supabase` — a fully local synthetic Supabase source and disposable target.
- `projects/postgresql` — an independent PostgreSQL source and consumer lifecycle.
- `docs` — the safety rules, data model, and instructions for adding another provider.
- `scripts` — provider-neutral checks and candidate-install helpers.

Each future database gets its own directory and credentials. A test for one provider
must not depend on another provider being available.

## First check

Use Node.js 22, 24, or 26, Python 3.9+ on macOS/Linux for terminal tests, and Docker or another Docker-compatible engine. The additional
Supabase regression profile also requires Supabase CLI 2.117.0 or newer.

```bash
nvm use
npm ci --ignore-scripts
npm run check
```

`npm run check` runs strict TypeScript checking, lab layout and credential checks, and
the database-independent regression tests. CI runs these checks on Node.js 22, 24, and 26.

## Primary new-user adoption check

```bash
npm run adoption:verify -- /absolute/path/to/rehearsal-db-core.tgz
```

This first proves the ordinary library app works without Rehearsal, including migrations,
HTTP tests, and a successful checkout. It then installs the exact package normally,
checks public init/setup guidance, reviews generated declarations, prepares a sanitized
baseline, and rehearses a real library migration using the same application commands.
Independent database assertions verify sanitization and the applied index.

The original app remains clean. Reports, initial guidance, and developer review decisions
live under `test-results/adoption/`. No BlendCalc dependency or source access is involved.
The guide is exercised in real pseudo-terminals: numbered-input recovery, missing-file
guidance, styled cancellation, declined and approved setup, and a styled rehearsal with
explicit migration confirmation. Source-access and privacy review remain explicit steps
outside the wizard. Browser usability and human user studies are separate checks.
Read [the adoption contract](docs/new-user-adoption.md).

Candidate and upgrade acceptance run this primary scenario first, followed by the additional
profiles. GitHub's published-adoption job also runs it against the published beta.

## TypeScript development

Lab scripts and fixture applications use ESM TypeScript (`.mts`). Commands load them
with `node --import tsx`, including the temporary application wrappers used during
candidate acceptance. Install the locked root development tools before running commands
from either consumer directory; there is no separate build step or checked-in compiled
output.

The TypeScript settings follow Rehearsal's strict NodeNext conventions: strict checking,
exact optional properties, checked indexed access, and unknown caught errors. Run
`npm run typecheck` for the compiler alone, or `npm test` for the regression tests.

The public `rehearsal.config.mjs` entry points remain executable JavaScript and are
included in typechecking against `@rehearsal-db/core`'s published declarations. The root
lockfile pins the tooling and the public configuration contract; exact candidate installs
remain isolated in each consumer's ignored dependencies and do not modify this lockfile.

## Running one consumer

The project-specific guides contain exact commands:

- [Supabase consumer](projects/supabase/README.md)
- [PostgreSQL consumer](projects/postgresql/README.md)
- [Complete local runbook](docs/runbook.md)

For an unpublished Rehearsal candidate, install the exact tarball with `--no-save` in
the selected consumer directory. Always record its SHA-256 in the acceptance report.

Before starting either database lifecycle, verify first-install behavior in unrelated
temporary Supabase and PostgreSQL projects:

```bash
npm run onboarding:verify -- /absolute/path/to/rehearsal-db-core-*.tgz
```

This leaves the lab projects untouched. It checks automatic root configuration,
preservation of existing ignore rules and malformed configs, and recovery of a missing
generated Supabase runtime file.

GitHub Actions runs this boundary against the currently published `beta` package. An
unpublished candidate must still be supplied locally by exact path and checksum; the lab
does not download unreviewed artifacts from another repository automatically.

## One-command candidate acceptance

Use the full runner before proposing a Rehearsal release:

```bash
npm run candidate:verify -- /absolute/path/to/rehearsal-db-core-*.tgz
```

It verifies the artifact checksum and installed bytes, fresh onboarding, both complete
database lifecycles, one exact-digest candidate migration per database, application
proofs, numeric identity correspondence between values and canonical integer dictionary
keys, exact-confirmation cleanup, and preservation of unrelated Docker resources. It
writes a readable Markdown report and a machine-readable JSON report below
`test-results/candidate-acceptance/`.

Each run snapshots the lab and exact tarball into its own workspace. Package installs,
privacy keys, baselines, migrations, Docker identities, and ports are independent of your
checkout and other acceptance runs. Existing local lab services and volumes are untouched.
PostgreSQL phases can overlap; Supabase phases share a machine-wide resource slot so two
heavy stacks do not compete for memory. These leases coordinate lab runs, not other tools.

Successful runs remove their workspace and run-owned Docker resources. Failed workspaces
remain for diagnosis. Both `acceptance.json` and `isolation.json` must pass: the latter
records artifact identity, runtime bindings, and outer cleanup. A Docker cleanup failure retains
the port lease so the ports cannot be reused by another lab run. Reports and the exact
tarball remain under `test-results/candidate-acceptance/`.

See [Expansion coverage](docs/expansion-coverage.md) for implemented checks, the next
scenarios, and an acceptance contract for feature owners.

## Version upgrade acceptance

```bash
npm run upgrade:verify -- /absolute/path/to/previous.tgz /absolute/path/to/candidate.tgz
```

Supply two exact artifacts: the previous supported release and a newer candidate.
The lab builds working PostgreSQL and Supabase consumers with the previous release,
then installs the candidate into those same directories with its normal install hook.
It verifies existing runtime data before resetting, then repeats baseline restore,
confirmed migrations, independent database checks, application proofs, and cleanup.
Configuration, privacy keys, immutable baseline files and permissions, and the active
baseline pointer must remain unchanged. Both versions and checksums are recorded;
same-version replacements and downgrades are rejected.

Require both reports under `test-results/upgrade-acceptance/` to pass. This compatibility
gate complements fresh candidate acceptance. The scoped UUID fixture requires a previous
release of beta.13 or newer: beta.12 cannot restore this profile. Older releases are
refused before installing either consumer. Passing one version pair does not certify
all releases or configurations.

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
