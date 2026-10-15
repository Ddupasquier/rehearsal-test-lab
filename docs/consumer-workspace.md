# Open a real application alongside Test Lab

This optional workspace puts Test Lab and an existing application's Rehearsal dashboard
in one VS Code window. Each project keeps its own configuration, installed package,
approved local baseline, ports, and runtime. No new Rehearsal feature is needed.

It is a link to the application's existing sandbox—not a copied or separately isolated
Test Lab environment. Ordinary Lab acceptance stays independent and synthetic.

## Create the workspace

The existing application must already have `package.json` and `rehearsal.config.mjs`
at its root, a locally installed Rehearsal package, and a reviewed local baseline.
The generator checks only bounded local metadata; it does not execute the configuration,
inspect environment files, install dependencies, contact a source, or start services.

From the Test Lab root, after its normal tooling installation:

```bash
npm run consumer:workspace -- /absolute/path/to/your-application
```

Open the reported `.code-workspace` file in VS Code. It lives under the ignored
`test-results/consumer-workspaces/` directory and contains local folder paths only.
Review workspace trust normally. Existing workspace files are never overwritten.

The workspace lists three independent roots:

- **Test Lab · PostgreSQL** — the synthetic PostgreSQL application.
- **Test Lab · Supabase** — the synthetic Supabase application.
- **Consumer · your-application** — the real application's existing Rehearsal integration.

All roots use their own root `rehearsal.config.mjs`. This first version deliberately
refuses a consumer with only a nested configuration; it does not move reviewed settings
or create a competing config. Follow the package's configuration-relocation guidance
separately if relocation is desired.

## Open the full application

1. Choose **Rehearsal: Open Dashboard** from the Command Palette and select the consumer.
   In a multi-project window, choose deliberately; dashboards do not open automatically.
2. Check the project name, configuration, baseline, runtime state, and local address.
3. If an existing verified sandbox is available, choose **Open sandbox**. Rehearsal uses
   that project's declarative application command and dependent targets.
4. Open the application address reported by Rehearsal and use its normal UI.
5. Close the foreground application with **Ctrl+C**. Use the consumer's explicit **Stop**
   action when its databases are no longer needed; this preserves its local data.

The equivalent public CLI, from the consumer's directory, is:

```bash
npx --no-install rehearsal doctor --plain
npx --no-install rehearsal status --plain
npx --no-install rehearsal open --plain
```

If the runtime has never been created, follow the dashboard's setup and baseline guidance.
Creating or resetting it can replace sandbox edits and apply candidate migrations:
review the exact plan and digest first. The workspace generator never performs that step.
Starting a stopped verified runtime is distinct from restoring its baseline.

## Follow the consumer's environment guide

Select **Consumer · your-application** and consult that project's maintained environment
or development guide. Its configuration and documentation own the sandbox application
address, database targets, authentication, account association, privacy policies and
runtime settings.

Use the sandbox URL reported by that project's Rehearsal dashboard. Check it against
the consumer's guide so it is not confused with a source, QA or production-connected
application. Do not reuse Test Lab's ports or assume another project's target count,
database provider or sign-in method. The workspace generator does not choose those
settings, duplicate their contracts or copy provider credentials.

This is a supplementary real-consumer check. It shares that consumer's sandbox edits
and operation locks, so coordinate with anyone already testing that project. Do not
reset, claim, discard, install a replacement package, or prepare source data merely to
open the UI. The workspace does not grant those permissions.

## Resource and privacy boundaries

- Opening this file does not start Docker, Colima, PostgreSQL, Supabase, or an app.
- Read-only dashboard inspection uses each root's installed public CLI after normal
  workspace-trust checks. Package versions can differ; this is not candidate acceptance.
- Run only the environment you need. A consumer with two targets can need more memory
  than the Lab's single PostgreSQL container; do not run every scenario simultaneously.
- Never copy real consumer rows, keys, credentials or application code into tracked Lab
  fixtures. Existing approved baselines remain with their owning project.
- Lab cleanup owns only Lab resources. It must not discard the linked consumer's data,
  stop a shared Docker engine, or prune other projects' containers, images or volumes.

See [Lab architecture](architecture.md), [safety](safety.md), and the
[local runbook](runbook.md) for independent acceptance and cleanup.
