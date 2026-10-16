# Complete local runbook

Start with the independent library app adoption scenario. It represents a developer
bringing an existing working application to Rehearsal for the first time:

```bash
npm run adoption:verify -- /absolute/path/to/candidate.tgz
```

The additional Supabase and PostgreSQL profiles cover demanding provider and data cases.
They do not depend on BlendCalc's architecture or retirement work. Record lab evidence
independently; use downstream applications only for focused consumer-specific checks.

## 0. Verify onboarding from the exact artifact

Install the TypeScript tooling and run the fast checks from the repository root first:

```bash
npm ci --ignore-scripts
npm run check
```

For normal candidate acceptance, run the complete automated workflow from the lab root:

```bash
npm run candidate:verify -- /absolute/path/to/rehearsal-db-core-*.tgz
```

The command creates and applies one temporary, exact-digest migration in each database. It
fails if any required check is skipped or inconclusive. Its Markdown and JSON reports
appear under `test-results/candidate-acceptance/`. Review the report before asking a
downstream application such as BlendCalc to perform focused consumer-only checks.

When the installed package advertises foreground idle controls, acceptance also exercises
the explicit activity contract on PostgreSQL: real busy work, a full 30-second quiet
window, owned application shutdown, and a non-destructive runtime stop. It verifies that
container/volume identities, database counts and a sandbox edit survive. Missing or
regressed activity refusal belongs to the core tests; this stage does not claim Google
consent, browser-user inactivity, or a host-wide background scheduler.

Acceptance now runs in a private snapshot with dedicated installs, resource names, and
ports. Require both `acceptance.json` and `isolation.json` to pass. The snapshot inventory
and exact tarball remain with the reports. PostgreSQL work can overlap; heavy Supabase
phases wait for a shared resource slot. See [Expansion coverage](expansion-coverage.md)
for the feature acceptance contract and recovery instructions.

The remaining steps document the same lifecycle for investigation and manual testing.
For your own clean hands-on run, start with [Try PostgreSQL yourself](manual-postgresql.md).
It reserves separate ports and resource identities instead of changing a shared consumer.
To open a real application's existing dashboard beside the synthetic Lab projects, use
the optional [consumer workspace](consumer-workspace.md); its data remains consumer-owned.
For a runtime/service-profile change, also run `npm run resources:verify -- /path/to/candidate.tgz`.
Require `profiles.json` and `isolation.json` to pass. The profiles run sequentially with
unique ports and ownership; compare startup and CPU/memory samples on equivalent
hardware and distinguish any new image downloads. This does not replace application,
Auth, Storage, or migration acceptance.
For a focused inventory/lifecycle change, select one profile through the same guarded
wrapper:

```bash
npm run resources:verify -- /path/to/candidate.tgz --profile=postgresql
```

The default still runs PostgreSQL, Supabase `application`, and Supabase `full` in order.
Both reports name the planned profiles; `profiles.json` also identifies omitted profiles.
A focused pass does not certify those omitted providers or service profiles.
The runner asserts the public `resources --json` target/provider/configuration binding,
created/running/stopped/absent classification, persistent retention even with
`lifecycle.run: "stop-after-run"`, recorded baseline/version metadata, and configured
loopback ports. Receipt compatibility describes format/provider evidence only; ports
are configured values, and resource age does not prove user inactivity.
For the exact published rc.7 artifact, Supabase's receipt omits its provider: the
runner requires `unknown / provider-not-recorded`, while still checking baseline,
checksum, and recorded writer version. Other artifacts do not inherit this exception.

Each selected profile reviews an exact `stop-stale` plan, stops it without deleting its
container/volume identities, restarts and verifies the baseline, then discards only that
owned environment. Independent database queries require all 100 rows and a deliberate
sandbox edit to survive restart, with identical volume names and creation timestamps.
PostgreSQL retains its container ID; Supabase may recreate service containers on start.
The PostgreSQL profile additionally changes its disposable cutoff
configuration and creates a never-started, independently test-labelled ownership-conflict
container. Both invalidate the original confirmation without stopping the original
workload. All image-declared volume paths use tmpfs for that conflict control. Exact-ID
cleanup rechecks its test label, stopped state and pinned engine before removal; no
shared engine or unrelated resource is stopped or pruned.

Before startup, the runner also checks required-service refusals through the installed
CLI using disposable configuration copies. PostgreSQL must refuse Auth; the application
profile must refuse Realtime; full must refuse a disabled or ambiguous Realtime template.
Tool doubles allow only the synthetic context reads needed to reach those guards.
This proves refusal wiring, not a running full-profile service. Supabase profiles must
also retain the configured mail service. Reviewed files and the baseline stay unchanged.
These executable refusal fixtures currently require macOS/Linux process ownership;
they do not establish Windows acceptance.

Startup timings include fresh containers, health checks, and restoring 100 synthetic
rows. Image-cache changes cannot be attributed to a profile on a shared engine.
Short container samples do not measure VM startup, host memory, or application load.

Those manual commands use the shared consumer directories and fixed ports; avoid running
multiple manual sessions against the same consumer.
To check onboarding by itself, run this from the lab root before either database
lifecycle:

```bash
shasum -a 256 /absolute/path/to/rehearsal-db-core-*.tgz
npm run onboarding:verify -- /absolute/path/to/rehearsal-db-core-*.tgz
```

The check installs the artifact normally in fresh temporary Supabase and PostgreSQL
projects, so the package-owned install hook is exercised. It also verifies non-destructive
partial-setup recovery and malformed-config preservation. Record the reported SHA-256.

### Engine ownership guards without a real VM

```bash
node --import tsx scripts/verify-engine-ownership.mts /absolute/path/to/candidate.tgz
```

This installs the exact package in an isolated consumer and exercises public commands
against strict simulated Docker/Colima tools. It checks startup receipts, guarded stop,
ownership refusals, interruption, target order, and concurrent-operation refusal without
starting or stopping a real engine. Read `test-results/engine-ownership/<run>/engine-ownership.json`;
require a passing verdict and successful owned-process cleanup.

A pass does not prove real VM shutdown or memory release. Those observations need a
separately authorized exclusive test environment. This executable simulation supports
macOS/Linux; Windows refuses before installation rather than using a shell fallback.

## Supabase lifecycle

This workflow uses two local runtimes:

- **Source:** `rehearsal-test-lab` on ports `58421` and `58422`.
- **Target:** Rehearsal-owned runtime on ports `58341` and `58342`.

Running both full stacks together can exceed the current Colima VM resources. Keep the
source running only while preparing a baseline, then stop it before restoring the target.

## 1. Start and verify the synthetic source

```bash
npm run supabase:start
npm run supabase:assets
npm run supabase:verify
```

`supabase:assets` is safe to repeat. It updates only two lab-owned synthetic objects.

## 2. Install the exact Rehearsal build

```bash
cd projects/supabase
shasum -a 256 /absolute/path/to/rehearsal-db-core-*.tgz
npm install --ignore-scripts --no-save --package-lock=false \
  /absolute/path/to/rehearsal-db-core-*.tgz
npx --no-install rehearsal --version
```

Use `--no-save` and `--package-lock=false` for candidate acceptance. Published-version
upgrade tests should update the manifest and lockfile only in a disposable copy.

## 3. Prepare the source copy

Create the ignored privacy key once:

```bash
npx --no-install rehearsal privacy key --write --plain
```

Preview access and copy the full confirmation digest from the output:

```bash
npm run source:local -- source plan --plain
npm run source:local -- source apply \
  --confirm-source-access=<full-digest> --plain
npm run source:local -- baseline refresh --plain
```

The expected active baseline has:

- 10,034 rows across five tables;
- exactly one pseudonymized owner;
- 10,000 owner-scoped entries;
- one private Storage object with exact bytes.

Zero rows is a failure even if the CLI exits successfully; it usually means the local
RLS export policy is incomplete.

## 4. Retire access and stop the source

Preview retirement and copy its full confirmation digest:

```bash
npm run source:local -- source retire --plain
npm run source:local -- source retire \
  --confirm-source-retirement=<full-digest> --plain
cd ../..
npm run supabase:stop
```

Retirement must remove the temporary reader, owner role, views, and ignored credential.
Stopping the source preserves its local data while freeing resources for the target.

## 5. Restore and exercise the target

```bash
cd projects/supabase
npx --no-install rehearsal doctor --plain
npx --no-install rehearsal reset --plain
cd ../..
npm run rehearsal:verify-target
```

The independent target check verifies row scope, UUID/path pseudonym agreement, exact
Storage bytes, and an automatically generated numeric ID greater than 10,000.

Open the application for a manual session:

```bash
cd projects/supabase
npx --no-install rehearsal open --plain
```

Use `Ctrl+C` once to close only the app. The database should remain available. Run
`rehearsal reset` again to prove the target returns to exactly 10,000 entries.

## 6. Stop without deleting

```bash
npx --no-install rehearsal stop --plain
```

This stops the Rehearsal runtime while preserving the baseline and disposable runtime
data. Cleanup and deletion remain separate preview-first operations.

## Ordinary PostgreSQL lifecycle

The PostgreSQL source uses Docker Compose on `127.0.0.1:55432`. Its Rehearsal target
uses `127.0.0.1:58642`; the test application uses `127.0.0.1:5176`.

Start and independently verify the synthetic source:

```bash
cd ../..
npm run postgresql:start
npm run postgresql:verify
cd projects/postgresql
```

Install the exact candidate using the commands from step 2 above. Then create the
ignored privacy key once and run the preview-first source flow:

```bash
npx --no-install rehearsal privacy key --write --plain
npm run source:local -- source plan --plain
npm run source:local -- source apply \
  --confirm-source-access=<full-digest> --plain
npm run source:local -- baseline refresh --plain
npm run source:local -- source retire --plain
npm run source:local -- source retire \
  --confirm-source-retirement=<full-digest> --plain
```

The baseline must contain 10,003 rows across three tables: one pseudonymized account,
10,000 entries, and two publication documents. Retirement must remove the temporary
roles, export views, and ignored credential.

Stop the source before starting the target, then restore and verify it:

```bash
cd ../..
npm run postgresql:stop
cd projects/postgresql
npx --no-install rehearsal doctor --plain
npx --no-install rehearsal reset --plain
npm run verify:target
npx --no-install rehearsal verify --plain
```

`verify:target` checks row scope, pseudonymization, multiple schemas, a generated
column, and an automatically generated ID above 10,000. It deliberately inserts one
row. Exercise the application, stop it once with `Ctrl+C`, and restore the baseline:

```bash
npx --no-install rehearsal open --plain
npx --no-install rehearsal reset --plain
npx --no-install rehearsal stop --plain
```

After the second reset, `lab_api.entries` must contain exactly 10,000 rows. Stopping
preserves both the immutable baseline and the disposable runtime data.

## Version changes

Also run the isolated upgrade gate with two exact artifacts:

```bash
npm run upgrade:verify -- /path/to/previous.tgz /path/to/candidate.tgz
```

Review both verdicts under `test-results/upgrade-acceptance/`. This proves preserved
configuration and baseline access plus existing runtime data, reset, migrations,
application behavior, and cleanup in the same upgraded consumer.
