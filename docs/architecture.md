# Lab architecture

The lab has three layers:

1. **Synthetic local sources** model realistic data shapes without recurring hosting
   charges.
2. **Consumer projects** install Rehearsal as an ordinary dependency and use only its
   documented exports and CLI commands.
3. **Acceptance scenarios** prove observable results, including failure cleanup and
   preservation behavior.

The primary scenario is an independent new user's adoption, using an ordinary library
lending app with no preinstalled Rehearsal dependency or configuration. It must first work
on its own, then succeed through the package's public onboarding and rehearsal workflow.
Core CI proves package contracts; this lab proves the consumer experience without relying
on BlendCalc or another application to define readiness.

The primary app uses ordinary PostgreSQL. The additional Supabase and PostgreSQL profiles test a demanding
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

## Primary app and additional regression profiles

The primary library app uses integer book and loan IDs, inventory limits, a transactional
checkout, and its own migration ledger. Its ordinary HTTP tests work unchanged against
the source and the sanitized target. It has no account-owner model or private Storage stack.

The additional profiles cover:

- UUID account ownership and path rewriting.
- Genuine numeric identity sequences.
- Multiple PostgreSQL schemas.
- Foreign keys, checks, indexes, RLS, triggers, and generated columns.
- Nested JSON, grouped timestamps, immutable history, and publication records.
- Private Storage paths owned by one approved synthetic account.
- Rows belonging to a second account to prove scope and privacy boundaries.

The library app models stock and lending transactions rather than any downstream
application's domain. Its SQL, source, tests, and normal commands contain no Rehearsal
integration. Adoption-specific review belongs to the lab runner and its evidence, and is
created only after installation and public setup.

## Downstream applications

BlendCalc and other real consumers are optional, focused integration signals. Their
schemas, business rules, internal adapters, and retirement milestones do not define the
lab's primary scenario or block an independent new user's acceptance. Translate reusable
failure categories into distinct synthetic scenarios rather than copying consumer code.

## Release use

For each candidate:

1. Verify and install the exact tarball without changing the lockfile.
2. Run clean setup in a disposable copy.
3. Run source plan/apply, refresh, reset, migration, application, and cleanup scenarios.
4. Test at least one deliberate failure after useful state exists.
5. Record observed commands, artifact hash, results, and anything not tested.
6. Remove consumer compatibility code only after its replacement passes independently.

Run clean new-user adoption before the prepared regression profiles. Record the artifact
hash, guidance, explicit review decisions, observed application results, and limitations.
A new feature needs its own observable scenario even when adoption and existing regressions
pass. Downstream consumer checks can supplement this evidence for consumer-specific behavior.
