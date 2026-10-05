import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localSupabaseEnvironment, root } from "./local-supabase.mts";

const { API_URL: apiUrl, SERVICE_ROLE_KEY: serviceRoleKey } =
  localSupabaseEnvironment();
const assets = [
  {
    source: "projects/supabase/assets/approved-avatar.txt",
    object: "11111111-1111-4111-8111-111111111111/avatar.txt",
  },
  {
    source: "projects/supabase/assets/control-avatar.txt",
    object: "22222222-2222-4222-8222-222222222222/avatar.txt",
  },
];

for (const asset of assets) {
  const body = await readFile(resolve(root, asset.source));
  const response = await fetch(
    `${apiUrl}/storage/v1/object/private-lab-assets/${asset.object}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "content-type": "text/plain",
        "x-upsert": "true",
      },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(`Asset upload failed with HTTP ${response.status}.`);
  }
}

console.log(`Seeded ${assets.length} synthetic local Storage objects.`);
