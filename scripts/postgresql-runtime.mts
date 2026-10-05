import { spawnSync } from "node:child_process";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const action = process.argv[2];
const container = "rehearsal-test-lab-postgresql";
const volume = "rehearsal_lab_postgresql";
const migration = resolve(
  import.meta.dirname,
  "../projects/postgresql/database/migrations/20261004000100_create_lab_model.sql",
);
const seed = resolve(
  import.meta.dirname,
  "../projects/postgresql/database/seed.sql",
);

function docker(
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result: SpawnSyncReturns<string>, message: string) {
  if (result.status !== 0) throw new Error(result.stderr || message);
}

if (action === "start") {
  requireSuccess(
    docker([
      "volume",
      "create",
      "--label",
      "com.rehearsal-test-lab.resource=postgresql",
      volume,
    ]),
    "Could not prepare the PostgreSQL volume.",
  );
  const volumeOwner = docker([
    "volume",
    "inspect",
    "--format",
    '{{ index .Labels "com.rehearsal-test-lab.resource" }}',
    volume,
  ]);
  if (volumeOwner.stdout.trim() !== "postgresql") {
    throw new Error(`Refusing to reuse unowned volume ${volume}.`);
  }
  const existing = docker(["container", "inspect", container]);
  if (existing.status === 0) {
    const owner = docker([
      "container",
      "inspect",
      "--format",
      '{{ index .Config.Labels "com.rehearsal-test-lab.resource" }}',
      container,
    ]);
    if (owner.stdout.trim() !== "postgresql") {
      throw new Error(`Refusing to start unowned container ${container}.`);
    }
    requireSuccess(docker(["start", container]), "Could not start PostgreSQL.");
  } else {
    requireSuccess(
      docker([
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        "com.rehearsal-test-lab.resource=postgresql",
        "--publish",
        "127.0.0.1:55432:5432",
        "--env",
        "POSTGRES_DB=rehearsal_lab",
        "--env",
        "POSTGRES_USER=rehearsal_lab",
        "--env",
        "POSTGRES_PASSWORD=local-synthetic-only",
        "--volume",
        `${volume}:/var/lib/postgresql/data`,
        "--volume",
        `${migration}:/docker-entrypoint-initdb.d/010_schema.sql:ro`,
        "--volume",
        `${seed}:/docker-entrypoint-initdb.d/020_seed.sql:ro`,
        "--health-cmd",
        "pg_isready -U rehearsal_lab -d rehearsal_lab",
        "--health-interval",
        "2s",
        "--health-timeout",
        "3s",
        "--health-retries",
        "30",
        "postgres:17-alpine",
      ]),
      "Could not create PostgreSQL.",
    );
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = docker([
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
      container,
    ]);
    if (health.stdout.trim() === "healthy") {
      console.log("Ordinary PostgreSQL is ready on 127.0.0.1:55432.");
      process.exit(0);
    }
    if (health.stdout.trim() === "unhealthy") {
      throw new Error("PostgreSQL became unhealthy during startup.");
    }
    await delay(1000);
  }
  throw new Error("PostgreSQL did not become healthy within 60 seconds.");
} else if (action === "stop") {
  const existing = docker(["container", "inspect", container]);
  if (existing.status !== 0) {
    if (!/No such (?:container|object)/iu.test(existing.stderr)) {
      requireSuccess(existing, "Could not inspect the PostgreSQL container.");
    }
    console.log("Ordinary PostgreSQL is already absent.");
  } else {
    const owner = docker([
      "container",
      "inspect",
      "--format",
      '{{ index .Config.Labels "com.rehearsal-test-lab.resource" }}',
      container,
    ]);
    requireSuccess(owner, "Could not inspect PostgreSQL container ownership.");
    if (owner.stdout.trim() !== "postgresql") {
      throw new Error(`Refusing to stop unowned container ${container}.`);
    }
    requireSuccess(docker(["stop", container]), "Could not stop PostgreSQL.");
    console.log(
      "Ordinary PostgreSQL stopped; its lab-owned volume was preserved.",
    );
  }
} else {
  throw new Error(
    "Usage: node --import tsx scripts/postgresql-runtime.mts <start|stop>",
  );
}
