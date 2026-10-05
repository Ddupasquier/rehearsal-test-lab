import { spawnSync } from "node:child_process";

const result = spawnSync(
  "npx",
  ["--no-install", "rehearsal", ...process.argv.slice(2)],
  {
    cwd: new URL("..", import.meta.url),
    stdio: "inherit",
    env: {
      ...process.env,
      REHEARSAL_SOURCE_ADMIN_URL:
        "postgresql://rehearsal_lab:local-synthetic-only@127.0.0.1:55432/rehearsal_lab",
      REHEARSAL_APPROVED_OWNER_ID: "11111111-1111-4111-8111-111111111111",
    },
  },
);

process.exit(result.status ?? 1);
