# Lab architecture

The lab has three layers:

1. **Synthetic local sources** model realistic data shapes without recurring hosting
   charges.
2. **Consumer projects** install Rehearsal as an ordinary dependency and use only its
   documented exports and CLI commands.
3. **Acceptance scenarios** prove observable results, including failure cleanup and
   preservation behavior.

This repository is becoming Rehearsal's primary development test consumer. Core CI proves
package contracts; this lab proves the complete user workflow independently of an
application that happens to consume Rehearsal. The transition becomes official only after
BlendCalc removes its remaining legacy Rehearsal code and that removal passes acceptance.

The first provider is local Supabase. Ordinary PostgreSQL is the first independent
source-and-target lifecycle: it prepares scoped access, creates a sanitized baseline,
restores it into a package-owned runtime, runs an application, and proves reset behavior.
Later PostgreSQL services such as Neon, Railway, RDS, or Cloud SQL should be added as
separate consumers only when they expose meaningfully different connection or lifecycle
behavior.

Hosted-provider checks are a narrow release gate, not persistent infrastructure. When a
provider-specific behavior truly requires hosting, create a temporary fixture only with
explicit approval, record its hourly cost boundary, run the focused test, and delete it
immediately. Routine correctness stays local.

Do not treat MySQL, MongoDB, or SQLite as another PostgreSQL provider. Each needs a new
restore and migration contract and should receive its own design before implementation.

## What the synthetic model covers

- UUID account ownership and path rewriting.
- Genuine numeric identity sequences.
- Multiple PostgreSQL schemas.
- Foreign keys, checks, indexes, RLS, triggers, and generated columns.
- Nested JSON, grouped timestamps, immutable history, and publication records.
- Private Storage paths owned by one approved synthetic account.
- Rows belonging to a second account to prove scope and privacy boundaries.

The model borrows _categories of complexity_ discovered in BlendCalc. It does not copy
BlendCalc table names, business rules, or data.

## Downstream applications

Until its legacy integration is removed, BlendCalc remains the final retirement check for
the package-owned replacements. After that milestone, it is useful only for focused
integration checks involving its genuine authentication, authorization, Storage, browser,
or multi-database behavior; it is not required for every Rehearsal change or release. When
a downstream project discovers a reusable defect, add a synthetic reproduction here before
treating the correction as complete whenever that is technically possible.

## Release use

For each candidate:

1. Verify and install the exact tarball without changing the lockfile.
2. Run clean setup in a disposable copy.
3. Run source plan/apply, refresh, reset, migration, application, and cleanup scenarios.
4. Test at least one deliberate failure after useful state exists.
5. Record observed commands, artifact hash, results, and anything not tested.
6. Remove consumer compatibility code only after its replacement passes independently.

During the transition, passing this lab and completing BlendCalc's focused retirement
acceptance are both required before its legacy code is removed. After that removal passes,
this lab becomes the normal Rehearsal release gate. Add a downstream consumer run only when
the candidate changes a contract that the consumer uniquely exercises.
