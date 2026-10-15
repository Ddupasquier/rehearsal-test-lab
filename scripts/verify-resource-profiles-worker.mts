/** Measure one exact package's lightweight/full runtime profiles in an isolated lab snapshot. */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { inspectArtifact } from "./candidate/artifact.mts";
import { acquireHeavyLease } from "./candidate/isolation.mts";
import {
  compareInstalledPackage,
  parseJsonOutput,
  runCommand,
} from "./candidate/process.mts";
import {
  cleanProfileDockerEnvironment,
  localProfileEndpoint,
  readProfileMetrics,
  summarizeProfileSamples,
  verifyProfileServices,
  type ProfileMetrics,
} from "./candidate/resource-profiles.mts";
import {
  errorMessage,
  requireArray,
  requireObject,
} from "./shared/validation.mts";

const root = resolve(process.cwd());
const requested = process.argv[2];
if (!requested)
  throw new Error(
    "Use npm run resources:verify with an exact package artifact.",
  );
const endpoint = process.env.LAB_PROFILE_DOCKER_ENDPOINT;
if (!localProfileEndpoint(endpoint))
  throw new Error("An isolated local engine binding is required.");
const reportDirectory = process.env.LAB_REPORT_DIRECTORY;
const runId = process.env.LAB_RUN_ID;
if (!reportDirectory || !runId || !/^rtl-[a-f0-9]{10}$/u.test(runId))
  throw new Error("A maintained isolated lab run identity is required.");
const targetBase = Number(process.env.LAB_SUPABASE_APP_PORT) - 15;
if (!Number.isSafeInteger(targetBase) || targetBase < 1024)
  throw new Error("A dedicated profiling port lease is required.");
const environment = cleanProfileDockerEnvironment(endpoint);
const command: typeof runCommand = (program, args = [], options = {}) =>
  runCommand(program, args, {
    ...options,
    env: { ...options.env, ...environment },
  });
const originalContainers = command("docker", [
  "container",
  "ls",
  "--all",
  "--quiet",
])
  .stdout.trim()
  .split(/\s+/u)
  .filter(Boolean);
const containerState = () =>
  new Map(
    command("docker", [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--format",
      "{{.ID}}\t{{.Names}}\t{{.State}}",
    ])
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, ...state] = line.split("\t");
        return [id!, state.join("\t")] as const;
      }),
  );
const originalStates = containerState();
const originalVolumes = command("docker", ["volume", "ls", "--quiet"])
  .stdout.trim()
  .split(/\s+/u)
  .filter(Boolean);
const reports: Array<Record<string, unknown>> = [];
const failures: string[] = [];
let artifact: Record<string, unknown> | null = null;
let extracted: string | null = null;
let releaseHeavy: (() => Promise<void>) | null = null;

const cli = (cwd: string, args: readonly string[]) =>
  parseJsonOutput(
    command(
      resolve(cwd, "node_modules/.bin/rehearsal"),
      [...args, "--json", "--plain"],
      { cwd },
    ).stdout,
    "Rehearsal CLI",
  );
const policy = {
  policyVersion: 1,
  migrationCutoff: "20261001000000",
  tables: [
    {
      name: "benchmark_books",
      group: "synthetic",
      sourceRows: "STREAM AND SANITIZE",
      columns: [
        {
          name: "id",
          action: "KEEP EXACTLY",
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
        {
          name: "title",
          action: "REPLACE WITH SYNTHETIC",
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
      ],
    },
  ],
};
const sql =
  "create table public.benchmark_books (id integer primary key, title text not null);";
const template = (
  full: boolean,
  projectId: string,
) => `project_id = ${JSON.stringify(projectId)}
[api]
enabled = true
port = ${targetBase + 1}
schemas = ["public"]
extra_search_path = ["public", "extensions"]
[db]
port = ${targetBase + 2}
shadow_port = ${targetBase}
major_version = 17
[db.pooler]
enabled = false
port = ${targetBase + 9}
[db.migrations]
enabled = true
schema_paths = []
[db.seed]
enabled = false
sql_paths = []
[studio]
enabled = ${full}
port = ${targetBase + 3}
api_url = "http://127.0.0.1"
[local_smtp]
enabled = true
port = ${targetBase + 4}
[auth]
enabled = true
site_url = "http://localhost:${targetBase + 15}"
additional_redirect_urls = []
enable_signup = false
[storage]
enabled = true
[storage.image_transformation]
enabled = ${full}
[realtime]
enabled = ${full}
[edge_runtime]
enabled = ${full}
inspector_port = ${targetBase + 14}
[analytics]
enabled = ${full}
port = ${targetBase + 5}
backend = "postgres"
`;

async function prepare(
  cwd: string,
  profile: "postgresql" | "application" | "full",
) {
  const postgres = profile === "postgresql";
  const projectId = `${runId}-${postgres ? "postgresql" : "supabase"}-rehearsal`;
  await mkdir(resolve(cwd, "benchmark/migrations"), { recursive: true });
  await writeFile(
    resolve(
      cwd,
      "benchmark/migrations/20261001000000_create_benchmark_books.sql",
    ),
    `${sql}\n`,
  );
  await writeFile(
    resolve(cwd, "benchmark/policy.json"),
    JSON.stringify(policy),
  );
  await writeFile(
    resolve(cwd, "benchmark/records.ndjson"),
    Array.from({ length: 100 }, (_, index) =>
      JSON.stringify({
        table: "benchmark_books",
        row: { id: index + 1, title: `Synthetic library book ${index + 1}` },
      }),
    ).join("\n") + "\n",
  );
  await writeFile(
    resolve(cwd, "benchmark/ledger.json"),
    JSON.stringify([
      {
        version: "20261001000000",
        name: "create_benchmark_books",
        statements: [sql.replace(/;$/u, "")],
      },
    ]),
  );
  const config = {
    schemaVersion: 1,
    project: { name: "resource-profile-benchmark" },
    ...(postgres
      ? {
          postgresql: {
            migrationDirectory: "benchmark/migrations",
            runtimeWorkdir: ".rehearsal/runtime",
            image: "postgres:17-alpine",
          },
        }
      : {
          supabase: {
            workdir: ".",
            migrationDirectory: "benchmark/migrations",
            rehearsalConfig: "benchmark/config.toml",
            runtimeWorkdir: ".rehearsal/runtime",
            serviceProfile: profile,
          },
        }),
    baseline: {
      artifactDirectory: ".rehearsal",
      sanitizationPolicy: "benchmark/policy.json",
    },
    application: {
      startCommand: "npm run dev",
      proofCommand: "npm test",
      requiredServices: postgres
        ? ["database"]
        : profile === "full"
          ? [
              "database",
              "auth",
              "storage",
              "postgrest",
              "gateway",
              "studio",
              "realtime",
              "edge-functions",
              "analytics",
              "image-transforms",
            ]
          : ["database", "auth", "storage", "postgrest", "gateway"],
    },
    containerRuntime: { autoStartColima: false },
    resources: { staleAfterSeconds: 1 },
    runtime: {
      target: postgres ? "postgresql" : "supabase",
      projectId,
      databasePort: postgres ? targetBase + 13 : targetBase + 2,
      ...(postgres
        ? {}
        : { apiPort: targetBase + 1, studioPort: targetBase + 3 }),
    },
    safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
  };
  await writeFile(
    resolve(cwd, "rehearsal.config.mjs"),
    `export default ${JSON.stringify(config, null, 2)};\n`,
  );
  if (!postgres)
    await writeFile(
      resolve(cwd, "benchmark/config.toml"),
      template(profile === "full", projectId),
    );
  const baseline = requireObject(
    cli(cwd, [
      "baseline",
      "create",
      "--records=benchmark/records.ndjson",
      "--ledger=benchmark/ledger.json",
    ]).data,
    "Baseline",
  );
  assert.equal(baseline.rowCount, 100);
  return projectId;
}

try {
  const inspected = await inspectArtifact(resolve(requested));
  extracted = inspected.directory;
  artifact = inspected.artifact;
  const consumers = {
    postgresql: resolve(root, "projects/postgresql"),
    supabase: resolve(root, "projects/supabase"),
  };
  for (const cwd of Object.values(consumers)) {
    command(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        resolve(requested),
      ],
      { cwd },
    );
    await compareInstalledPackage(
      resolve(extracted, "package"),
      resolve(cwd, "node_modules/@rehearsal-db/core"),
    );
  }
  for (const profile of ["postgresql", "application", "full"] as const) {
    const cwd =
      profile === "postgresql" ? consumers.postgresql : consumers.supabase;
    if (profile !== "postgresql") releaseHeavy = await acquireHeavyLease();
    const projectId = await prepare(cwd, profile);
    const ownership =
      profile === "postgresql"
        ? "com.rehearsal-db.project"
        : "com.supabase.cli.project";
    const filter = `label=${ownership}=${projectId}`;
    assert.equal(
      command("docker", [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        filter,
      ]).stdout.trim(),
      "",
      "Cold container creation must not reuse existing workload.",
    );
    const imageIdsBefore = new Set(
      command("docker", ["image", "ls", "--quiet"])
        .stdout.trim()
        .split(/\s+/u)
        .filter(Boolean),
    );
    const started = performance.now();
    cli(cwd, ["reset"]);
    const startupMilliseconds = Math.round(performance.now() - started);
    cli(cwd, ["verify"]);
    const names = command("docker", [
      "container",
      "ls",
      "--filter",
      filter,
      "--format",
      "{{.Names}}",
    ])
      .stdout.trim()
      .split(/\s+/u)
      .filter(Boolean);
    verifyProfileServices(profile, names);
    const samples: ProfileMetrics[] = [];
    await delay(5000);
    for (let index = 0; index < 3; index++) {
      samples.push(readProfileMetrics(cli(cwd, ["environments"]), projectId));
      if (index !== 2) await delay(2000);
    }
    const extraImages = command("docker", ["image", "ls", "--quiet"])
      .stdout.trim()
      .split(/\s+/u)
      .filter((id) => id && !imageIdsBefore.has(id));
    const stopPlan = requireObject(
      requireObject(cli(cwd, ["stop-stale"]).data, "Stop-stale preview").plan,
      "Stop plan",
    );
    assert.equal(
      requireArray(stopPlan.targets, "Reviewed stale targets").length,
      1,
    );
    const digest = stopPlan.digest;
    assert.equal(typeof digest, "string");
    const exactIds = command("docker", [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      filter,
    ])
      .stdout.trim()
      .split(/\s+/u)
      .filter(Boolean)
      .sort();
    cli(cwd, ["stop-stale", `--confirm-stop=${String(digest)}`]);
    assert.equal(
      command("docker", [
        "container",
        "ls",
        "--quiet",
        "--filter",
        filter,
      ]).stdout.trim(),
      "",
    );
    assert.deepEqual(
      command("docker", [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        filter,
      ])
        .stdout.trim()
        .split(/\s+/u)
        .filter(Boolean)
        .sort(),
      exactIds,
      "Reviewed stop must retain the same containers.",
    );
    cli(cwd, ["start"]);
    cli(cwd, ["verify"]);
    verifyProfileServices(
      profile,
      command("docker", [
        "container",
        "ls",
        "--filter",
        filter,
        "--format",
        "{{.Names}}",
      ])
        .stdout.trim()
        .split(/\s+/u)
        .filter(Boolean),
    );
    cli(cwd, ["discard"]);
    const inventory = requireObject(
      cli(cwd, ["environments"]).data,
      "Post-discard resources",
    );
    const stopped = requireObject(
      requireArray(inventory.environments, "Environments")[0],
      "Environment",
    );
    assert.equal(stopped.state, "absent");
    reports.push({
      profile,
      projectId,
      startupMilliseconds,
      startupMeasurement:
        "complete package-owned reset: fresh provisioning, health checks and 100-row baseline restoration",
      imageCache: extraImages.length
        ? "startup included new image downloads"
        : "warm cached images; fresh containers",
      newCachedImageCount: new Set(extraImages).size,
      ...summarizeProfileSamples(samples),
      samples,
      runningServices: names,
      verifiedBaselineRows: 100,
      staleStopRestart:
        "exact containers retained; restart and native baseline verify passed",
      cleanup: "owned target absent; baseline retained",
    });
    if (releaseHeavy) {
      await releaseHeavy();
      releaseHeavy = null;
    }
    console.log(
      `${profile}: ${startupMilliseconds} ms; ${samples[0]!.containers} containers; mean ${Math.round(summarizeProfileSamples(samples).meanMemoryUsageBytes / 1024 ** 2)} MiB.`,
    );
  }
  const afterContainers = new Set(
    command("docker", ["container", "ls", "--all", "--quiet"])
      .stdout.trim()
      .split(/\s+/u)
      .filter(Boolean),
  );
  const afterVolumes = new Set(
    command("docker", ["volume", "ls", "--quiet"])
      .stdout.trim()
      .split(/\s+/u)
      .filter(Boolean),
  );
  assert.ok(
    originalContainers.every((id) => afterContainers.has(id)),
    "An original container disappeared.",
  );
  assert.ok(
    originalVolumes.every((id) => afterVolumes.has(id)),
    "An original volume disappeared.",
  );
  const currentStates = containerState();
  assert.ok(
    [...originalStates].every(([id, state]) => currentStates.get(id) === state),
    "An original container name or running/stopped state changed.",
  );
} catch (error) {
  failures.push(errorMessage(error));
} finally {
  // A failed live phase retains its heavy slot until the outer wrapper proves cleanup.
  if (releaseHeavy && failures.length === 0) await releaseHeavy();
  if (extracted) await rm(extracted, { recursive: true, force: true });
  const passed = !failures.length && reports.length === 3;
  await writeFile(
    resolve(reportDirectory, "profiles.json"),
    `${JSON.stringify({ schemaVersion: 1, status: passed ? "passed" : "failed", artifact, environment: { platform: process.platform, arch: process.arch, node: process.version }, profiles: reports, failures, limitations: ["100 synthetic rows; not a large restore performance benchmark", "Steady-state samples are 5 seconds after startup, then two seconds apart; not host memory pressure or a soak test", "Service presence and native baseline verification do not certify genuine provider login or every optional API", "Image downloads are reported separately; cached images remain shared and are not pruned"] }, null, 2)}\n`,
  );
  await writeFile(
    resolve(reportDirectory, "profiles.md"),
    `# Runtime profile measurements\n\nVerdict: ${passed ? "PASS" : "FAIL"}\n\nArtifact SHA-256: ${String(artifact?.sha256 ?? "unverified")}\n\n| Profile | Reset to ready | Containers | Mean memory | Mean CPU |\n| --- | ---: | ---: | ---: | ---: |\n${reports.map((report) => `| ${String(report.profile)} | ${Number(report.startupMilliseconds) / 1000}s | ${String(report.containers)} | ${Math.round(Number(report.meanMemoryUsageBytes) / 1024 ** 2)} MiB | ${Number(report.meanCpuPercent).toFixed(2)}% |`).join("\n")}\n\nStartup measures the complete package-owned reset: fresh container provisioning, health checks and 100-row baseline restoration; it is not a raw Docker start timer. See JSON for new image downloads. These short samples are regression signals, not universal hardware guarantees. Native baseline verification and exact service presence passed only for completed rows. No hosted login or complete optional-service API acceptance was performed.\n${failures.map((failure) => `\nFailure: ${failure}\n`).join("")}`,
  );
  process.exitCode = passed ? 0 : 1;
}
