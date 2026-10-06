# New-user adoption contract

The lab represents a developer adopting Rehearsal for an independent existing app.
BlendCalc is neither the template nor a prerequisite for this acceptance.

The neighbourhood library app has catalog inventory, active loans, and transactional
checkout. It has ordinary `dev`, `test`, `migrate`, and `seed` commands, its own migration
ledger, and a local database. It ships without Rehearsal dependencies, configuration,
source-access declarations, sanitization policies, or private runtime state.

## Acceptance sequence

1. Create a disposable copy; prove the app and database migrations work before installation.
2. Install the exact packed public package with its normal install hook.
3. Use public `init`, `setup` preview, `setup --write`, and `doctor` commands. Preserve the
   existing app. Incomplete setup must identify a failed check and an actionable remedy.
   Exercise the actual wizard in a 120-column, 40-row POSIX terminal: invalid menu choices,
   missing local input files, Ctrl+C cancellation, declined setup, and approved recovery
   of a deliberately removed generated config. Compare project bytes and permissions.
4. Review the generated application commands and declarations. The automation records
   these decisions rather than pretending a starter template is ready to trust.
   Compare approved column, identity, and foreign-key decisions with schema-only source
   evidence, and record the current source/privacy wizard handoff gap.
5. Approve only the small synthetic fixture tables; replace reader labels. Prepare a
   baseline through reviewed source-access digests, retire access, and stop the source.
   Incorrect/stale approvals must create no source roles; unreviewed privacy must not
   activate a baseline. A synthetic sensitive marker must stay in the source, disappear
   from copied artifacts/target, and temporary source privileges must remain restricted.
6. Restore into an isolated target, review an actual new migration, and run the ordinary
   application proofs through the default styled wizard. First decline the migration and
   independently prove its index remains absent; then approve the displayed candidate set.
   Verify sanitized data and the applied index directly in PostgreSQL.
7. Clean only run-owned resources. Keep the original app unchanged and retain reports.

Run `npm run adoption:verify -- /path/to/candidate.tgz`. Candidate and upgrade gates run
this scenario before the prepared profiles. The standalone scenario needs PostgreSQL,
Docker, and Node; it does not need Supabase or another consumer repository.

## Review boundary

Application code contains no Rehearsal imports or conditional behavior. The lab's
`scripts/adoption/review.mts` automates decisions a developer makes after generated setup:
dedicated ports, the app's migration ledger, explicit source scope, privacy rules, and
ordinary application command arguments. It uses the documented configuration API and
public CLI, and never imports Rehearsal implementation modules.

All source rows are invented fixture data. The public row scope in this scenario approves
only those synthetic rows; it is not a declaration that real patrons' loan data is public.
The prepared profiles separately cover owner scoping, UUID pseudonyms, and private assets.

Reports include `initial-guidance.json`, `developer-review.json`, and acceptance verdicts.
Source/schema/diagnostic evidence follows [the source/privacy contract](source-privacy-onboarding.md).
Each terminal session also records observed prompts, sent keystrokes, exit status, and a
readable transcript. The driver waits for prompts instead of sending a prerecorded stream
of answers, and terminates stalled sessions with retained failure evidence.
Successful copies are removed; failures remain local for diagnosis. Layout and unit checks
prevent the original template from acquiring a preinstalled integration.

This checks automated interaction with the real public terminal interface and real
application behavior. It requires Python 3.9+ on macOS/Linux. It does not certify browser
experience, subjective usability, every policy-editor question, authentication integration,
hosted providers, or every application schema. Source-access and privacy declarations are
still explicitly reviewed and prepared through public configuration/CLI outside the wizard;
the test does not claim a wizard-only path from a live source database to a trusted baseline.
