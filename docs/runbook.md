# Complete local runbook

Choose one consumer. Supabase covers its local service stack and Storage; ordinary
PostgreSQL proves that the core lifecycle does not depend on Supabase.

This is the future canonical Rehearsal development-acceptance workflow. Record the exact
artifact hash and observed results here first. Until BlendCalc's legacy Rehearsal code is
removed and that removal passes, also complete its focused retirement acceptance. After
that milestone, use BlendCalc or another downstream app only for behavior that cannot be
represented faithfully by these synthetic consumers.

## 0. Verify onboarding from the exact artifact

For normal candidate acceptance, run the complete automated workflow from the lab root:

```bash
npm run candidate:verify -- /absolute/path/to/rehearsal-db-core-*.tgz
```

The command creates and applies one temporary, exact-digest migration in each database. It
fails if any required check is skipped or inconclusive. Its Markdown and JSON reports
appear under `test-results/candidate-acceptance/`. Review the report before asking a
downstream application such as BlendCalc to perform focused consumer-only checks.

The remaining steps document the same lifecycle for investigation and manual testing.
To check onboarding by itself, run this from the lab root before either database
lifecycle:

```bash
shasum -a 256 /absolute/path/to/rehearsal-db-core-*.tgz
npm run onboarding:verify -- /absolute/path/to/rehearsal-db-core-*.tgz
```

The check installs the artifact normally in fresh temporary Supabase and PostgreSQL
projects, so the package-owned install hook is exercised. It also verifies non-destructive
partial-setup recovery and malformed-config preservation. Record the reported SHA-256.

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
