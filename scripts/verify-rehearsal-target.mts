import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireObject } from "./shared/validation.mts";

const root = resolve(import.meta.dirname, "..");
const project = resolve(root, "projects/supabase");
const container = "supabase_db_rehearsal-test-lab-supabase-rehearsal";

const parseEnvironment = (contents: string): Record<string, string> =>
  Object.fromEntries(
    contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator);
        let value = line.slice(separator + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );

const sql = (statement: string) => {
  const result = spawnSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "--no-align",
      "--tuples-only",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--command",
      statement,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "Target SQL failed.");
  return result.stdout.trim();
};

const state = requireObject(
  JSON.parse(
    sql(`
    select json_build_object(
      'accounts', (select count(*) from lab_api.accounts),
      'projects', (select count(*) from lab_api.projects),
      'entries', (select count(*) from lab_api.entries),
      'auditEvents', (select count(*) from lab_api.audit_events),
      'documents', (select count(*) from publication.documents),
      'owners', (
        select count(distinct owner_id) from (
          select owner_id from lab_api.projects
          union all select owner_id from lab_api.entries
          union all select owner_id from lab_api.audit_events
          union all select owner_id from publication.documents
        ) scoped
      ),
      'rawOwnerAbsent', not exists (
        select 1 from lab_api.accounts
        where id = '11111111-1111-4111-8111-111111111111'
      ),
      'pathMatchesOwner', (
        select split_part(avatar_path, '/', 1) = id::text
        from lab_api.accounts
      ),
      'avatarPath', (select avatar_path from lab_api.accounts)
    );
  `),
  ),
  "Supabase target state",
);

const expected = {
  accounts: 1,
  projects: 1,
  entries: 10000,
  auditEvents: 30,
  documents: 2,
  owners: 1,
  rawOwnerAbsent: true,
  pathMatchesOwner: true,
};
for (const [key, value] of Object.entries(expected)) {
  if (state[key] !== value) {
    throw new Error(`Expected ${key}=${value}; received ${state[key]}.`);
  }
}

const runtime = parseEnvironment(
  await readFile(resolve(project, ".rehearsal/runtime.env"), "utf8"),
);
if (!runtime.SUPABASE_URL || !runtime.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("The generated runtime environment is incomplete.");
}
const assetResponse = await fetch(
  `${runtime.SUPABASE_URL}/storage/v1/object/authenticated/private-lab-assets/${state.avatarPath}`,
  {
    headers: {
      authorization: `Bearer ${runtime.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: runtime.SUPABASE_SERVICE_ROLE_KEY,
    },
  },
);
if (!assetResponse.ok) {
  throw new Error(
    `Restored asset download returned HTTP ${assetResponse.status}.`,
  );
}
const expectedAsset = await readFile(
  resolve(project, "assets/approved-avatar.txt"),
);
const actualAsset = Buffer.from(await assetResponse.arrayBuffer());
if (!actualAsset.equals(expectedAsset)) {
  throw new Error("Restored Storage bytes differ from the source fixture.");
}

const insertedId = Number(
  sql(`
    insert into lab_api.entries (
      project_id, owner_id, title, amount, status, details, occurred_on, created_at
    )
    select id, owner_id, 'Runtime sequence proof', 1.00, 'active',
           '{"synthetic":true}'::jsonb, date '2026-01-01', now()
    from lab_api.projects
    returning id;
  `).split("\n", 1)[0],
);
if (!Number.isSafeInteger(insertedId) || insertedId <= 10000) {
  throw new Error(
    `Numeric identity did not advance beyond 10000: ${insertedId}.`,
  );
}

console.log(
  `Rehearsal target verified: 10,034 baseline rows, one sanitized owner, exact Storage bytes, and next identity ${insertedId}.`,
);
