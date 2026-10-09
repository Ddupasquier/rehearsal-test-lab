import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("Supabase source discovery requires every runtime credential and propagates CLI failures", async (context) => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "lab-supabase-environment-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    resolve(directory, "supabase"),
    `#!/usr/bin/env node
if (process.env.LAB_SUPABASE_FAILURE) { console.error("Synthetic Supabase startup failure"); process.exit(1); }
const values = { API_URL: "http://127.0.0.1:58421", DB_URL: "postgresql://synthetic:synthetic@127.0.0.1:58422/postgres", PUBLISHABLE_KEY: "synthetic-publishable-key", SERVICE_ROLE_KEY: "synthetic-fixture-key", INBUCKET_URL: "http://127.0.0.1:58424" };
console.log("# fixture status output");
for (const [key, value] of Object.entries(values)) {
  if (key !== process.env.LAB_SUPABASE_OMIT) console.log(key + "=" + JSON.stringify(value));
}
`,
    { mode: 0o755 },
  );
  const run = (env: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { localSupabaseEnvironment } from "./scripts/local-supabase.mts"; console.log(JSON.stringify(localSupabaseEnvironment()));',
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          ...env,
        },
      },
    );
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), {
    API_URL: "http://127.0.0.1:58421",
    PUBLISHABLE_KEY: "synthetic-publishable-key",
    DB_URL: "postgresql://synthetic:synthetic@127.0.0.1:58422/postgres",
    SERVICE_ROLE_KEY: "synthetic-fixture-key",
    INBUCKET_URL: "http://127.0.0.1:58424",
  });
  for (const key of [
    "API_URL",
    "DB_URL",
    "PUBLISHABLE_KEY",
    "SERVICE_ROLE_KEY",
  ]) {
    const missing = run({ LAB_SUPABASE_OMIT: key });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /expected local API credentials/u);
  }
  const failed = run({ LAB_SUPABASE_FAILURE: "1" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Synthetic Supabase startup failure/u);
});

test("Supabase source discovery accepts the legacy anon-key label", async (context) => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "lab-supabase-environment-legacy-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    resolve(directory, "supabase"),
    `#!/usr/bin/env node
for (const [key, value] of Object.entries({ API_URL: "http://127.0.0.1:58421", DB_URL: "postgresql://synthetic:synthetic@127.0.0.1:58422/postgres", ANON_KEY: "synthetic-anon-key", SERVICE_ROLE_KEY: "synthetic-fixture-key" })) console.log(key + "=" + JSON.stringify(value));
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { localSupabaseEnvironment } from "./scripts/local-supabase.mts"; console.log(JSON.stringify(localSupabaseEnvironment()));',
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).PUBLISHABLE_KEY, "synthetic-anon-key");
});
