import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const supabaseProject = resolve(root, "projects/supabase");

export function localSupabaseEnvironment() {
  const result = spawnSync(
    "supabase",
    ["status", "--workdir", supabaseProject, "--output", "env"],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr || "The local Supabase runtime is not running.",
    );
  }

  const environment = {};
  for (const line of result.stdout.split("\n")) {
    const match = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
    if (match) environment[match[1]] = match[2];
  }

  if (!environment.API_URL || !environment.SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase did not report the expected local API credentials.",
    );
  }
  return environment;
}

export function runLabSql(sql) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "supabase_db_rehearsal-test-lab",
      "psql",
      "--no-align",
      "--tuples-only",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "Lab SQL check failed.");
  return result.stdout.trim();
}
