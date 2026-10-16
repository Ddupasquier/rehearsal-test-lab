/** Independent assertions and measurement boundaries for the resource-profile scenario. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import { createHash } from "node:crypto";
import { runCommand } from "./process.mts";
import {
  requireArray,
  requireObject,
  requireString,
} from "../shared/validation.mts";

export const RESOURCE_PROFILES = ["postgresql", "application", "full"] as const;
export type ResourceProfile = (typeof RESOURCE_PROFILES)[number];

const persistenceTitle = "Rehearsal synthetic persistence control";
export const PROFILE_PERSISTENCE_EDIT_SQL =
  "SET statement_timeout = '5s'; UPDATE public.benchmark_books SET title = 'Rehearsal synthetic persistence control' WHERE id = 1 RETURNING id;";
export const PROFILE_PERSISTENCE_QUERY_SQL =
  "SET statement_timeout = '5s'; SELECT coalesce(json_agg(json_build_object('id', id, 'title', title) ORDER BY id), '[]'::json) FROM (SELECT id, title FROM public.benchmark_books ORDER BY id LIMIT 101) books;";

type ProfileProbeRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

/** Bound only the independent synthetic Docker probes, including transport failures. */
export function runProfileDatabaseProbe(
  args: readonly string[],
  { endpoint, run = spawnSync }: { endpoint: string; run?: ProfileProbeRunner },
) {
  if (!localProfileEndpoint(endpoint))
    throw new Error("Synthetic database probes require a pinned local engine.");
  const result = run("docker", args, {
    env: { ...process.env, ...cleanProfileDockerEnvironment(endpoint) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    timeout: 15000,
    killSignal: "SIGKILL",
    maxBuffer: 65536,
  });
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 65536
  )
    throw new Error(
      "The bounded synthetic database probe did not complete; raw provider output was withheld.",
    );
  return result.stdout;
}

export function profileDatabaseContainerName(
  profile: ResourceProfile,
  projectId: string,
) {
  const provider = profile === "postgresql" ? "postgresql" : "supabase";
  assert.match(
    projectId,
    new RegExp(`^rtl-[a-f0-9]{10}-${provider}-rehearsal$`, "u"),
  );
  return profile === "postgresql"
    ? `${projectId}-postgresql`
    : `supabase_db_${projectId}`;
}

/** Validate immutable identity and exact run/provider ownership before fixed synthetic SQL. */
export function requireProfileDatabaseContainer(
  inspection: unknown,
  profile: ResourceProfile,
  projectId: string,
) {
  const row = requireObject(inspection, "Synthetic profile database");
  const id = requireString(row.id, "Synthetic profile database ID");
  assert.match(id, /^[a-f0-9]{64}$/u);
  assert.equal(
    row.name,
    `/${profileDatabaseContainerName(profile, projectId)}`,
  );
  assert.equal(row.running, true);
  const labels = requireObject(
    row.labels,
    "Synthetic profile ownership labels",
  );
  const expectedLabel =
    profile === "postgresql"
      ? "com.rehearsal-db.project"
      : "com.supabase.cli.project";
  const otherLabel =
    profile === "postgresql"
      ? "com.supabase.cli.project"
      : "com.rehearsal-db.project";
  assert.equal(labels[expectedLabel], projectId);
  assert.ok(
    labels[otherLabel] === undefined || labels[otherLabel] === projectId,
    "Synthetic database ownership is conflicting.",
  );
  return id;
}

export function readProfilePersistenceSnapshot(output: string) {
  assert.ok(
    Buffer.byteLength(output) <= 65536,
    "Synthetic persistence response exceeded its bound.",
  );
  const rows = requireArray(JSON.parse(output), "Synthetic persistence rows");
  assert.equal(
    rows.length,
    100,
    "The complete synthetic row set must survive.",
  );
  const projected = rows.map((value, index) => {
    const row = requireObject(value, "Synthetic persistence row");
    assert.deepEqual(Object.keys(row).sort(), ["id", "title"]);
    assert.equal(
      row.id,
      index + 1,
      "Every synthetic primary key must survive.",
    );
    assert.equal(typeof row.title, "string");
    assert.ok(Buffer.byteLength(String(row.title)) <= 256);
    if (index === 0)
      assert.equal(
        row.title,
        persistenceTitle,
        "The local edit did not survive.",
      );
    return { id: row.id, title: row.title };
  });
  return {
    rowCount: 100,
    sentinelEditPreserved: true,
    rowsSha256: createHash("sha256")
      .update(JSON.stringify(projected))
      .digest("hex"),
  };
}

export interface ProfileResourceIdentities {
  containers: readonly string[];
  volumes: readonly { name: string; createdAt: string }[];
}

/** Supabase may recreate stopped service containers; it must not recreate their data. */
export function assertProfileRestartPersistence({
  profile,
  before,
  after,
  services,
  beforeData,
  afterData,
}: {
  profile: ResourceProfile;
  before: ProfileResourceIdentities;
  after: ProfileResourceIdentities;
  services: readonly string[];
  beforeData: ReturnType<typeof readProfilePersistenceSnapshot>;
  afterData: ReturnType<typeof readProfilePersistenceSnapshot>;
}) {
  const canonical = (value: ProfileResourceIdentities) => {
    assert.ok(value.containers.length > 0 && value.containers.length <= 32);
    assert.equal(new Set(value.containers).size, value.containers.length);
    for (const id of value.containers) assert.match(id, /^[a-f0-9]{64}$/u);
    assert.ok(value.volumes.length > 0 && value.volumes.length <= 64);
    assert.equal(
      new Set(value.volumes.map((volume) => volume.name)).size,
      value.volumes.length,
    );
    for (const volume of value.volumes) {
      assert.match(volume.name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u);
      assert.ok(Number.isFinite(Date.parse(volume.createdAt)));
    }
    return {
      containers: [...value.containers].sort(),
      volumes: [...value.volumes].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };
  };
  const original = canonical(before),
    restarted = canonical(after);
  assert.deepEqual(
    restarted.volumes,
    original.volumes,
    "Restart must preserve exact volume names and creation identities.",
  );
  if (profile === "postgresql")
    assert.deepEqual(
      restarted.containers,
      original.containers,
      "PostgreSQL restart must preserve its container identity.",
    );
  verifyProfileServices(profile, services);
  for (const snapshot of [beforeData, afterData]) {
    assert.equal(snapshot.rowCount, 100);
    assert.equal(snapshot.sentinelEditPreserved, true);
    assert.match(snapshot.rowsSha256, /^[a-f0-9]{64}$/u);
  }
  assert.deepEqual(
    afterData,
    beforeData,
    "Restart must preserve all synthetic rows and the local edit.",
  );
  return {
    containerIdentity:
      profile === "postgresql" ? "preserved" : "provider-may-recreate",
    exactVolumesPreserved: true,
    expectedServicesPresent: true,
    data: afterData,
    scope:
      "exact volume identity, live service presence and independently queried synthetic rows; not a new baseline restore",
  };
}

/** An explicit focused run never certifies omitted profiles. */
export function selectResourceProfiles(
  arguments_: readonly string[],
): readonly ResourceProfile[] {
  if (arguments_.length === 0) return RESOURCE_PROFILES;
  const selected = arguments_[0]?.replace(/^--profile=/u, "");
  if (
    arguments_.length !== 1 ||
    !arguments_[0]?.startsWith("--profile=") ||
    !RESOURCE_PROFILES.includes(selected as ResourceProfile)
  )
    throw new Error(
      "Use at most one --profile=postgresql|application|full selection.",
    );
  return [selected as ResourceProfile];
}

/** Cover every declared data destination without creating an anonymous volume. */
export function profileProbeTmpfsMounts(value: unknown): string[] {
  const destinations =
    value === null
      ? []
      : Object.keys(requireObject(value, "Image volume declarations"));
  if (
    destinations.length > 8 ||
    destinations.some(
      (path) =>
        !/^\/[a-zA-Z0-9_./-]{1,255}$/u.test(path) ||
        path.includes("//") ||
        path.endsWith("/") ||
        path.split("/").some((part) => part === "." || part === ".."),
    )
  )
    throw new Error(
      "Probe image volume destinations are not bounded canonical absolute paths.",
    );
  return destinations.flatMap((destination) => [
    "--mount",
    `type=tmpfs,destination=${destination}`,
  ]);
}

export function localProfileEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || /[\r\n\0]/u.test(value)) return false;
  if (/^npipe:\/{4}(?:\.|localhost)\/pipe\/[a-z0-9_.-]+$/iu.test(value))
    return true;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    return url.protocol === "unix:"
      ? url.hostname === "" &&
          url.pathname.startsWith("/") &&
          url.pathname.length > 1
      : ["tcp:", "http:", "https:"].includes(url.protocol) &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          ["", "/"].includes(url.pathname);
  } catch {
    return false;
  }
}

export const cleanProfileDockerEnvironment = (
  endpoint?: string,
): NodeJS.ProcessEnv => ({
  DOCKER_HOST: endpoint,
  DOCKER_CONTEXT: undefined,
  DOCKER_TLS_VERIFY: undefined,
  DOCKER_CERT_PATH: undefined,
  DOCKER_CONFIG: undefined,
});

export function inspectProfileEndpoint(
  command: typeof runCommand = runCommand,
): string {
  const options = { env: cleanProfileDockerEnvironment() };
  const context = command("docker", ["context", "show"], options).stdout.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(context))
    throw new Error("A local profiling engine context could not be verified.");
  const output = command(
    "docker",
    [
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints.docker.Host}}",
      context,
    ],
    options,
  ).stdout;
  const endpoint: unknown = JSON.parse(output);
  if (!localProfileEndpoint(endpoint))
    throw new Error(
      "Resource profiling refuses remote or unknown Docker endpoints before contacting a daemon.",
    );
  command("docker", ["info"], { env: cleanProfileDockerEnvironment(endpoint) });
  return endpoint;
}

export interface ProfileMetrics {
  readonly containers: number;
  readonly cpuPercent: number;
  readonly memoryUsageBytes: number;
  readonly ownedVolumeBytes: number | null;
}

/** Attribute only observed cache changes, never another project's image pulls. */
export function profileMeasurementScope(newCachedImageCount: number) {
  if (!Number.isSafeInteger(newCachedImageCount) || newCachedImageCount < 0)
    throw new Error("The observed image-set change count must be bounded.");
  return {
    startupMeasurement:
      "complete package-owned reset: fresh containers, health checks and 100-row baseline restoration",
    imageCache: newCachedImageCount
      ? "shared engine image set changed during reset; download attribution unknown"
      : "no new cached image IDs observed; fresh owned containers",
    newCachedImageCount,
    cacheLimitation:
      "An engine-global image-set difference cannot attribute concurrent pulls to this profile or prove cold-image startup.",
    engineStartupMeasured: false,
    coldImageOrVmBenchmark: false,
    resourceMeasurementScope:
      "owned Docker container CPU/memory samples only; not host memory pressure or VM reservation",
    sampleWindow: {
      warmupMilliseconds: 5000,
      samples: 3,
      minimumGapMilliseconds: 2000,
      workload: "idle after restoring 100 synthetic rows",
    },
  };
}

export function readProfileMetrics(
  value: unknown,
  expectedProjectId: string,
): ProfileMetrics {
  const envelope = requireObject(value, "Resource response");
  const data = requireObject(envelope.data, "Resource data");
  if (
    data.schemaVersion !== 1 ||
    requireObject(data.engine, "Engine").state !== "running"
  )
    throw new Error("The profile's running engine could not be measured.");
  const environments = requireArray(data.environments, "Environments");
  if (environments.length !== 1)
    throw new Error("A profile must measure exactly one isolated environment.");
  const entry = requireObject(environments[0], "Environment");
  const count = entry.containerCount;
  if (
    entry.projectId !== expectedProjectId ||
    entry.state !== "running" ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    entry.runningContainerCount !== count
  )
    throw new Error(
      "The profile environment is absent, mixed, foreign, or incompletely started.",
    );
  if (
    typeof entry.cpuPercent !== "number" ||
    !Number.isFinite(entry.cpuPercent) ||
    entry.cpuPercent < 0 ||
    typeof entry.memoryUsageBytes !== "number" ||
    !Number.isSafeInteger(entry.memoryUsageBytes) ||
    entry.memoryUsageBytes < 0
  )
    throw new Error(
      "Live profile CPU/memory measurements are unavailable; no values were guessed.",
    );
  return {
    containers: count,
    cpuPercent: entry.cpuPercent,
    memoryUsageBytes: entry.memoryUsageBytes,
    ownedVolumeBytes:
      typeof entry.diskUsageBytes === "number" &&
      Number.isSafeInteger(entry.diskUsageBytes)
        ? entry.diskUsageBytes
        : null,
  };
}

const SERVICE_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  database: ["supabase_db_"],
  auth: ["supabase_auth_"],
  storage: ["supabase_storage_"],
  postgrest: ["supabase_rest_"],
  gateway: ["supabase_kong_", "supabase_envoy_"],
  mail: ["supabase_inbucket_"],
  studio: ["supabase_studio_"],
  realtime: ["supabase_realtime_"],
  "edge-functions": ["supabase_edge_runtime_"],
  analytics: ["supabase_analytics_", "supabase_logflare_"],
  vector: ["supabase_vector_"],
  "image-transforms": ["supabase_imgproxy_"],
};

export function verifyProfileServices(
  profile: "postgresql" | "application" | "full",
  names: readonly string[],
) {
  if (profile === "postgresql") {
    if (names.length !== 1 || !names[0]!.endsWith("-postgresql"))
      throw new Error("Ordinary PostgreSQL must use one database container.");
    return;
  }
  const required =
    profile === "full"
      ? Object.keys(SERVICE_PREFIXES)
      : ["database", "auth", "storage", "postgrest", "gateway", "mail"];
  for (const service of required)
    if (
      !names.some((name) =>
        SERVICE_PREFIXES[service]!.some((prefix) => name.startsWith(prefix)),
      )
    )
      throw new Error(
        `The ${profile} profile is missing required live service ${service}.`,
      );
  if (profile === "application")
    for (const service of [
      "studio",
      "realtime",
      "edge-functions",
      "analytics",
      "vector",
      "image-transforms",
    ])
      if (
        names.some((name) =>
          SERVICE_PREFIXES[service]!.some((prefix) => name.startsWith(prefix)),
        )
      )
        throw new Error(
          `The application profile unexpectedly started excluded service ${service}.`,
        );
}

export function summarizeProfileSamples(samples: readonly ProfileMetrics[]) {
  if (
    samples.length !== 3 ||
    new Set(samples.map((sample) => sample.containers)).size !== 1
  )
    throw new Error("Three consistent steady-state samples are required.");
  const average = (field: "cpuPercent" | "memoryUsageBytes") =>
    samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
  return {
    containers: samples[0]!.containers,
    meanCpuPercent: average("cpuPercent"),
    meanMemoryUsageBytes: Math.round(average("memoryUsageBytes")),
    peakMemoryUsageBytes: Math.max(
      ...samples.map((sample) => sample.memoryUsageBytes),
    ),
  };
}

export const readProfileProjectId = (value: unknown): string =>
  requireString(value, "Profile project identity");
