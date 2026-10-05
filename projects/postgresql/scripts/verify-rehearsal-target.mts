import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { requireObject } from "../../../scripts/shared/validation.mts";

const { Client } = pg;
const project = resolve(import.meta.dirname, "..");

const environment = Object.fromEntries(
  (await readFile(resolve(project, ".rehearsal/runtime.env"), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

if (!environment.DATABASE_URL) {
  throw new Error("The generated runtime environment has no DATABASE_URL.");
}

const client = new Client({ connectionString: environment.DATABASE_URL });
await client.connect();

try {
  const { rows } = await client.query<{ state: unknown }>(`
    select json_build_object(
      'accounts', (select count(*)::integer from lab_api.accounts),
      'entries', (select count(*)::integer from lab_api.entries),
      'documents', (select count(*)::integer from publication.documents),
      'owners', (
        select count(distinct owner_id)::integer from (
          select owner_id from lab_api.entries
          union all select owner_id from publication.documents
        ) as scoped
      ),
      'rawOwnerAbsent', not exists (
        select 1 from lab_api.accounts
        where id = '11111111-1111-4111-8111-111111111111'
      ),
      'syntheticAccount', exists (
        select 1 from lab_api.accounts
        where display_name = 'Synthetic Lab Owner'
          and email like 'rehearsal+%@example.invalid'
      ),
      'generatedTitlesValid', not exists (
        select 1 from lab_api.entries where normalized_title <> lower(title)
      )
    ) as state;
  `);
  const state = requireObject(rows[0]?.state, "PostgreSQL target state");
  const expected = {
    accounts: 1,
    entries: 10000,
    documents: 2,
    owners: 1,
    rawOwnerAbsent: true,
    syntheticAccount: true,
    generatedTitlesValid: true,
  };

  for (const [key, value] of Object.entries(expected)) {
    if (state[key] !== value) {
      throw new Error(`Expected ${key}=${value}; received ${state[key]}.`);
    }
  }

  const inserted = await client.query<{ id: string | number }>(`
    insert into lab_api.entries (owner_id, title, amount, details, created_at)
    select id, 'Runtime sequence proof', 1.00, '{"synthetic":true}'::jsonb, now()
    from lab_api.accounts
    returning id;
  `);
  const insertedId = Number(inserted.rows[0]?.id);
  if (!Number.isSafeInteger(insertedId) || insertedId <= 10000) {
    throw new Error(
      `Numeric identity did not advance beyond 10000: ${insertedId}.`,
    );
  }

  console.log(
    `PostgreSQL Rehearsal target verified: 10,003 baseline rows, one sanitized owner, multiple schemas, generated columns, and next identity ${insertedId}.`,
  );
} finally {
  await client.end();
}
