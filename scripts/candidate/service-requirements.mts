/** Installed public-CLI service guards; never provision or emulate a database. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { parseJsonOutput } from "./process.mts";
import { reapOwnedWorkspaceProcesses } from "./isolation.mts";
import { requireObject } from "../shared/validation.mts";
import type { ResourceProfile } from "./resource-profiles.mts";

type Configuration = Record<string, unknown>;
export interface ServiceRequirementControl {
  name: string;
  command: "configuration" | "start";
  configuration: Configuration;
  template: string | null;
  syntheticContext: boolean;
  expectedRefusal: string | null;
}
export interface ServiceControlRequest {
  executable: string;
  arguments: readonly string[];
  project: string;
  environment: NodeJS.ProcessEnv;
}
export interface ServiceControlResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
type Runner = (
  request: ServiceControlRequest,
) => ServiceControlResult | Promise<ServiceControlResult>;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const objectAt = (value: Configuration, key: string) =>
  requireObject(value[key], `Synthetic ${key}`);
const serialize = (value: Configuration) =>
  `export default ${JSON.stringify(value, null, 2)};\n`;

/** Accept only this runner's generated JSON literal, never evaluate project code. */
export function readProfileConfiguration(source: string): Configuration {
  assert.ok(Buffer.byteLength(source) <= 65536);
  assert.ok(source.startsWith("export default ") && source.endsWith(";\n"));
  const result = requireObject(
    JSON.parse(source.slice("export default ".length, -2)),
    "Generated profile configuration",
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(serialize(result), source);
  return result;
}

const realtimeTemplate = (source: string, ambiguous: boolean) => {
  assert.ok(Buffer.byteLength(source) <= 65536);
  const section = /^\[realtime\]\r?\n[\s\S]*?(?=^\[|$(?![\s\S]))/gmu;
  assert.equal([...source.matchAll(section)].length, 1);
  return source.replace(
    section,
    ambiguous
      ? "[realtime]\nenabled = true\nenabled = true\n"
      : "[realtime]\nenabled = false\n",
  );
};

export function serviceRequirementControls({
  configuration,
  profile,
  template,
}: {
  configuration: Configuration;
  profile: ResourceProfile;
  template: string | null;
}): ServiceRequirementControl[] {
  const base = structuredClone(configuration);
  const controls: ServiceRequirementControl[] = [
    {
      name: `${profile}-metadata-accepted`,
      command: "configuration",
      configuration: base,
      template: null,
      syntheticContext: false,
      expectedRefusal: null,
    },
  ];
  const invalid = structuredClone(base);
  objectAt(invalid, "application").requiredServices = [
    "database",
    profile === "postgresql" ? "auth" : "realtime",
  ];
  if (profile !== "postgresql")
    objectAt(invalid, "supabase").serviceProfile = "application";
  controls.push({
    name:
      profile === "postgresql"
        ? "postgresql-auth-refused"
        : "application-realtime-refused",
    command: "start",
    configuration: invalid,
    template: null,
    syntheticContext: false,
    expectedRefusal: `excludes required application services: ${profile === "postgresql" ? "auth" : "realtime"}`,
  });
  if (profile === "postgresql") return controls;
  assert.equal(typeof template, "string");
  const full = structuredClone(base);
  objectAt(full, "supabase").serviceProfile = "full";
  objectAt(full, "application").requiredServices = ["database", "realtime"];
  controls.push({
    name: "full-realtime-metadata-accepted",
    command: "configuration",
    configuration: structuredClone(full),
    template: null,
    syntheticContext: false,
    expectedRefusal: null,
  });
  for (const ambiguous of [false, true]) {
    controls.push({
      name: ambiguous
        ? "full-ambiguous-realtime-refused"
        : "full-disabled-realtime-refused",
      command: "start",
      configuration: structuredClone(full),
      template: realtimeTemplate(template!, ambiguous),
      syntheticContext: true,
      expectedRefusal:
        "Required Supabase service realtime is disabled or not explicitly enabled",
    });
  }
  return controls;
}

/** Closed audit only: no argv, private paths, environment dumps or command output. */
export function serviceRequirementToolSource({
  logPath,
  endpoint,
  syntheticContext,
  nodeExecutable = process.execPath,
}: {
  logPath: string;
  endpoint: string;
  syntheticContext: boolean;
  nodeExecutable?: string;
}) {
  assert.ok(isAbsolute(nodeExecutable) && !/[\s\0]/u.test(nodeExecutable));
  assert.ok(isAbsolute(logPath));
  assert.ok(endpoint.startsWith("unix:///"));
  return `#!${nodeExecutable}
import {appendFileSync} from "node:fs";
import {basename} from "node:path";
const tool=basename(process.argv[1]);
const args=process.argv.slice(2);
const equal=(expected)=>JSON.stringify(args)===JSON.stringify(expected);
let operation="denied",output="";
if(${syntheticContext}&&tool==="docker"){
  if(equal(["context","show"])){operation="context-show";output="rehearsal-lab-service-proof";}
  else if(equal(["context","inspect","--format","{{json .Endpoints.docker.Host}}","rehearsal-lab-service-proof"])) {operation="context-inspect";output=JSON.stringify(${JSON.stringify(endpoint)});}
}
appendFileSync(${JSON.stringify(logPath)},JSON.stringify({tool,operation})+"\\n",{mode:0o600});
if(operation==="denied"){process.stderr.write("Unexpected infrastructure command denied by the service guard fixture.\\n");process.exit(91);}
process.stdout.write(output+"\\n");
`;
}

export function assertServiceRequirementResult({
  control,
  result,
  source,
  configPath,
  version,
}: {
  control: ServiceRequirementControl;
  result: ServiceControlResult;
  source: string;
  configPath: string;
  version: string;
}) {
  const envelope = parseJsonOutput(result.stdout, "Installed service guard");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.rehearsalVersion, version);
  if (control.expectedRefusal === null) {
    assert.equal(result.status, 0);
    assert.equal(envelope.command, "configuration");
    assert.equal(envelope.status, "success");
    const data = requireObject(envelope.data, "Configuration metadata");
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.path, configPath);
    assert.equal(data.sourceSha256, hash(source));
    const patch = requireObject(
      data.patchContract,
      "Read-only configuration contract",
    );
    assert.equal(patch.writesConfiguration, false);
    assert.equal(patch.executesProposedCommands, false);
    return;
  }
  assert.equal(envelope.status, "error");
  const error = requireObject(envelope.error, "Service refusal");
  const codes = {
    configuration_invalid: 2,
    runtime_dependency_failure: 9,
  } as const;
  assert.ok(
    error.category === "configuration_invalid" ||
      error.category === "runtime_dependency_failure",
  );
  assert.equal(result.status, codes[error.category]);
  assert.equal(
    error.code,
    control.syntheticContext
      ? "MANAGER_START_FAILED"
      : String(error.category).toUpperCase(),
  );
  const message = control.syntheticContext ? error.actual : error.message;
  assert.equal(typeof message, "string");
  assert.ok(
    String(message).includes(control.expectedRefusal),
    "The installed CLI did not refuse the intended required service.",
  );
}

export const executeServiceRequirement = async (
  request: ServiceControlRequest,
  { timeoutMs = 20000 }: { timeoutMs?: number } = {},
): Promise<ServiceControlResult> => {
  assert.notEqual(
    process.platform,
    "win32",
    "Service guard fixtures require POSIX process ownership.",
  );
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 20000,
  );
  return await new Promise<ServiceControlResult>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [request.executable, ...request.arguments],
      {
        cwd: request.project,
        env: request.environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let retirementBound: ReturnType<typeof setTimeout> | undefined;
    const failureMessage =
      "The isolated installed service guard exceeded its bound or could not execute.";
    const finish = (status: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      clearTimeout(retirementBound);
      child.stdout.destroy();
      child.stderr.destroy();
      if (failure || signal) reject(failure ?? new Error(failureMessage));
      else
        resolveResult({
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    };
    const terminate = () => {
      if (settled || failure) return;
      failure = new Error(failureMessage);
      // The CLI owns this detached group. Its separately detached manager is
      // reaped by the exact temporary config path in the caller's finally block.
      if (child.pid !== undefined && child.pid > 1) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            failure = new Error(
              "The isolated service guard could not retire its owned process group.",
            );
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      retirementBound = setTimeout(() => finish(null, "SIGKILL"), 2000);
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      if (settled || failure) return;
      bytes += chunk.byteLength;
      if (bytes > 256 * 1024) terminate();
      else chunks.push(chunk);
    };
    const bound = setTimeout(terminate, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", () => {
      terminate();
      finish(null, null);
    });
    child.once("close", finish);
  });
};

export async function exerciseServiceRequirements({
  project,
  profile,
  configurationSource,
  runId,
  version,
  runner = executeServiceRequirement,
}: {
  project: string;
  profile: ResourceProfile;
  configurationSource: string;
  runId: string;
  version: string;
  runner?: Runner;
}) {
  assert.match(runId, /^rtl-[a-f0-9]{10}$/u);
  const root = await realpath(project);
  const originalPath = resolve(root, "rehearsal.config.mjs");
  const original = await readFile(originalPath);
  assert.equal(original.toString("utf8"), configurationSource);
  const configuration = readProfileConfiguration(configurationSource);
  const runtime = objectAt(configuration, "runtime");
  assert.equal(
    runtime.projectId,
    `${runId}-${profile === "postgresql" ? "postgresql" : "supabase"}-rehearsal`,
  );
  assert.equal(
    runtime.target,
    profile === "postgresql" ? "postgresql" : "supabase",
  );
  const templatePath =
    profile === "postgresql" ? null : resolve(root, "benchmark/config.toml");
  const originalTemplate = templatePath ? await readFile(templatePath) : null;
  const controls = serviceRequirementControls({
    configuration,
    profile,
    template: originalTemplate?.toString("utf8") ?? null,
  });
  const directory = await mkdtemp(
    resolve(root, ".rehearsal/service-requirements-"),
  );
  const results: Array<{
    name: string;
    outcome: string;
    syntheticContextReads: number;
  }> = [];
  let primaryFailure: unknown;
  try {
    for (const control of controls) {
      const scope = resolve(directory, control.name);
      const bin = resolve(scope, "bin"),
        home = resolve(scope, "home"),
        temporary = resolve(scope, "tmp");
      await Promise.all(
        [bin, home, temporary].map((path) =>
          mkdir(path, { recursive: true, mode: 0o700 }),
        ),
      );
      const audit = resolve(scope, "infrastructure.ndjson");
      await writeFile(audit, "", { mode: 0o600, flag: "wx" });
      const source = serviceRequirementToolSource({
        logPath: audit,
        endpoint: `unix://${resolve(scope, "never-running.sock")}`,
        syntheticContext: control.syntheticContext,
      });
      for (const name of ["docker", "colima", "supabase"]) {
        const path = resolve(bin, name);
        await writeFile(path, source, { mode: 0o700, flag: "wx" });
        await chmod(path, 0o700);
      }
      const value = structuredClone(control.configuration);
      if (control.template !== null) {
        const path = resolve(scope, "config.toml");
        await writeFile(path, control.template, { mode: 0o600, flag: "wx" });
        objectAt(value, "supabase").rehearsalConfig = relative(root, path);
      }
      const path = resolve(scope, "rehearsal.config.mjs");
      const contents = serialize(value);
      await writeFile(path, contents, { mode: 0o600, flag: "wx" });
      const configPath = relative(root, path);
      const environment: NodeJS.ProcessEnv = {
        PATH: bin,
        HOME: home,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        CI: "1",
        NO_COLOR: "1",
        LANG: "C",
        LC_ALL: "C",
      };
      // Absolute unique config paths remain visible in both the CLI and its
      // detached manager argv; the maintained reaper never scans by project ID.
      const result = await runner({
        executable: resolve(root, "node_modules/.bin/rehearsal"),
        arguments: [control.command, `--config=${path}`, "--json", "--plain"],
        project: root,
        environment,
      });
      const metadata = await lstat(audit);
      assert.ok(
        metadata.isFile() &&
          !metadata.isSymbolicLink() &&
          metadata.size <= 8192,
      );
      const calls = (await readFile(audit, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => requireObject(JSON.parse(line), "Infrastructure audit"));
      if (!control.syntheticContext)
        assert.equal(
          calls.length,
          0,
          "An early service guard contacted infrastructure.",
        );
      else {
        assert.ok(calls.length >= 2 && calls.length <= 6);
        assert.ok(calls.some((call) => call.operation === "context-show"));
        assert.ok(calls.some((call) => call.operation === "context-inspect"));
        assert.ok(
          calls.every(
            (call) =>
              call.tool === "docker" &&
              ["context-show", "context-inspect"].includes(
                String(call.operation),
              ),
          ),
          "The guard attempted a non-metadata infrastructure command.",
        );
      }
      assertServiceRequirementResult({
        control,
        result,
        source: contents,
        configPath,
        version,
      });
      assert.equal(
        hash(await readFile(path)),
        hash(contents),
        "The public guard changed its proposed configuration.",
      );
      assert.equal(
        hash(await readFile(originalPath)),
        hash(original),
        "The reviewed configuration changed.",
      );
      if (templatePath && originalTemplate)
        assert.equal(
          hash(await readFile(templatePath)),
          hash(originalTemplate),
          "The reviewed template changed.",
        );
      results.push({
        name: control.name,
        outcome: control.expectedRefusal
          ? "required-service-refused"
          : "metadata-accepted",
        syntheticContextReads: calls.length,
      });
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      await reapOwnedWorkspaceProcesses(directory);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      assert.equal(hash(await readFile(originalPath)), hash(original));
      if (templatePath && originalTemplate)
        assert.equal(
          hash(await readFile(templatePath)),
          hash(originalTemplate),
        );
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (!primaryFailure && cleanupFailures.length) throw cleanupFailures[0];
  }
  return {
    cases: results,
    reviewedFilesPreserved: true,
    realInfrastructureCommands: 0,
    scope:
      "Installed public CLI configuration/start wiring with denied infrastructure and narrowly synthetic context metadata; not engine, Supabase-service or full-profile runtime acceptance.",
  };
}
