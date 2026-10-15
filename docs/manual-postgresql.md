# Try PostgreSQL yourself

**Every new test round starts fresh.** Prepare a new isolated session; never reuse the
shared `projects/postgresql` directory or a previous round as its starting point. Each
round has a new project copy, empty database state, dependency tree, privacy key,
baseline location, runtime identity and reserved ports. Your original Lab databases,
baselines and keys remain untouched. No BlendCalc or Supabase is needed for this round.

Stop/start within one round deliberately preserves state so you can test persistence.
Starting fresh means creating the next isolated session, not silently wiping an older
one. Never delete another session's resources or lease to obtain a clean start.

## Prepare once

From the Test Lab root, use its maintained Node version and install the tooling:

```bash
nvm use 24
npm ci --ignore-scripts
node --version
docker version
docker compose version
```

If you do not use nvm, select your existing Node.js 24 installation another way before
continuing. This guide does not install or change your runtime automatically.

Start your existing Docker-compatible engine explicitly if it is stopped. Do not stop a
shared engine, install a new runtime or remove containers to make this test work. The
fixture needs `postgres:17-alpine`; Docker Compose may download it when you explicitly
start the source. The two databases run sequentially, one container at a time.

Prepare with the exact package tarball and its complete reviewed SHA-256:

```bash
node --import tsx scripts/manual-postgresql.mts prepare /absolute/path/to/candidate.tgz FULL_SHA256
```

Preparation validates the artifact and creates a private directory under
`test-results/manual-postgresql/`, with unique ports, container names and a reserved
port lease. It does **not** install dependencies, start services or run database commands.
Symbolic-link redirects in the Lab/output/lease paths are refused. The private artifact
copy must match the reviewed hash before it is inspected or any ports are leased.

Open the printed **MANUAL-POSTGRESQL.md**. Its commands use your session's actual paths
and cover installation, source preparation, sanitization, baseline creation, application
proofs, browser use, restart and safe shutdown. Open the printed workspace in VS Code if
you want to try the extension too.

## What “from zero” means

This session begins without runtime data, a baseline, a privacy key or installed project
dependencies. Test Lab supplies a small application, synthetic source schema, and reviewed
fixture configuration/policies so you can test PostgreSQL without inventing a privacy
policy for real customer data. It is not a claim that live-source onboarding is wizard-only.
The separate [new-user adoption scenario](new-user-adoption.md) covers installing Rehearsal
into an initially unconfigured application.

The PostgreSQL application is a simple read-only summary page, not the BlendCalc UI.
Successful baseline counts are 10,003 rows across three tables. There are initially no
candidate migrations, so this walkthrough alone does not prove applying a new migration.

## Your first editor session

For an **extension-only manual round**, the test operator can install the exact candidate
and prepare the synthetic baseline first, leaving the target runtime uncreated. The
tester then starts at **Overview → Create sandbox** and uses extension actions for
restore, application launch, migrations, verification and stop. The integrated terminal
may display CLI output or guided prompts; the tester need not type commands. Record
installation/source preparation as fixture setup, not manual onboarding acceptance.
This keeps Lab scaffolding out of the product test without inventing editor capabilities.

Keep the generated **MANUAL-POSTGRESQL.md** open beside this page: it owns the commands
and your actual application address. This page owns the editor workflow and checklist.

### 1. Open the right project

Open the new session's **`workspace/projects/postgresql`** folder in VS Code, not the Lab
root or the shared consumer. A prepared single-folder `.code-workspace` is equivalent.
Explorer should show `package.json`, `rehearsal.config.mjs`, `database/`, `app/`, and
`infrastructure/`.

Review Workspace Trust normally. Open the Command Palette (**Cmd+Shift+P** on macOS),
then **Rehearsal: Open Dashboard**. The sidebar also has a dashboard button at its top
and an **Open Rehearsal dashboard** row; do not rely on clicking a dropdown heading.

Initial missing-package/baseline guidance is expected. Do not use a registry install or
update button when testing an unpublished candidate: install the exact tarball in
generated step 1 instead. A candidate may display the same version as a published build;
its checksum and exact-file check distinguish it.

### 2. Install, discover, and review

Use **Terminal → New Terminal**, then follow generated step 1. Its installation check
must say **Exact installed package match**. Core-package changes should update the
dashboard without reloading the window. Loading must be visible while inspection runs.

On **Project setup**, inspect the Project Profile:

- **Detected** contains facts with local evidence.
- **Suggested** contains proposals, not automatic decisions.
- **Your decision** identifies choices such as privacy and source access.

Check the project, PostgreSQL target, migration directory, application/proof commands,
active root configuration and local address. Missing source preparation or baseline data
must produce an actionable next step—not a successful readiness result.

The fixture supplies reviewed synthetic configuration and policies; you are not designing
production sanitization from scratch. Genuine initially-unconfigured installation/setup
is covered separately by the library-app adoption scenario below.

### 3. Prepare the synthetic copy

Follow generated step 2: start and verify the local source, create the privacy key, review
the source plan, apply its **complete** digest, refresh the baseline, review retirement,
retire with its digest, then stop the source.

Expect **10,003 baseline rows across three tables**. Extra control rows in the source are
intentional and must not all enter the approved copy. Never share connection URLs,
privacy keys, credential files or baseline rows in reports or screenshots.

After commands typed manually in another terminal, use **Rehearsal: Refresh Project
Overview** once. There is no permanent polling of private runtime/baseline files.
Editor-started operations have their own bounded activity/completion refresh.

### 4. Create and open the sandbox

Use generated step 3 or Overview's **Create sandbox** action. Review the editor's exact
command before approving it. Creating a runtime restores its baseline; it differs from
opening an existing sandbox. Require successful application proof and verification.

Then choose **Open sandbox** or follow generated step 4. Leave that terminal running and
open the reported browser address. Expect **1 account**, **10,000 entries** and
**2 publication documents**. `/summary` shows the same aggregates as JSON.

Press **Ctrl+C once** to close the app, then open it again. Ordinary reopen must not
restore the baseline or erase edits. Do not use `reset` merely to reopen an app. Test
**Ctrl+Z** in a separate open trial: it should exit cleanly, not leave a suspended
launcher. Use **Stop** to stop the database without deleting its data.

## Test the new workbench features

Close the foreground application before migration/configuration tests. A running
foreground operation can legitimately hold the project lock and block other changes.

| Page               | Try this                                                         | Passing result                                                             |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Overview           | Inspect readiness, baseline, migrations, runtime and next action | Values match the actual lifecycle; unavailable never means ready           |
| Project setup      | Expand detected/suggested/decision evidence                      | Project-local facts are explained; sensitive choices remain yours          |
| Migrations         | Search, target/status/date filters and each sort                 | Visible rows change; the complete ordered approval digest does not         |
| Environments       | Change View target/View profile; open a local address            | A display selection is not a reset, another database or server-port change |
| Data & auth        | Inspect active baseline scope, shape and provider guidance       | Only reviewed aggregate evidence appears; unsupported Auth is explained    |
| Configuration      | Review a harmless diff, cancel, then deliberately apply          | Cancel changes nothing; approval changes only proposed settings            |
| Activity & reports | Inspect stages/receipts, compare and export a redacted report    | Observed results stay distinct from unknown, stale or unavailable evidence |

### Review and run a real migration

Follow generated step 5 to create its one index migration. Before executing it:

1. Open **Migrations**; expect exactly the new filename.
2. Search for a matching name, then a nonmatching name. Clear the search.
3. Change **Target**, **Status**, **Sort**, **From date**, and **Through date**; restore
   filters that show the candidate.
4. Check/uncheck its review checkbox. That checklist does not authorize a partial
   migration set or reorder dependencies.
5. Review the plan, decline once, and confirm no success was recorded.
6. Approve the current complete digest; require proof/verification and inspect Activity.
   `run` restores the baseline first, intentionally replacing earlier sandbox edits.

Do not modify immutable baseline migration history. An applied candidate may remain in
the reviewed candidate set; one rehearsal does not promote it into baseline history.

### Names, profiles, configuration and resources

With the project idle:

1. In **Local Resources → Environments**, enter a **Friendly name**. Use **Review name &
   protection**, cancel once, then review/apply a deliberate change. The immutable
   Docker/project ID must not be renamed.
2. Enable **Protect this environment's data** and inspect its explanation. Turn it off
   through another reviewed change if you later want to test discard.
3. Use **Save a named project profile** and **Review profile diff**. A profile containing
   `primary` is a saved view of this target—not another runtime or baseline copy.
4. In Configuration, expand **All supported structured settings** and change
   `cleanup.retainBaselineGenerations` from 2 to 3 there. Review the exact diff; it
   should show only that setting. Apply deliberately, then restore 2 through another
   review. The simpler form also submits only settings you actually change; opening or
   reviewing it must not insert untouched defaults. Always inspect the proposed diff.
5. In **Environments**, inspect **Retained verified baselines**. A fresh round has only
   its newly created generation; an unavailable comparison must explain what is missing.
6. **Open a local address** may point the browser to `/summary`; it does not rebind the
   app, health endpoint or Auth callback. An external/non-loopback address must be refused.
7. Browse **All resources**, **Environments**, **Data volumes**, **Images**, and **Other
   projects**. Try search, filters, sorting and **Show largest first**. Other projects
   remain read-only; unknown sizes are not zero or guaranteed reclaimable space.
8. Inspect in-use/protected explanations and an image-cleanup preview if candidates
   exist, then **Cancel**. Never delete shared images or volumes just to complete a test.
   An image is a software template; a volume contains persistent data.

The manual generator keeps the reviewed config as a plain literal so these structured
edits are testable. Expression-based configs remain a separate refusal case: the editor
must not guess how to rewrite them.

### Layout, loading, accessibility and cancellation

- Visit all seven pages at wide, medium and narrow widths. Check the narrow connection
  card and filtered migration list. Nothing should escape a card, and the compact header
  selector must actually navigate.
- Try light, dark and high-contrast themes and larger zoom. Tab through controls, use
  Enter/Space to activate them, and Escape to dismiss menus/dialogs. Focus must remain
  visible. Actual VoiceOver spoken output is a separate observation, not a CSS pass.
- Refresh should display loading, preserve proven information where appropriate and
  offer cancellation. A timeout must explain Retry/settings/Doctor/support instead of
  leaving an unexplained dash or clipped `Unavailable`.
- For visual-only loading/missing/timeout/busy cases, the extension's maintained
  `npm run preview` exposes `/loading`, `/missing`, `/timeout`, `/progress`, and
  `/progress-unavailable`. Sample-data previews cannot certify actual database actions.
- Cancel only an editor-started operation. Do not signal a process merely discovered
  in another terminal/project. Inspect actual final state afterward; missing exit
  evidence is not successful verification.

## Finish the broader round

Stop the manual app and databases with generated step 6 **before** heavier automated
profiles. From the original Lab root, using the same reviewed tarball:

```bash
npm run adoption:verify -- /absolute/path/to/candidate.tgz
npm run candidate:verify -- /absolute/path/to/candidate.tgz
npm run resources:verify -- /absolute/path/to/candidate.tgz
```

Each creates a fresh isolated workspace. Adoption proves the independent library app
works before Rehearsal installation and exercises real setup. The candidate gate already
includes adoption: its standalone command is diagnostic, not a requirement to run the
same scenario twice. Candidate/resource reports must pass isolation and teardown, not
only exit zero.

Supabase uses more memory than this PostgreSQL session. Its resource slot coordinates
Lab runs, not other applications. Wait or coordinate if unrelated stacks are active;
never stop them or the shared engine automatically. Respect capacity refusals.

PostgreSQL alone cannot certify Google consent, Supabase Storage, multiple real targets,
every service profile, opt-in shaping, or positive foreground-idle shutdown. The automated
scenarios cover implemented synthetic cases; record skipped/refused stages honestly.
Genuine consent needs the separately reviewed [authentication workflow](authentication.md).
No BlendCalc or hosted database is needed for ordinary Lab acceptance. Upgrade acceptance
requires two **different** reviewed versions, not same-version private candidates.

## Keep or clean up

The walkthrough's stop commands preserve your session data and never stop the shared
engine. Keep its workspace and port lease together if you want to return. The receipt
`manual-session.json` records exact resource identities; do not remove a lease while its
resources may be restarted.

There is deliberately no automatic “delete everything” command in this manual setup.
Use the existing reviewed Rehearsal discard flow when you explicitly decide to delete
its target. Source-volume deletion needs its own exact ownership review. For unattended
temporary-resource cleanup, use [candidate acceptance](runbook.md#0-verify-onboarding-from-the-exact-artifact)
instead; that runner owns and removes its disposable resources.
