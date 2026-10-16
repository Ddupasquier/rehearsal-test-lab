/** Independent, read-only measurement boundaries for the resource-profile scenario. */
import { runCommand } from "./process.mts";
import {
  requireArray,
  requireObject,
  requireString,
} from "../shared/validation.mts";

export const RESOURCE_PROFILES = ["postgresql", "application", "full"] as const;
export type ResourceProfile = (typeof RESOURCE_PROFILES)[number];

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
      : ["database", "auth", "storage", "postgrest", "gateway"];
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
