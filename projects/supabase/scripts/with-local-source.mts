import { spawnSync } from "node:child_process";
import { localSupabaseEnvironment } from "../../../scripts/local-supabase.mts";

const source = localSupabaseEnvironment();
const administratorUrl = new URL(source.DB_URL);
administratorUrl.username = "supabase_admin";
const result = spawnSync(
  "npx",
  ["--no-install", "rehearsal", ...process.argv.slice(2)],
  {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env: {
      ...process.env,
      REHEARSAL_SOURCE_ADMIN_URL: administratorUrl.toString(),
      REHEARSAL_SOURCE_STORAGE_URL: source.API_URL,
      REHEARSAL_SOURCE_STORAGE_TOKEN: source.SERVICE_ROLE_KEY,
      REHEARSAL_APPROVED_OWNER_ID: "11111111-1111-4111-8111-111111111111",
    },
  },
);

process.exit(result.status ?? 1);
