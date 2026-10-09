import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");
export const supabaseProject = resolve(root, "projects/supabase");

export interface LocalSupabaseEnvironment {
  API_URL: string;
  PUBLISHABLE_KEY: string;
  SERVICE_ROLE_KEY: string;
  DB_URL: string;
  INBUCKET_URL?: string;
}

export function localSupabaseEnvironment(): LocalSupabaseEnvironment {
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

  const environment: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const match = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) environment[match[1]] = match[2];
  }

  if (
    !environment.API_URL ||
    !(environment.PUBLISHABLE_KEY || environment.ANON_KEY) ||
    !environment.SERVICE_ROLE_KEY ||
    !environment.DB_URL
  ) {
    throw new Error(
      "Supabase did not report the expected local API credentials.",
    );
  }
  return {
    API_URL: environment.API_URL,
    PUBLISHABLE_KEY: environment.PUBLISHABLE_KEY ?? environment.ANON_KEY!,
    SERVICE_ROLE_KEY: environment.SERVICE_ROLE_KEY,
    DB_URL: environment.DB_URL,
    ...(environment.INBUCKET_URL
      ? { INBUCKET_URL: environment.INBUCKET_URL }
      : {}),
  };
}

export function runLabSql(sql: string) {
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
