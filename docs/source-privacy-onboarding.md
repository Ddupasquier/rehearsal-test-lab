# Source and privacy onboarding acceptance

This is the consumer-side acceptance contract for the next Rehearsal onboarding
improvement. It does not implement a replacement wizard inside the lab.

## Starting point

A developer has the ordinary library app, a working local PostgreSQL database, and no
pre-exported records or migration-ledger JSON. They install the exact package and open
its public guide. The app's source and commands must remain ordinary throughout adoption.

## Evidence gathered today

`npm run adoption:verify -- /path/to/candidate.tgz` now also:

- Reads schema metadata, identities, and foreign keys from the owned synthetic source.
  This evidence contains no row values. Independently checks that the reviewed export
  and privacy decisions cover the actual selected columns and structural constraints.
- Records the observed guide menu and its request for pre-exported records/ledger files.
- Refuses an incorrect source approval and a stale approval after a reviewed permission
  duration changes. Independently checks that neither creates reader roles/export views.
- Checks the approved temporary reader cannot become superuser, create databases/roles,
  read the raw loans table, or write books; it can read the approved export view.
- Refuses baseline export while privacy is marked unreviewed. No active baseline or
  persisted sensitive marker may result.
- Inserts a synthetic sensitive marker into the source reader label. The reviewed
  replacement must keep it out of all regular baseline artifact files and the target,
  while preserving the original source value. Retirement must remove temporary roles,
  views, and the ignored reader credential.

Reports add `schema-review-evidence.json`, `source-onboarding-assessment.json`, and
`source-privacy-guardrails.json`. A supported adoption can pass its safety checks while
the source-wizard assessment reports `gap-observed`; that distinction is intentional.

The observed beta.13/beta.14 paths still require the lab's explicit configuration review.
The initial guide asks for local export files rather than offering the complete live-source
review path. Recoverable approval/privacy failures are also labeled `INTERNAL_FAILURE`
with generic doctor guidance. These are evidence for upstream work, not claimed fixes.

## Required future public experience

1. Offer a clear path for copying an approved app database as well as a local-files path.
2. Explain source access before obtaining credentials or inspecting schema. Use ignored
   local credential input; keep secrets and row values out of prompts and support reports.
3. Show schema-only table/column facts, generated identities, foreign keys, and the app's
   migration ledger. Propose structural facts without guessing privacy intent.
4. Ask for explicit table/column scope and privacy decisions. Unselected data stays out;
   an incomplete review cannot produce a trusted baseline. Reader-label replacement is
   the library fixture's concrete privacy expectation.
5. Preview source permissions and bounds. Decline/cancel leaves the app and source
   unchanged. Modified declarations or schema invalidate approval and require fresh review.
6. Apply only reviewed access, create the sanitized copy, retire temporary access, and
   guide the developer to a successful app rehearsal.
7. Report user-correctable mistakes as actionable review/approval problems, with precise
   next steps. Preserve the last valid state when a step fails.

Once the public package provides this path, extend the real-terminal driver to exercise
those prompts and remove the corresponding handwritten declarations from the primary
new-user scenario. Merely finding a new menu label or a different error code is not enough
to certify the experience. The lab must still verify the resulting database and privacy
effects independently.

This contract is local and synthetic. It does not authorize hosted-provider access or
claim that real patrons' loan data is public. Authentication, production access approval,
and provider-specific rights need separate scenarios.
