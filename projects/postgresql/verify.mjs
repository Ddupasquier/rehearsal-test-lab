import { spawnSync } from "node:child_process";

const container = "rehearsal-test-lab-postgresql";
const sql = `
  select json_build_object(
    'accounts', (select count(*) from lab_api.accounts),
    'entries', (select count(*) from lab_api.entries),
    'documents', (select count(*) from publication.documents),
    'approvedEntries', (
      select count(*) from lab_api.entries
      where owner_id = '11111111-1111-4111-8111-111111111111'
    ),
    'controlEntries', (
      select count(*) from lab_api.entries
      where owner_id = '22222222-2222-4222-8222-222222222222'
    )
  );
`;
const result = spawnSync(
  "docker",
  [
    "exec",
    container,
    "psql",
    "--no-align",
    "--tuples-only",
    "--username",
    "rehearsal_lab",
    "--dbname",
    "rehearsal_lab",
    "--command",
    sql,
  ],
  { encoding: "utf8" },
);
if (result.status !== 0)
  throw new Error(result.stderr || "PostgreSQL check failed.");

const actual = JSON.parse(result.stdout.trim());
const expected = {
  accounts: 2,
  entries: 10003,
  documents: 3,
  approvedEntries: 10000,
  controlEntries: 3,
};
for (const [key, value] of Object.entries(expected)) {
  if (actual[key] !== value) {
    throw new Error(`Expected ${key}=${value}; received ${actual[key]}.`);
  }
}

console.log(
  `Ordinary PostgreSQL verified: ${actual.entries} rows across two owner scopes and two schemas.`,
);
