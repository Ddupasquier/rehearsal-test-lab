import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  localSupabaseEnvironment,
  root,
  runLabSql,
} from "./local-supabase.mjs";

const summary = runLabSql(`
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
    ),
    'nextIdentitySafe', (
      select last_value >= (select max(id) from lab_api.entries)
      from lab_api.entries_id_seq
    )
  );
`);
const counts = JSON.parse(summary);
const expected = {
  accounts: 2,
  entries: 10003,
  documents: 3,
  approvedEntries: 10000,
  controlEntries: 3,
  nextIdentitySafe: true,
};

for (const [key, value] of Object.entries(expected)) {
  if (counts[key] !== value) {
    throw new Error(`Expected ${key}=${value}; received ${counts[key]}.`);
  }
}

const { API_URL: apiUrl, SERVICE_ROLE_KEY: serviceRoleKey } =
  localSupabaseEnvironment();
const expectedAsset = await readFile(
  resolve(root, "projects/supabase/assets/approved-avatar.txt"),
);
const response = await fetch(
  `${apiUrl}/storage/v1/object/authenticated/private-lab-assets/11111111-1111-4111-8111-111111111111/avatar.txt`,
  {
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
  },
);
if (!response.ok) {
  throw new Error(`Asset download failed with HTTP ${response.status}.`);
}
const actualAsset = Buffer.from(await response.arrayBuffer());
if (!actualAsset.equals(expectedAsset)) {
  throw new Error(
    "The downloaded Storage object did not match its source bytes.",
  );
}

console.log(
  `Local Supabase verified: ${counts.entries} rows, two owner scopes, numeric identity state, and exact Storage bytes.`,
);
