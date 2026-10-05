# Supabase consumer

This project uses an isolated local Supabase runtime as its synthetic source and a
separate local runtime as the disposable Rehearsal target. It has no hosted project and
no recurring Supabase compute cost.

## Local schema check

From the repository root:

```bash
npm run supabase:start
npm run supabase:reset
```

## Test an unpublished Rehearsal candidate

```bash
cd projects/supabase
shasum -a 256 /absolute/path/to/rehearsal-db-core-*.tgz
npm install --ignore-scripts --no-save /absolute/path/to/rehearsal-db-core-*.tgz
npx --no-install rehearsal --version
npx --no-install rehearsal
```

Use the guided setup on the first run. Review all generated files before keeping them.
Do not use registry shorthand when acceptance requires an exact candidate artifact.

Source preparation will use a second local runtime on dedicated ports. Its
source/privacy policies and restricted-reader lifecycle must still pass the same review
as a hosted source. Local infrastructure removes cost; it does not weaken the safety
contract.

Do not run `supabase projects create`, `supabase link`, or `supabase db push` as part of
this lab's normal workflow.

The exact source-to-target sequence is documented in the
[complete local runbook](../../docs/runbook.md). Stop the source after retiring
temporary access and before restoring the Rehearsal target; this keeps the two Storage
stacks within the current Colima VM's resource budget.
