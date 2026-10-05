# Safety rules

This repository is disposable; unrelated resources are not.

## Credentials

- Store local credentials in macOS Keychain or ignored owner-only files.
- Tracked files may contain only deliberately public credentials for isolated localhost
  fixtures. Hosted or personal credentials must stay in environment variables or
  ignored owner-only files.
- Local fixture passwords must be visibly synthetic and bind only to loopback ports.
- GitHub Actions credentials belong in environment-scoped repository secrets.
- Rotate a credential immediately if it appears in a terminal transcript or Git diff.

## Data

- Generate all rows deterministically from constants or counters.
- Use reserved example domains such as `example.test` for email-like values.
- Use fixed synthetic UUIDs that cannot be mistaken for real account IDs.
- Never dump, sample, or derive values from BlendCalc production rows.

## Destructive operations

- Confirm the exact project reference, container label, or database name first.
- Preserve stopped containers and volumes unless a scenario explicitly owns them.
- Do not run global Docker pruning from this repository.
- A failed refresh must preserve both the active baseline and edited local runtime.

## Hosted tests

Routine Rehearsal commands and source preparation stay local. Do not create a hosted
project from a script or CI workflow.

If a release eventually needs provider-specific hosted behavior, obtain separate
approval for the exact provider, organization, expected hourly cost, and deletion plan.
Use a restricted reader and reviewed table, column, row, and Storage scopes. Delete the
temporary project as soon as the focused test is complete.
