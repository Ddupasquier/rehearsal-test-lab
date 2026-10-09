import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawn as spawnTerminal } from "@lydell/node-pty";
import pg from "pg";
import { runCommand } from "./process.mts";

const { Client } = pg;
const ownerEmail = "guided-owner@rehearsal.test";
const ownerSubject = "github-lab-owner-2048";

const waitForText = async ({
  output,
  exited,
  text,
  timeoutMs = 90_000,
}: {
  output: () => string;
  exited: () => boolean;
  text: string;
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (output().includes(text)) return;
    if (exited()) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `Guided identity session did not reach ${text}: ${output() || "no output"}`,
  );
};

const runConnection = async ({
  project,
  config,
  applicationUrl,
  onSignIn,
  alreadyConnected = false,
}: {
  project: string;
  config: string;
  applicationUrl: string;
  onSignIn?: () => Promise<void>;
  alreadyConnected?: boolean;
}) => {
  const terminal = spawnTerminal(
    resolve(project, "node_modules/.bin/rehearsal"),
    [
      "identity",
      "connect",
      "--identity=lab-owner",
      "--plain",
      `--config=${config}`,
    ],
    {
      name: "xterm-256color",
      cols: 110,
      rows: 40,
      cwd: project,
      env: {
        ...process.env,
        REHEARSAL_LAB_OWNER_SUBJECT: ownerSubject,
      },
    },
  );
  let output = "";
  let exited = false;
  terminal.onData((chunk) => {
    output += chunk;
  });
  const exit = new Promise<{ exitCode: number; signal?: number }>((done) =>
    terminal.onExit((result) => {
      exited = true;
      done(result);
    }),
  );
  try {
    await waitForText({
      output: () => output,
      exited: () => exited,
      text: "SIGN IN TO THE SANDBOX",
    });
    await onSignIn?.();
    await waitForText({
      output: () => output,
      exited: () => exited,
      text: alreadyConnected
        ? "COPIED ACCOUNT — ALREADY CONNECTED"
        : "Connect my copied account using exactly this plan? (y/N)",
    });
    if (!alreadyConnected) {
      terminal.write("y\r");
      await waitForText({
        output: () => output,
        exited: () => exited,
        text: "COPIED ACCOUNT — CONNECTED",
      });
    }
    const response = await fetch(`${applicationUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    terminal.write("\u0003");
    const ended = await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Guided identity shutdown timed out: ${output}`)),
          10_000,
        ),
      ),
    ]);
    assert.equal(ended.exitCode, 0);
    assert.doesNotMatch(output, new RegExp(ownerEmail, "u"));
    assert.doesNotMatch(output, new RegExp(ownerSubject, "u"));
    return output;
  } catch (error) {
    terminal.kill();
    await exit;
    throw error;
  }
};

const cli = ({
  project,
  config,
  args,
}: {
  project: string;
  config: string;
  args: string[];
}) =>
  runCommand(
    resolve(project, "node_modules/.bin/rehearsal"),
    [...args, `--config=${config}`, "--json"],
    {
      cwd: project,
      env: { REHEARSAL_LAB_OWNER_SUBJECT: ownerSubject },
    },
  );

export const exerciseGuidedIdentityConnection = async ({
  project,
  config,
  applicationUrl,
}: {
  project: string;
  config: string;
  applicationUrl: string;
}) => {
  cli({ project, config, args: ["reset"] });
  const runtime = parseEnv(
    await readFile(resolve(project, ".rehearsal/runtime.env"), "utf8"),
  );
  assert.ok(runtime.DATABASE_URL);
  assert.ok(runtime.SUPABASE_URL);
  assert.ok(runtime.SUPABASE_PUBLISHABLE_KEY);
  assert.ok(runtime.SUPABASE_SERVICE_ROLE_KEY);

  const client = new Client({ connectionString: runtime.DATABASE_URL });
  await client.connect();
  const account = await client.query<{ id: string; avatar_path: string }>(
    "select id::text, avatar_path from lab_api.accounts",
  );
  assert.equal(account.rows.length, 1);
  const placeholder = account.rows[0];
  assert.ok(placeholder);
  assert.equal(placeholder.avatar_path, `${placeholder.id}/avatar.txt`);

  const policyPath = resolve(
    project,
    ".rehearsal/candidate-identity-policy.json",
  );
  await writeFile(
    policyPath,
    `${JSON.stringify(
      {
        identityVersion: 1,
        identities: [
          {
            name: "lab-owner",
            matcher: {
              type: "provider-subject",
              provider: "github",
              subjectEnvironmentVariable: "REHEARSAL_LAB_OWNER_SUBJECT",
              approvedSubjectSha256: createHash("sha256")
                .update(ownerSubject)
                .digest("hex"),
            },
            placeholderUserId: placeholder.id,
            references: [
              {
                schema: "lab_api",
                table: "projects",
                column: "owner_id",
                required: true,
                strategy: "transfer",
              },
              {
                schema: "lab_api",
                table: "entries",
                column: "owner_id",
                required: true,
                strategy: "transfer",
              },
              {
                schema: "lab_api",
                table: "audit_events",
                column: "owner_id",
                required: true,
                strategy: "transfer",
              },
              {
                schema: "publication",
                table: "documents",
                column: "owner_id",
                required: true,
                strategy: "transfer",
              },
              {
                schema: "lab_api",
                table: "accounts",
                column: "id",
                required: true,
                strategy: "transfer",
              },
            ],
            jsonReferences: [],
            signupDefaults: [],
            pathReferences: [
              {
                schema: "lab_api",
                table: "accounts",
                column: "avatar_path",
                valueType: "text",
              },
            ],
            assets: [
              {
                bucket: "private-lab-assets",
                prefix: `${placeholder.id}/`,
                rewritePath: true,
              },
            ],
            claims: { lab_role: "owner" },
            tokenHook: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const configPath = resolve(project, config);
  const configSource = await readFile(configPath, "utf8");
  assert.doesNotMatch(configSource, /identityPolicy:/u);
  await writeFile(
    configPath,
    configSource.replace(
      "  runtime: {",
      '  identityPolicy: ".rehearsal/candidate-identity-policy.json",\n\n  runtime: {',
    ),
    { mode: 0o600 },
  );

  await client.query(
    `insert into auth.users (
       instance_id, id, aud, role, email, confirmation_token, recovery_token,
       email_change_token_new, email_change, email_change_token_current,
       phone_change, phone_change_token, reauthentication_token,
       raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous,
       created_at, updated_at
     ) values (
       '00000000-0000-0000-0000-000000000000', $1::uuid,
       'authenticated', 'authenticated', 'copied-owner@rehearsal.invalid',
       '', '', '', '', '', '', '', '',
       '{"provider":"email","providers":["email"]}', '{"rehearsal":true}',
       false, false, now(), now()
     )`,
    [placeholder.id],
  );

  let localUserId = "";
  let passwordSessionVerified = false;
  let refreshVerified = false;
  let magicLinkRequested = false;
  const connectOutput = await runConnection({
    project,
    config,
    applicationUrl,
    onSignIn: async () => {
      const response = await fetch(
        `${runtime.SUPABASE_URL}/auth/v1/admin/users`,
        {
          method: "POST",
          headers: {
            apikey: runtime.SUPABASE_SERVICE_ROLE_KEY!,
            authorization: `Bearer ${runtime.SUPABASE_SERVICE_ROLE_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: ownerEmail,
            password: "Synthetic-test-lab-owner-2026!",
            email_confirm: true,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(response.status, 200);
      const created = (await response.json()) as { id?: unknown };
      assert.equal(typeof created.id, "string");
      localUserId = String(created.id);
      const passwordSession = await fetch(
        `${runtime.SUPABASE_URL}/auth/v1/token?grant_type=password`,
        {
          method: "POST",
          headers: {
            apikey: runtime.SUPABASE_PUBLISHABLE_KEY!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: ownerEmail,
            password: "Synthetic-test-lab-owner-2026!",
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(passwordSession.status, 200);
      const passwordBody = (await passwordSession.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
      };
      assert.equal(typeof passwordBody.access_token, "string");
      assert.equal(typeof passwordBody.refresh_token, "string");
      passwordSessionVerified = true;
      const refreshed = await fetch(
        `${runtime.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        {
          method: "POST",
          headers: {
            apikey: runtime.SUPABASE_PUBLISHABLE_KEY!,
            "content-type": "application/json",
          },
          body: JSON.stringify({ refresh_token: passwordBody.refresh_token }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      assert.equal(refreshed.status, 200);
      const refreshBody = (await refreshed.json()) as {
        access_token?: unknown;
      };
      assert.equal(typeof refreshBody.access_token, "string");
      refreshVerified = true;
      const magicLink = await fetch(`${runtime.SUPABASE_URL}/auth/v1/otp`, {
        method: "POST",
        headers: {
          apikey: runtime.SUPABASE_PUBLISHABLE_KEY!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: ownerEmail,
          create_user: false,
          options: { emailRedirectTo: `${applicationUrl}/auth` },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(magicLink.status, 200);
      magicLinkRequested = true;
      await client.query(
        `insert into auth.identities (
           provider_id, user_id, identity_data, provider,
           last_sign_in_at, created_at, updated_at
         ) values (
           $1, $2::uuid, $3::jsonb, 'github', now(), now(), now()
         )`,
        [
          ownerSubject,
          localUserId,
          JSON.stringify({
            sub: ownerSubject,
            email: ownerEmail,
            email_verified: true,
          }),
        ],
      );
    },
  });
  assert.match(connectOutput, /Transferred images: 1/u);
  assert.match(connectOutput, /Verified provider: github/u);
  assert.equal(passwordSessionVerified, true);
  assert.equal(refreshVerified, true);
  assert.equal(magicLinkRequested, true);

  const transferred = await client.query<{
    account: boolean;
    project_count: number;
    entry_count: number;
    audit_count: number;
    document_count: number;
    receipt: boolean;
    claim: boolean;
  }>(
    `select
       exists(select 1 from lab_api.accounts where id = $1::uuid and avatar_path = $1 || '/avatar.txt') as account,
       (select count(*)::integer from lab_api.projects where owner_id = $1::uuid) as project_count,
       (select count(*)::integer from lab_api.entries where owner_id = $1::uuid) as entry_count,
       (select count(*)::integer from lab_api.audit_events where owner_id = $1::uuid) as audit_count,
       (select count(*)::integer from publication.documents where owner_id = $1::uuid) as document_count,
       exists(select 1 from rehearsal_internal.identity_claims where identity_name = 'lab-owner' and local_user_id = $1::uuid) as receipt,
       exists(select 1 from auth.users where id = $1::uuid and raw_app_meta_data @> '{"lab_role":"owner"}') as claim`,
    [localUserId],
  );
  assert.deepEqual(transferred.rows[0], {
    account: true,
    project_count: 1,
    entry_count: 10000,
    audit_count: 30,
    document_count: 2,
    receipt: true,
    claim: true,
  });
  const expectedAsset = await readFile(
    resolve(project, "assets/approved-avatar.txt"),
  );
  const movedAsset = await fetch(
    `${runtime.SUPABASE_URL}/storage/v1/object/authenticated/private-lab-assets/${localUserId}/avatar.txt`,
    {
      headers: {
        apikey: runtime.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${runtime.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.equal(movedAsset.status, 200);
  assert.deepEqual(Buffer.from(await movedAsset.arrayBuffer()), expectedAsset);

  const repeatedOutput = await runConnection({
    project,
    config,
    applicationUrl,
    alreadyConnected: true,
  });
  assert.match(repeatedOutput, /No transfer was repeated/u);
  await client.end();
  cli({ project, config, args: ["stop"] });
  cli({ project, config, args: ["start"] });
  const restartedOutput = await runConnection({
    project,
    config,
    applicationUrl,
    alreadyConnected: true,
  });
  assert.match(restartedOutput, /No transfer was repeated/u);

  cli({ project, config, args: ["reset"] });
  const resetClient = new Client({ connectionString: runtime.DATABASE_URL });
  await resetClient.connect();
  const reset = await resetClient.query<{
    placeholder: boolean;
    connected: boolean;
    receipt_table: string | null;
  }>(
    `select
       exists(select 1 from lab_api.accounts where id = $1::uuid) as placeholder,
       exists(select 1 from lab_api.accounts where id = $2::uuid) as connected,
       to_regclass('rehearsal_internal.identity_claims')::text as receipt_table`,
    [placeholder.id, localUserId],
  );
  await resetClient.end();
  assert.deepEqual(reset.rows[0], {
    placeholder: true,
    connected: false,
    receipt_table: null,
  });
  await access(policyPath);
  return {
    provider: "github",
    passwordSessionVerified,
    refreshVerified,
    magicLinkRequested,
    transferredRows: 10034,
    transferredAssets: 1,
    repeatedConnectionSafe: true,
    databaseRestartPersistent: true,
    resetInvalidatedReceipt: true,
  };
};
