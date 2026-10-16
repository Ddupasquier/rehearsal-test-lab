/** Exact installed activity/history acceptance; no engine or database. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { removeWorkspace } from "./isolation.mts";
import { compareInstalledPackage, sha256File } from "./process.mts";
import { exerciseEditorReview } from "./editor-review.mts";

type Json = Record<string, unknown>;
const MAXIMUM_BYTES = 1_048_576;
const requireSafe = (condition: unknown): void => {
  if (!condition)
    throw new Error(
      "Observed idle activity violated its bounded safe contract.",
    );
};
const shape = (value: unknown, fields: string): Json => {
  requireSafe(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const row = value as Json,
    keys = fields.split(" "),
    actual = Object.keys(row);
  requireSafe(
    actual.length === keys.length && actual.every((key) => keys.includes(key)),
  );
  return row;
};
const timestamp = (v: unknown) =>
  typeof v === "string" &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const version = (v: unknown) =>
  typeof v === "string" &&
  v.length <= 64 &&
  /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(v);

/** Only the observed 0/1/2-record terminal-idle subset, not a general client parser. */
export function parseObservedIdleActivity(value: unknown) {
  requireSafe(Buffer.byteLength(JSON.stringify(value) ?? "") <= MAXIMUM_BYTES);
  const envelope = shape(
    value,
    "schemaVersion rehearsalVersion command status startedAt durationMs warnings data",
  );
  requireSafe(
    envelope.schemaVersion === 1 &&
      version(envelope.rehearsalVersion) &&
      envelope.command === "activity" &&
      envelope.status === "success" &&
      timestamp(envelope.startedAt),
  );
  requireSafe(
    typeof envelope.durationMs === "number" &&
      Number.isFinite(envelope.durationMs) &&
      envelope.durationMs >= 0,
  );
  requireSafe(
    Array.isArray(envelope.warnings) && envelope.warnings.length === 0,
  );
  const data = shape(envelope.data, "schemaVersion state operation recent");
  requireSafe(
    data.schemaVersion === 1 &&
      data.state === "idle" &&
      data.operation === null,
  );
  requireSafe(Array.isArray(data.recent) && data.recent.length <= 2);
  const ids: unknown[] = [];
  for (const [index, raw] of (data.recent as unknown[]).entries()) {
    const item = shape(raw, "kind rehearsalVersion progress");
    const state = index === 0 ? "completed" : "failed";
    requireSafe(
      item.kind === (index === 0 ? "baseline create" : "run") &&
        item.rehearsalVersion === envelope.rehearsalVersion,
    );
    const p = shape(
      item.progress,
      "schemaVersion operationId state startedAt updatedAt elapsedMilliseconds currentStage completedStages events truncated",
    );
    requireSafe(
      p.schemaVersion === 1 &&
        p.state === state &&
        typeof p.operationId === "string" &&
        /^[a-f0-9]{64}$/u.test(p.operationId),
    );
    requireSafe(
      timestamp(p.startedAt) &&
        timestamp(p.updatedAt) &&
        typeof p.elapsedMilliseconds === "number" &&
        Number.isSafeInteger(p.elapsedMilliseconds) &&
        p.elapsedMilliseconds >= 0,
    );
    requireSafe(
      p.currentStage === null &&
        Array.isArray(p.completedStages) &&
        p.completedStages.length === 0,
    );
    requireSafe(Array.isArray(p.events) && p.events.length === 2);
    for (const [offset, event] of (p.events as unknown[]).entries()) {
      const e = shape(event, "sequence code phase target at");
      requireSafe(
        e.sequence === offset + 1 &&
          e.code ===
            (offset === 0 ? "operation.started" : `operation.${state}`) &&
          e.phase === null &&
          e.target === null &&
          timestamp(e.at),
      );
    }
    const truncated = shape(p.truncated, "stages events");
    requireSafe(truncated.stages === false && truncated.events === false);
    ids.push(p.operationId);
  }
  requireSafe(new Set(ids).size === ids.length);
  return data;
}

const COMMAND_FAILURE =
  "Owned activity command failed, exceeded its bounds, or was interrupted; output withheld.";
/** Bound capture/lifetime and signal only a freshly owned process group. */
export function runActivityCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeout: number,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((done, reject) => {
    if (signal.aborted) {
      reject(
        new Error("Owned activity command was interrupted before launch."),
      );
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      bytes = 0,
      stopped = false,
      settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined,
      finalTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: string, status: number | null = null) => {
      if (settled) return;
      settled = true;
      for (const timer of [deadline, killTimer, finalTimer])
        clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(new Error(error));
      else done({ status, stdout });
    };
    const kill = (s: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, s);
        else child.kill(s);
      } catch {}
    };
    const abort = () => {
      if (stopped) return;
      stopped = true;
      kill("SIGINT");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
      finalTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(COMMAND_FAILURE);
      }, 4000);
    };
    const deadline = setTimeout(abort, timeout);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAXIMUM_BYTES) stdout += chunk.toString();
      else abort();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAXIMUM_BYTES) abort();
    });
    child.once("error", () => finish(COMMAND_FAILURE));
    child.once("close", (status) =>
      finish(stopped ? COMMAND_FAILURE : undefined, status),
    );
  });
}

export const activityEnvironment = (
  workspace: string,
  bin: string,
): NodeJS.ProcessEnv => ({
  PATH: bin,
  HOME: resolve(workspace, "home"),
  TMPDIR: resolve(workspace, "tmp"),
  TMP: resolve(workspace, "tmp"),
  TEMP: resolve(workspace, "tmp"),
  LANG: "C",
  NO_COLOR: "1",
  CI: "1",
});
export function createDeniedToolSource(
  node: string,
  audit: string,
  tool: "docker" | "colima" | "supabase",
) {
  if (!isAbsolute(node) || /\s/u.test(node))
    throw new Error("An absolute whitespace-free Node executable is required.");
  return `#!${node}\nimport{appendFileSync}from"node:fs";appendFileSync(${JSON.stringify(audit)},${JSON.stringify(`${tool}\n`)},{mode:0o600});process.exitCode=97;\n`;
}

async function snapshot(
  project: string,
  directory = project,
): Promise<[string, string][]> {
  const files: [string, string][] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await snapshot(project, file)));
    else if (entry.isSymbolicLink()) {
      const name = relative(project, file).split(sep).join("/");
      assert.equal(name, ".rehearsal/current", "Unexpected synthetic link.");
      const pointer = await readlink(file);
      assert.ok(
        Buffer.byteLength(pointer) <= 128 &&
          /^generations\/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(pointer),
        "The synthetic active pointer is not a canonical relative generation.",
      );
      files.push([name, `symlink:${pointer}`]);
    } else {
      assert.ok(entry.isFile() && (await stat(file)).size <= MAXIMUM_BYTES);
      files.push([relative(project, file), await sha256File(file)]);
    }
    assert.ok(files.length <= 128, "Synthetic inventory exceeded its bound.");
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

/** Inspect only owned files and the active pointer text; never follow a symlink. */
export const snapshotOperationActivityFiles = (project: string) =>
  snapshot(project);

async function createFixture(project: string, nested = false) {
  await mkdir(resolve(project, "database/migrations"), { recursive: true });
  const sql =
    "create table public.activity_probe(id integer primary key,title text not null)";
  const config = {
    schemaVersion: 1,
    project: { name: "activity-contract-fixture" },
    postgresql: {
      migrationDirectory: "database/migrations",
      runtimeWorkdir: ".rehearsal/runtime",
      image: "postgres:17-alpine",
    },
    baseline: {
      artifactDirectory: ".rehearsal",
      sanitizationPolicy: "policy.json",
    },
    application: {
      startCommand: "unused-command",
      proofCommand: "unused-proof",
      environmentFile: ".rehearsal/runtime.env",
    },
    runtime: {
      target: "postgresql",
      projectId: nested
        ? "activity-nested-rehearsal"
        : "activity-contract-rehearsal",
      databasePort: nested ? 58332 : 58322,
      applicationUrl: nested
        ? "http://127.0.0.1:58333"
        : "http://127.0.0.1:58323",
    },
    containerRuntime: { autoStartColima: false },
    safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
  };
  const columns = ["id", "title"].map((name) => ({
    name,
    action: name === "id" ? "KEEP EXACTLY" : "REPLACE WITH SYNTHETIC",
    generated: "NEVER",
    identity: "NO",
    foreignKey: null,
  }));
  const policy = {
    policyVersion: 1,
    migrationCutoff: "20261001000000",
    tables: [
      {
        name: "activity_probe",
        group: "synthetic",
        sourceRows: "STREAM AND SANITIZE",
        columns,
      },
    ],
  };
  const canary = "SYNTHETIC_ACTIVITY_ROW_NOT_TELEMETRY";
  const configurationPath = nested
    ? "infrastructure/rehearsal/rehearsal.config.mjs"
    : "rehearsal.config.mjs";
  await mkdir(dirname(resolve(project, configurationPath)), {
    recursive: true,
  });
  const files = {
    [configurationPath]: `// Reviewed synthetic fixture; preserve this comment.\nexport default ${JSON.stringify(config)};\n`,
    "policy.json": JSON.stringify(policy),
    "records.ndjson":
      (nested ? [1, 2] : [1])
        .map((id) =>
          JSON.stringify({
            table: "activity_probe",
            row: { id, title: canary },
          }),
        )
        .join("\n") + "\n",
    "ledger.json": JSON.stringify([
      { version: "20261001000000", name: "create_probe", statements: [sql] },
    ]),
    "database/migrations/20261001000000_create_probe.sql": sql + ";\n",
    "database/migrations/20261001000100_add_probe_note.sql":
      "alter table public.activity_probe add column note text;\n",
  };
  for (const [file, contents] of Object.entries(files))
    await writeFile(resolve(project, file), contents, {
      mode: 0o600,
      flag: "wx",
    });
  return canary;
}

export async function runOperationActivityAcceptance(
  artifactPath: string,
  reportDirectory: string,
  options: { editorReview?: boolean } = {},
) {
  if (process.platform === "win32")
    throw new Error(
      "Deny-only executable activity acceptance is unsupported on Windows; no shell fallback is permitted.",
    );
  const directory = resolve(reportDirectory),
    workspace = resolve(directory, "workspace");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  for (const name of ["home", "tmp", "fake-bin", "a", "b"])
    await mkdir(resolve(workspace, name), { mode: 0o700 });
  const controller = new AbortController(),
    cancel = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, cancel);
  const isolated = activityEnvironment(
    workspace,
    resolve(workspace, "fake-bin"),
  );
  const preparation = {
    ...isolated,
    PATH: process.env.PATH,
    npm_config_cache: resolve(workspace, "npm-cache"),
  };
  const owned = (
    program: string,
    args: string[],
    cwd = workspace,
    env: NodeJS.ProcessEnv = isolated,
    timeout = 15000,
    signal = controller.signal,
  ) => runActivityCommand(program, args, cwd, env, signal, timeout);
  const helper = async (mode: "inspect" | "reap", file: string) => {
    const module = mode === "inspect" ? "artifact.mts" : "isolation.mts";
    const body =
      mode === "inspect"
        ? "console.log(JSON.stringify(await owner.inspectArtifact(process.argv[1])));"
        : "await owner.reapOwnedWorkspaceProcesses(process.argv[1]);console.log('{}');";
    const result = await owned(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `import * as owner from ${JSON.stringify(new URL(module, import.meta.url).href)};${body}`,
        file,
      ],
      workspace,
      preparation,
      15000,
      mode === "reap" ? new AbortController().signal : controller.signal,
    );
    assert.equal(result.status, 0, "Bounded maintained helper failed.");
    return JSON.parse(result.stdout) as Json;
  };
  let artifact: Json | null = null,
    installedFiles = 0,
    preservationFiles = 0;
  let failure: string | null = null,
    cleanup = "pending";
  let editorReview: Awaited<ReturnType<typeof exerciseEditorReview>> | null =
    null;
  const safeActivitySamples: Record<
    "freshIdle" | "completed" | "failed" | "siblingIdle",
    Json | null
  > = { freshIdle: null, completed: null, failed: null, siblingIdle: null };
  const checks: { name: string; status: "passed" | "failed" }[] = [];
  const check = async (name: string, task: () => Promise<void>) => {
    try {
      await task();
      checks.push({ name, status: "passed" });
      console.log(`✓ Activity: ${name}`);
    } catch (error) {
      checks.push({ name, status: "failed" });
      throw error;
    }
  };
  try {
    const input = await lstat(artifactPath);
    assert.ok(input.isFile() && !input.isSymbolicLink());
    const sha256 = await sha256File(artifactPath),
      copied = resolve(directory, "candidate.tgz");
    await copyFile(artifactPath, copied);
    assert.equal(await sha256File(copied), sha256);
    assert.equal(await sha256File(artifactPath), sha256);
    const inspected = await helper("inspect", copied);
    artifact = shape(inspected.artifact, "name version sha256 bytes");
    assert.equal(artifact.sha256, sha256);
    assert.equal(artifact.name, "@rehearsal-db/core");
    assert.ok(version(artifact.version));
    assert.equal(typeof inspected.directory, "string");
    const extracted = resolve(String(inspected.directory));
    assert.ok(
      !relative(resolve(workspace, "tmp"), extracted).startsWith("..") &&
        extracted !== resolve(workspace, "tmp"),
    );
    await writeFile(
      resolve(workspace, "package.json"),
      JSON.stringify({ name: "activity-consumer", private: true }),
      { flag: "wx" },
    );
    const installation = await owned(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
        copied,
      ],
      workspace,
      preparation,
      180000,
    );
    assert.equal(installation.status, 0, "Bounded exact installation failed.");
    const packageRoot = resolve(workspace, "node_modules/@rehearsal-db/core");
    installedFiles = await compareInstalledPackage(
      resolve(extracted, "package"),
      packageRoot,
    );
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    assert.equal(typeof manifest.bin?.rehearsal, "string");
    const executable = await realpath(
      resolve(packageRoot, manifest.bin.rehearsal),
    );
    assert.ok(
      (await stat(executable)).isFile() &&
        !relative(packageRoot, executable).startsWith("..") &&
        !isAbsolute(relative(packageRoot, executable)),
    );
    const audit = resolve(workspace, "denied-tools.txt");
    await writeFile(audit, "", { mode: 0o600, flag: "wx" });
    for (const tool of ["docker", "colima", "supabase"] as const)
      await writeFile(
        resolve(workspace, "fake-bin", tool),
        createDeniedToolSource(process.execPath, audit, tool),
        { mode: 0o700, flag: "wx" },
      );
    const a = resolve(workspace, "a"),
      b = resolve(workspace, "b");
    for (const [project, name] of [
      [a, "activity-a"],
      [b, "activity-b"],
    ] as const)
      await writeFile(
        resolve(project, "package.json"),
        JSON.stringify({ name, private: true }),
        { flag: "wx" },
      );
    const cli = (project: string, args: string[]) =>
      owned(
        process.execPath,
        [executable, ...args, "--json", "--plain"],
        project,
      );
    const activity = async (project: string, count: number) => {
      const r = await cli(project, ["activity"]);
      assert.equal(r.status, 0);
      const envelope = JSON.parse(r.stdout);
      assert.equal(envelope.rehearsalVersion, artifact!.version);
      const data = parseObservedIdleActivity(envelope);
      assert.equal((data.recent as unknown[]).length, count);
      return data;
    };
    await check("fresh empty roots", async () => {
      safeActivitySamples.freshIdle = await activity(a, 0);
      await activity(b, 0);
    });
    const canary = await createFixture(a);
    await check("completed baseline", async () => {
      const r = await cli(a, [
        "baseline",
        "create",
        "--records=records.ndjson",
        "--ledger=ledger.json",
      ]);
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).status, "success");
      safeActivitySamples.completed = await activity(a, 1);
    });
    const before = await snapshot(a),
      siblingBefore = await snapshot(b);
    await check("refused run archived", async () => {
      const r = await cli(a, ["run"]);
      assert.equal(r.status, 6);
      const response = JSON.parse(r.stdout);
      assert.equal(response.status, "error");
      assert.equal(response.error.category, "migration_candidate_failure");
      assert.equal(response.error.code, "CANDIDATE_CONFIRMATION_REQUIRED");
      safeActivitySamples.failed = await activity(a, 2);
      assert.deepEqual(
        (safeActivitySamples.failed.recent as unknown[])[0],
        (safeActivitySamples.completed!.recent as unknown[])[0],
      );
    });
    await check("read-only history unchanged", async () => {
      assert.deepEqual(await activity(a, 2), safeActivitySamples.failed);
      assert.deepEqual(await activity(a, 2), safeActivitySamples.failed);
    });
    await check("sibling history isolated", async () => {
      safeActivitySamples.siblingIdle = await activity(b, 0);
      assert.deepEqual(await snapshot(b), siblingBefore);
    });
    await check("files and package preserved", async () => {
      assert.deepEqual(await snapshot(a), before);
      preservationFiles = before.length + siblingBefore.length;
      assert.equal(
        await compareInstalledPackage(
          resolve(extracted, "package"),
          packageRoot,
        ),
        installedFiles,
      );
      assert.equal(await sha256File(copied), sha256);
    });
    await check("no tool calls or locks", async () => {
      assert.equal(await readFile(audit, "utf8"), "");
      assert.deepEqual(
        await readdir(resolve(workspace, "tmp/rehearsal-db-operation-locks")),
        [],
      );
      assert.equal(JSON.stringify(safeActivitySamples).includes(canary), false);
    });
    if (options.editorReview) {
      editorReview = await exerciseEditorReview({
        root: a,
        nested: b,
        cli,
        createNestedFixture: () => createFixture(b, true),
        snapshot,
      });
      assert.equal(editorReview.status, "passed");
      assert.equal(await readFile(audit, "utf8"), "");
      assert.deepEqual(
        await readdir(resolve(workspace, "tmp/rehearsal-db-operation-locks")),
        [],
      );
      assert.equal(
        await compareInstalledPackage(
          resolve(extracted, "package"),
          packageRoot,
        ),
        installedFiles,
      );
    }
  } catch {
    failure =
      "Installed activity assertion or bounded preparation failed; raw output withheld.";
  } finally {
    try {
      await helper("reap", workspace);
      if (failure === null) {
        await removeWorkspace(workspace);
        cleanup = "removed";
      } else cleanup = "retained-for-diagnosis";
    } catch {
      failure ??= "Owned activity cleanup could not be verified.";
      cleanup = "failed-owned-cleanup";
    } finally {
      for (const signal of signals) process.removeListener(signal, cancel);
    }
  }
  const report = {
    schemaVersion: 1,
    task: "VSC-138",
    status:
      failure === null &&
      checks.length === 7 &&
      (!options.editorReview || editorReview?.status === "passed") &&
      Object.values(safeActivitySamples).every(Boolean)
        ? "passed"
        : "failed",
    artifact,
    installedFiles,
    checks,
    safeActivitySamples,
    ...(options.editorReview ? { editorReview } : {}),
    preservation: { filesCompared: preservationFiles },
    cleanup,
    failure,
    limitations: [
      "Terminal-idle success/preflight-refusal metadata only; not a general live-progress acceptance scenario.",
      "No real engine, database, application or hosted provider is started or inspected.",
      "No cancellation, VS Code receipt/reload, accessibility, native orphan or history-retention-limit proof.",
      "Deny-only executable acceptance is unsupported on Windows; pure protocol tests are portable.",
    ],
  };
  await writeFile(
    resolve(directory, "operation-activity.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return report;
}
