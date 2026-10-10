# Expansion coverage and development workflow

The lab consumes an exact packed public package. Add observable assertions in this
repository rather than importing Rehearsal implementation modules. Keep data synthetic,
scope access explicitly, and verify database results independently of CLI success.

The primary consumer is an ordinary library lending app that works before installation.
Start with clean adoption and user-visible guidance; use the prepared profiles for
additional coverage. No downstream application defines this lab's architecture or readiness.

## Current coverage and next additions

| Contract             | Implemented coverage                                                                                                                      | Next scenario                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Package installation | Exact hash and installed bytes; unsafe archives; fresh onboarding and partial recovery; same-consumer upgrade with preserved state        | Expand verified version pairs as public contracts evolve                              |
| Source access        | Reviewed scope, pseudonymization, retirement, private asset copy                                                                          | Interrupted refresh must preserve the last valid baseline and retire temporary access |
| Privacy identity     | Numeric values and canonical signed-integer dictionary keys retain one namespaced mapping across key rotation                             | Add other cross-representation joins when their public contracts land                 |
| Restore              | PostgreSQL and Supabase, multiple schemas, identities, generated columns, exact asset bytes                                               | Corrupt baseline and interrupted restore must fail without touching the source        |
| Migration            | One confirmed candidate per provider                                                                                                      | Failing migration; modified candidate after confirmation; explicit retry behavior     |
| Application          | HTTP readiness and real data proofs; fail closed without database; guided synthetic GitHub account connection and restart/reset behavior  | Multi-target and human hosted-provider observations where separately required         |
| Authentication       | Local email/password, refresh, reload, sign-out, token-hash magic link, synthetic GitHub identity, and optional human Google/GitHub OAuth | Add another provider only when its reusable configuration contract is reviewed        |
| Cleanup              | Confirmation-based target removal, ownership refusal, unrelated sentinel preservation                                                     | Interrupt a full run after useful state exists and verify recovery                    |
| Concurrency          | Independent workspace/install/IDs/port blocks; serialized Supabase phase                                                                  | Repeat paired full runs on shared development machines                                |
| Performance          | Stage and total durations, package bytes, runner peak RSS                                                                                 | Larger deterministic datasets and measured Docker/child-process memory                |

The next-scenario column is a backlog, not a claim that these checks already run.
The previous manual stale-confirmation and injected-failure investigations should become
repeatable scenarios before those features expand further.

## Acceptance contract for a feature owner

Copy this checklist into the feature issue or PR before implementation:

- **Public change:** command/configuration behavior and supported provider(s).
- **Compatibility:** previous supported version/configuration and behavior to preserve.
- **Fixture:** smallest synthetic data model that exposes the change.
- **Positive result:** exact rows, bytes, schema, application response, or runtime state.
- **Failure result:** deliberate fault, expected refusal/recovery, and state that must survive.
- **Resources:** required runtimes, expected dataset size, and whether Supabase is needed.
- **Evidence:** artifact SHA-256, acceptance and isolation reports, and any untested contract.

A feature is ready for release when its scenario is repeatable from the packed artifact,
its independent assertions pass, and cleanup succeeds. A generic happy-path acceptance
run does not prove a new feature that has no scenario yet.

## Efficient work tiers

Internal task routing and cross-session recovery use the globally installed `dev-task`;
the [central working-context owner](/Users/dylandupasquier/Development/codex-task-router/docs/working-context.md)
defines checkpoint commands, storage, and recovery boundaries. Resume from the relevant
task or exact revision, using a lab-specific task suffix when chats share this worktree.
Reconcile that historical record with the current checkout, these lab contracts, and the
existing project tracker. Product documentation, release evidence, and task ownership stay
here; recovery records neither grant permission nor form a second queue. There is no
background observer—agents explicitly read and save context as verified state changes.

1. Every change: `npm run check` (compiler, layout/credential checks, independent tests).
2. During implementation: use the relevant synthetic consumer and focused scenario.
3. Release candidate: clean library adoption runs first inside `npm run candidate:verify -- /absolute/path/to/candidate.tgz`.
   Require both report verdicts; record unsupported or deliberately omitted scenarios.
4. Compatibility expansion: `npm run upgrade:verify -- /path/to/previous.tgz /path/to/candidate.tgz`.
   The same consumer must work before and after installation; both exact hashes and
   preserved-state checks are reported.

GitHub runs fast checks on Node 22/24/26 plus PostgreSQL, published adoption, and onboarding.
Unpublished artifacts still require explicit local selection. Heavy Supabase runs stay
local and serialize; routine work creates no hosted Supabase compute.

## Isolation and recovery

The wrapper copies Git's non-ignored file inventory, including uncommitted source changes,
but excludes generated candidate-probe migrations. It never copies ignored dependencies,
credentials, baselines, runtime directories, or report output. Only local resource names,
ports, and their source-policy fingerprints are rebound; reviewed relation/asset scopes
stay the same. Supabase project IDs remain below its 40-character limit.

Port leases live in the operating system temporary directory under
`rehearsal-test-lab-leases/ports-<base>/owner.json`. Supabase's shared slot has its own
`supabase/owner.json`. Inspect the recorded process/workspace before removing a stale lease;
the lab never assumes elapsed time means an owner is gone. Unrelated programs can still
claim a port between the availability check and runtime startup; that causes a reported
failure rather than reuse of another run's identity.

`workspace-snapshot.json` records the files and hashes used by the run, including the
rebound configuration. Successful workspace deletion unlocks only directories inside
that snapshot to remove immutable baseline generations; it does not follow symlinks.

Signals forwarded to the worker trigger outer cleanup after it exits. An abrupt machine
shutdown or forced kill can leave resources and leases; use `isolation.json` and ownership
labels to investigate. Failed workspaces contain ignored synthetic credentials: keep them
local and delete them when diagnosis is complete. No global Docker prune is used.

Timing and package-size measurements are evidence, not performance gates yet. Runner RSS
excludes subprocess and Docker memory; establish repeated measurements before setting
budgets or comparing different hardware.
