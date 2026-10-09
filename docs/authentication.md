# Authentication acceptance

Test Lab covers Rehearsal authentication without a hosted Supabase project. The database,
Auth service, callback, SMTP inbox, and application all run locally in Docker.

## What is automatic

The exact-package candidate gate verifies:

- email/password sign-in for a synthetic verified user;
- refresh-token rotation;
- a local magic-link request;
- a GitHub-shaped verified identity without contacting GitHub;
- guided copied-account connection, claims, rows, and exact Storage bytes;
- repeated connection, database restart persistence, and reset invalidation.

Synthetic GitHub evidence proves Rehearsal's provider-neutral behavior. It is not evidence
that a person completed a GitHub or Google consent screen.

## One-time Google and GitHub setup

Real OAuth is optional and uses credentials that you create with the provider. It does
not create or link a hosted Supabase project.

From `projects/supabase`:

```bash
cp .env.rehearsal-service.example .env.rehearsal-service.local
chmod 600 .env.rehearsal-service.local
```

Enter the Google and GitHub client IDs and secrets in the ignored local file. Never add
them to the tracked config, shell history, test report, screenshot, or issue.

Register this authorization callback with both providers:

```text
http://127.0.0.1:58341/auth/v1/callback
```

Allow the application to return to:

```text
http://127.0.0.1:5175/auth
http://localhost:5175/auth
```

Google may allow several redirect URIs on one OAuth client. A GitHub OAuth app commonly
has one callback URL, so use the local Auth callback above for the dedicated Test Lab app.
Do not reuse production credentials unless their owner has explicitly reviewed that use.

## Run the human check

The active Test Lab baseline must already exist. From the repository root:

```bash
npm run supabase:auth:doctor
npm run supabase:auth:open
```

Open `http://127.0.0.1:5175/auth`. Test only the providers configured for this local lab:

1. Complete Google sign-in and confirm the page reports a verified local Google session.
2. Sign out, complete GitHub sign-in, and confirm the GitHub session.
3. Sign out, enter a synthetic local email/password account, and confirm the email session.
4. Request a magic link and open it from the local SMTP inbox printed by Supabase status.
5. Refresh each applicable session once, reload the page, then sign out.
6. Press `Ctrl+C` in the terminal and confirm only the application stops.

Provider account selection, consent, MFA, and credentials are performed by the owner.
Rehearsal does not read browser cookies, passwords, passkeys, MFA secrets, or provider
tokens. Record human observations separately from automated assertions.

## Safety and cleanup

- Use only the disposable Test Lab runtime and synthetic local application data.
- Keep the credential file ignored and mode `600`.
- Do not commit generated runtime files or session material.
- `rehearsal stop` preserves local database/Auth state.
- `rehearsal reset` restores the reviewed baseline and invalidates runtime sessions.
- Removing the Test Lab runtime must never remove unrelated containers or volumes.

Real OAuth tests are manual by design. Routine CI must stay credential-free and must not
contact Google, GitHub, or hosted Supabase.

## Quick local email check

To exercise the page without provider credentials or a Rehearsal baseline:

```bash
npm run supabase:start
npm run supabase:reset
npm run supabase:auth:seed
npm run supabase:auth:source
```

Open `http://127.0.0.1:5175/auth` and use the synthetic credentials printed by the seed
command. Password sign-in, refresh, sign-out, and magic-link delivery stay entirely local.
Stop the application with `Ctrl+C`, then run `npm run supabase:stop` when finished.
