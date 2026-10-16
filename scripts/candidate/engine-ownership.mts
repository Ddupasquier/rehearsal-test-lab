/** Installed public-CLI ownership decisions against a strict simulated engine. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspectArtifact } from "./artifact.mts";
import {
  compareInstalledPackage,
  parseJsonOutput,
  sha256File,
} from "./process.mts";
import { reapOwnedWorkspaceProcesses, removeWorkspace } from "./isolation.mts";

export const SIMULATED_BOOT = "11111111-2222-4333-8444-555555555555";
const ENDPOINT = "unix:///tmp/rehearsal-lab-simulated-engine.sock";
const RECEIPT = ".rehearsal/container-engine-start-receipt.json";
const MAXIMUM_BYTES = 65536;

export interface EngineDoubleState {
  running: boolean;
  boot: string;
  context: string;
  endpoint: string;
  targets: { name: string; projectId: string; running: boolean }[];
  resources: { kind: "container" | "volume"; name: string }[];
  persistentVolumes: string[];
  events: string[];
  unexpected: number;
  interruptStart: boolean;
  failTargetStop: boolean;
  foreignRunning: boolean;
  foreignAtFinalScan: boolean;
  scans: number;
  holdNextInfo: boolean;
  holdReached: boolean;
  holdReleased: boolean;
}

export const newEngineDoubleState = (): EngineDoubleState => ({
  running: false,
  boot: SIMULATED_BOOT,
  context: "colima",
  endpoint: ENDPOINT,
  targets: [],
  resources: [],
  persistentVolumes: ["synthetic-persistent-data"],
  events: [],
  unexpected: 0,
  interruptStart: false,
  failTargetStop: false,
  foreignRunning: false,
  foreignAtFinalScan: false,
  scans: 0,
  holdNextInfo: false,
  holdReached: false,
  holdReleased: false,
});

/** Self-contained so the exact same decision function runs in each fake executable. */
export function stepEngineDouble(
  state: EngineDoubleState,
  tool: string,
  input: string[],
) {
  let args = [...input];
  const answer = { status: 97, stdout: "", waitMilliseconds: 0, signal: false };
  let event = "unexpected-command";
  let valid =
    state.events.length < 1000 &&
    args.length <= 30 &&
    args.every((a) => a.length <= 2000);
  if (args[0] === "--host") {
    if (tool !== "docker" || args[1] !== state.endpoint) valid = false;
    args = args.slice(2);
  }
  const key = args.join(" ");
  if (valid && tool === "colima") {
    if (key === "version") {
      event = "colima.version";
      answer.status = 0;
      answer.stdout = "simulated-colima";
    } else if (key === "list --json") {
      event = "colima.list";
      answer.status = 0;
      answer.stdout = JSON.stringify({
        name: "default",
        status: state.running ? "Running" : "Stopped",
      });
    } else if (key === "start") {
      state.running = true;
      event = "colima.start";
      answer.status = state.interruptStart ? 1 : 0;
      answer.signal = state.interruptStart;
    } else if (key === "ssh -- cat /proc/sys/kernel/random/boot_id") {
      event = "colima.boot";
      answer.status = state.running ? 0 : 1;
      answer.stdout = state.boot;
    } else if (key === "ssh -- df -Pk /var/lib/docker") {
      event = "colima.disk";
      answer.status = 0;
      answer.stdout =
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 104857600 1048576 103809024 1% /var/lib/docker\n";
    } else if (key === "stop") {
      state.running = false;
      event = "colima.stop";
      answer.status = 0;
    }
  } else if (valid && tool === "docker") {
    if (key === "context show") {
      event = "docker.context.show";
      answer.status = 0;
      answer.stdout = state.context;
    } else if (
      args.length === 5 &&
      args[0] === "context" &&
      args[1] === "inspect" &&
      args[2] === "--format" &&
      args[3] === "{{json .Endpoints.docker.Host}}" &&
      args[4] === state.context
    ) {
      event = "docker.context.inspect";
      answer.status = 0;
      answer.stdout = JSON.stringify(state.endpoint);
    } else if (key === "info") {
      const hold = state.holdNextInfo;
      state.holdNextInfo = false;
      if (hold) state.holdReached = true;
      event = "docker.info";
      answer.status = state.running ? 0 : 1;
      answer.waitMilliseconds = hold ? 10_000 : 0;
    } else if (
      args.length === 3 &&
      args[0] === "info" &&
      args[1] === "--format" &&
      args[2] ===
        "{{.NCPU}} {{.MemTotal}} {{.ContainersRunning}} {{.Containers}}"
    ) {
      event = "docker.capacity.unavailable";
      answer.status = 1;
    } else if (key === "image inspect postgres:17-alpine") {
      event = "docker.image.refused";
      answer.status = 1;
    } else if (key === "container ls --quiet") {
      state.scans += 1;
      if (state.foreignAtFinalScan && state.scans >= 2)
        state.foreignRunning = true;
      event = "docker.running-scan";
      answer.status = 0;
      answer.stdout = [
        ...state.targets.filter((t) => t.running).map((t) => t.projectId),
        ...(state.foreignRunning ? ["foreign-workload"] : []),
      ].join("\n");
    } else if (
      (args[0] === "container" || args[0] === "volume") &&
      args[1] === "inspect" &&
      (args.length === 3 ||
        (args.length === 5 &&
          args[2] === "--format" &&
          args[3] ===
            (args[0] === "container"
              ? "{{json .Config.Labels}}"
              : "{{json .Labels}}"))) &&
      state.resources.some((r) => r.kind === args[0] && r.name === args.at(-1))
    ) {
      const target = state.targets.find((t) => t.name === args.at(-1));
      if (args[0] === "volume" || !target) {
        event = "docker.resource.absent";
        answer.status = 1;
      } else if (args.length === 3) {
        event = `docker.container.exists:${target.projectId}`;
        answer.status = 0;
        answer.stdout = "[]";
      } else if (
        args.length === 5 &&
        args[2] === "--format" &&
        args[3] === "{{json .Config.Labels}}"
      ) {
        event = `docker.container.labels:${target.projectId}`;
        answer.status = 0;
        answer.stdout = JSON.stringify({
          "com.rehearsal-db.project": target.projectId,
        });
      }
    } else if (args.length === 2 && args[0] === "stop") {
      const target = state.targets.find((t) => t.name === args[1]);
      if (target) {
        event = `docker.${state.failTargetStop ? "stop-failed" : "stop"}:${target.projectId}`;
        answer.status = state.failTargetStop ? 1 : 0;
        if (!state.failTargetStop) {
          target.running = false;
          answer.stdout = target.name;
        }
      }
    }
  }
  if (event === "unexpected-command") state.unexpected += 1;
  state.events.push(event);
  return answer;
}

export function fakeEngineExecutable(
  node: string,
  stateFile: string,
  tool: "docker" | "colima",
) {
  if (!isAbsolute(node) || /\s/u.test(node))
    throw new Error("An absolute whitespace-free Node executable is required.");
  return `#!${node}\nimport{readFileSync,writeFileSync,renameSync}from"node:fs";\nconst step=${stepEngineDouble.toString()};\nconst path=${JSON.stringify(stateFile)};\nconst bytes=readFileSync(path);if(bytes.length>65536)process.exit(98);\nconst state=JSON.parse(bytes.toString());\nconst result=step(state,${JSON.stringify(tool)},process.argv.slice(2));\nconst next=path+".next-"+process.pid;writeFileSync(next,JSON.stringify(state),{mode:0o600,flag:"wx"});renameSync(next,path);\nif(result.waitMilliseconds){const until=Date.now()+result.waitMilliseconds;while(!JSON.parse(readFileSync(path,"utf8")).holdReleased){if(Date.now()>=until)process.exit(96);await new Promise(r=>setTimeout(r,25));}}\nif(result.signal)process.kill(process.pid,"SIGTERM");\nif(result.stdout)process.stdout.write(result.stdout+"\\n");\nprocess.exitCode=result.status;\n`;
}

export function isolatedEngineEnvironment(
  workspace: string,
  bin: string,
): NodeJS.ProcessEnv {
  return {
    PATH: bin,
    HOME: resolve(workspace, "home"),
    TMPDIR: resolve(workspace, "tmp"),
    TMP: resolve(workspace, "tmp"),
    TEMP: resolve(workspace, "tmp"),
    LANG: "C",
    CI: "1",
    NO_COLOR: "1",
  };
}

export function requireEngineTrace(state: EngineDoubleState) {
  assert.equal(
    state.unexpected,
    0,
    "An unexpected simulated tool invocation occurred.",
  );
  assert.ok(
    state.events.length <= 1000,
    "Simulated command history exceeded its bound.",
  );
  assert.deepEqual(
    state.persistentVolumes,
    ["synthetic-persistent-data"],
    "Synthetic persistent identities changed.",
  );
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
interface CliResult {
  status: number | null;
  stdout: string;
}
export const runOwnedSimulationCommand = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<CliResult> =>
  new Promise((done, reject) => {
    if (signal.aborted) {
      reject(new Error("Owned simulation was interrupted before launch."));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      bytes = 0,
      overflow = false,
      expired = false,
      interrupted = false,
      stopping = false,
      settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    let forceBound: ReturnType<typeof setTimeout> | undefined;
    const clean = () => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      if (forceBound) clearTimeout(forceBound);
      signal.removeEventListener("abort", cancel);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clean();
      reject(new Error(message));
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGINT");
      } catch {
        /* Outer workspace cleanup verifies remaining owned children. */
      }
      force = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2000);
      forceBound = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        fail(
          "Owned simulation process did not close after bounded cancellation.",
        );
      }, 4000);
    };
    const cancel = () => {
      interrupted = true;
      stop();
    };
    const timer = setTimeout(() => {
      expired = true;
      stop();
    }, timeoutMilliseconds);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAXIMUM_BYTES) stdout += chunk.toString();
      else if (!overflow) {
        overflow = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAXIMUM_BYTES && !overflow) {
        overflow = true;
        stop();
      }
    });
    child.once("error", () => {
      fail("Owned simulation process could not start.");
    });
    child.once("close", (status) => {
      if (settled) return;
      if (overflow || expired || interrupted) {
        fail(
          "Owned simulation process exceeded its output/time bound or was interrupted.",
        );
        return;
      }
      settled = true;
      clean();
      done({ status, stdout });
    });
  });

const policy = {
  policyVersion: 1,
  migrationCutoff: "20261001000000",
  tables: [
    {
      name: "engine_probe",
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
          name: "value",
          action: "REPLACE WITH SYNTHETIC",
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
      ],
    },
  ],
};

export async function runEngineOwnershipAcceptance(
  artifactPath: string,
  reportDirectory: string,
) {
  if (process.platform === "win32")
    throw new Error(
      "Engine-ownership executable simulation is unsupported on Windows; no shell fallback is allowed.",
    );
  const directory = resolve(reportDirectory);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const workspace = resolve(directory, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const cases: { name: string; status: "passed" | "failed" }[] = [];
  let artifact: Awaited<ReturnType<typeof inspectArtifact>>["artifact"] | null =
    null;
  let extracted: string | null = null,
    installedFiles = 0,
    cleanup = "pending",
    failure: string | null = null;
  const interruption = new AbortController();
  const cancel = () => interruption.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, cancel);
  try {
    const source = await lstat(artifactPath);
    assert.ok(
      source.isFile() && !source.isSymbolicLink(),
      "An exact regular package artifact is required.",
    );
    const beforeHash = await sha256File(artifactPath);
    const copied = resolve(directory, "candidate.tgz");
    await copyFile(artifactPath, copied);
    assert.equal(
      await sha256File(copied),
      beforeHash,
      "Copied candidate bytes changed.",
    );
    assert.equal(
      await sha256File(artifactPath),
      beforeHash,
      "Selected candidate changed while copying.",
    );
    const inspected = await inspectArtifact(copied);
    extracted = inspected.directory;
    artifact = inspected.artifact;
    await writeFile(
      resolve(workspace, "package.json"),
      JSON.stringify({ name: "engine-ownership-consumer", private: true }),
      { flag: "wx" },
    );
    const installation = await runOwnedSimulationCommand(
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
      process.env,
      interruption.signal,
      180_000,
    );
    assert.equal(
      installation.status,
      0,
      "Bounded candidate installation failed.",
    );
    const packageRoot = resolve(workspace, "node_modules/@rehearsal-db/core");
    installedFiles = await compareInstalledPackage(
      resolve(extracted, "package"),
      packageRoot,
    );
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    assert.equal(typeof manifest.bin?.rehearsal, "string");
    const declaredBin = await realpath(
      resolve(packageRoot, manifest.bin.rehearsal),
    );
    assert.ok(
      !relative(packageRoot, declaredBin).startsWith("..") &&
        !isAbsolute(relative(packageRoot, declaredBin)),
      "Public executable escaped its installed package.",
    );
    await mkdir(resolve(workspace, "home"));
    await mkdir(resolve(workspace, "tmp"));
    let index = 0;
    const runCase = async (
      name: string,
      action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
    ) => {
      console.log(`→ Engine ownership: ${name}`);
      const f = await fixture(++index);
      try {
        await action(f);
        requireEngineTrace(await f.state());
        cases.push({ name, status: "passed" });
        console.log(`✓ Engine ownership: ${name}`);
      } catch (error) {
        cases.push({ name, status: "failed" });
        throw error;
      }
    };
    const fixture = async (number: number) => {
      const project = resolve(workspace, `case-${number}`),
        fakeBin = resolve(project, "fake-bin"),
        stateFile = resolve(project, "engine.json");
      const projectId = `engine-case-${number}-rehearsal`;
      await mkdir(fakeBin, { recursive: true, mode: 0o700 });
      await mkdir(resolve(project, "database/migrations"), { recursive: true });
      await writeFile(
        resolve(project, "package.json"),
        JSON.stringify({ name: `engine-case-${number}`, private: true }),
      );
      const initialState = newEngineDoubleState();
      initialState.resources = [projectId, `${projectId}-secondary`].flatMap(
        (id) => [
          { kind: "container" as const, name: `${id}-postgresql` },
          { kind: "volume" as const, name: `${id}-postgresql-data` },
        ],
      );
      await writeFile(stateFile, JSON.stringify(initialState), {
        mode: 0o600,
        flag: "wx",
      });
      for (const tool of ["docker", "colima"] as const) {
        const file = resolve(fakeBin, tool);
        await writeFile(
          file,
          fakeEngineExecutable(process.execPath, stateFile, tool),
          { mode: 0o700, flag: "wx" },
        );
      }
      const config = (
        id: string,
        port: number,
        artifactDirectory = ".rehearsal",
      ) => ({
        schemaVersion: 1,
        project: { name: id },
        postgresql: {
          migrationDirectory: "database/migrations",
          runtimeWorkdir: `${artifactDirectory}/runtime`,
          image: "postgres:17-alpine",
        },
        baseline: { artifactDirectory, sanitizationPolicy: "policy.json" },
        application: {
          startCommand: "unused-project-command",
          proofCommand: "unused-project-proof",
          environmentFile: `${artifactDirectory}/runtime.env`,
        },
        containerRuntime: {
          autoStartColima: true,
          stopOwnedColimaWhenIdle: true,
        },
        runtime: {
          target: "postgresql",
          projectId: id,
          databasePort: port,
          applicationUrl: `http://127.0.0.1:${port + 1}`,
        },
        safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
      });
      const configuration = config(projectId, 58322);
      const configPath = resolve(project, "rehearsal.config.mjs");
      await writeFile(
        configPath,
        `export default ${JSON.stringify(configuration)};\n`,
      );
      const saveState = async (s: EngineDoubleState) => {
        const next = `${stateFile}.reviewed-next`;
        await writeFile(next, JSON.stringify(s), { mode: 0o600, flag: "wx" });
        await rename(next, stateFile);
      };
      const state = async (): Promise<EngineDoubleState> =>
        JSON.parse(await readFile(stateFile, "utf8"));
      const cli = (args: string[]) =>
        runOwnedSimulationCommand(
          process.execPath,
          [declaredBin, ...args, "--json", "--plain"],
          project,
          isolatedEngineEnvironment(workspace, fakeBin),
          interruption.signal,
          45_000,
        );
      const succeed = async (args: string[]) => {
        const r = await cli(args);
        assert.equal(r.status, 0, "Expected public CLI success.");
        assert.equal(
          parseJsonOutput(r.stdout, "Public result").status,
          "success",
        );
        return r;
      };
      const receipt = resolve(project, RECEIPT);
      const acquire = async (interrupted = false) => {
        await writeFile(
          resolve(project, "policy.json"),
          JSON.stringify(policy),
        );
        await writeFile(
          resolve(project, "records.ndjson"),
          `${JSON.stringify({ table: "engine_probe", row: { id: 1, value: "Synthetic probe" } })}\n`,
        );
        const sql =
          "create table public.engine_probe(id integer primary key,value text not null)";
        await writeFile(
          resolve(project, "ledger.json"),
          JSON.stringify([
            {
              version: "20261001000000",
              name: "create_probe",
              statements: [sql],
            },
          ]),
        );
        await writeFile(
          resolve(
            project,
            "database/migrations/20261001000000_create_probe.sql",
          ),
          `${sql};\n`,
        );
        await succeed([
          "baseline",
          "create",
          "--records=records.ndjson",
          "--ledger=ledger.json",
        ]);
        assert.equal(
          (await state()).events.length,
          0,
          "Baseline preparation must not inspect or start an engine.",
        );
        if (interrupted) {
          const s = await state();
          s.interruptStart = true;
          await saveState(s);
        }
        const r = await cli(["reset"]);
        assert.notEqual(
          r.status,
          0,
          "Synthetic reset must refuse before database/image creation.",
        );
        const s = await state();
        requireEngineTrace(s);
        assert.equal(s.events.filter((e) => e === "colima.start").length, 1);
        assert.equal(s.running, true);
        if (interrupted) {
          await assert.rejects(stat(receipt), { code: "ENOENT" });
          return;
        }
        assert.ok(s.events.includes("docker.image.refused"));
        const st = await stat(receipt);
        assert.equal(st.mode & 0o777, 0o600);
        const value = JSON.parse(await readFile(receipt, "utf8"));
        assert.equal(value.projectRootSha256, digest(resolve(project)));
        assert.equal(value.projectId, projectId);
        assert.equal(
          value.engineIdentity,
          digest(JSON.stringify({ context: "colima", endpoint: ENDPOINT })),
        );
        assert.equal(value.bootId, SIMULATED_BOOT);
        assert.match(value.operationId, /^[a-zA-Z0-9_-]{8,128}$/u);
        assert.ok(Number.isFinite(Date.parse(value.createdAt)));
      };
      const preserve = async () => {
        const before = await state();
        await succeed(["stop"]);
        const after = await state();
        assert.equal(after.running, true);
        for (const event of ["colima.start", "colima.stop"])
          assert.equal(
            after.events.filter((e) => e === event).length,
            before.events.filter((e) => e === event).length,
          );
        requireEngineTrace(after);
      };
      const target = (id = projectId) => ({
        name: `${id}-postgresql`,
        projectId: id,
        running: true,
      });
      return {
        project,
        projectId,
        config,
        configuration,
        configPath,
        cli,
        succeed,
        receipt,
        state,
        saveState,
        acquire,
        preserve,
        target,
      };
    };

    await runCase(
      "owned startup, guarded stop and repeated stop",
      async (f) => {
        await f.acquire();
        const s = await f.state();
        s.targets = [f.target()];
        await f.saveState(s);
        await f.succeed(["stop"]);
        let after = await f.state();
        assert.equal(after.running, false);
        assert.ok(
          after.events.indexOf(`docker.stop:${f.projectId}`) <
            after.events.indexOf("colima.stop"),
        );
        await assert.rejects(stat(f.receipt), { code: "ENOENT" });
        await f.succeed(["stop"]);
        after = await f.state();
        assert.equal(after.events.filter((e) => e === "colima.stop").length, 1);
        after.running = true;
        after.boot = "22222222-2222-4333-8444-555555555555";
        await f.saveState(after);
        await f.preserve();
      },
    );
    await runCase(
      "missing ownership preserves a manually started engine",
      async (f) => {
        const s = await f.state();
        s.running = true;
        await f.saveState(s);
        await f.preserve();
      },
    );
    await runCase(
      "unsafe, malformed and foreign receipt refusal",
      async (f) => {
        await f.acquire();
        const original = await readFile(f.receipt);
        await chmod(f.receipt, 0o644);
        await f.preserve();
        await chmod(f.receipt, 0o600);
        const value = JSON.parse(original.toString());
        value.projectRootSha256 = "f".repeat(64);
        await writeFile(f.receipt, JSON.stringify(value));
        await f.preserve();
        await writeFile(f.receipt, "{malformed");
        await f.preserve();
        await rm(f.receipt);
        const saved = resolve(f.project, "saved-receipt.json");
        await writeFile(saved, original, { mode: 0o600, flag: "wx" });
        await symlink(saved, f.receipt);
        await f.preserve();
      },
    );
    await runCase(
      "changed boot, endpoint and non-Colima context refusal",
      async (f) => {
        await f.acquire();
        let s = await f.state();
        s.boot = "22222222-2222-4333-8444-555555555555";
        await f.saveState(s);
        await f.preserve();
        s = await f.state();
        s.boot = SIMULATED_BOOT;
        s.endpoint = "unix:///tmp/rehearsal-lab-changed-engine.sock";
        await f.saveState(s);
        await f.preserve();
        s = await f.state();
        s.endpoint = ENDPOINT;
        s.context = "desktop-linux";
        await f.saveState(s);
        await f.preserve();
      },
    );
    await runCase("shared workload and final-scan race refusal", async (f) => {
      await f.acquire();
      let s = await f.state();
      s.foreignRunning = true;
      await f.saveState(s);
      await f.preserve();
      s = await f.state();
      s.foreignRunning = false;
      s.foreignAtFinalScan = true;
      s.scans = 0;
      await f.saveState(s);
      await f.preserve();
      assert.equal((await f.state()).scans, 2);
    });
    await runCase("disabled policy preserves engine", async (f) => {
      await f.acquire();
      f.configuration.containerRuntime.stopOwnedColimaWhenIdle = false;
      await writeFile(
        f.configPath,
        `export default ${JSON.stringify(f.configuration)};\n`,
      );
      await f.preserve();
    });
    await runCase("failed target stop cannot release engine", async (f) => {
      await f.acquire();
      const s = await f.state();
      s.targets = [f.target()];
      s.failTargetStop = true;
      await f.saveState(s);
      const r = await f.cli(["stop"]);
      assert.notEqual(r.status, 0);
      const after = await f.state();
      assert.equal(after.running, true);
      assert.equal(after.targets[0]!.running, true);
      assert.ok(!after.events.includes("colima.stop"));
      assert.ok(
        after.events.indexOf("docker.capacity.unavailable") >
          after.events.indexOf(`docker.stop-failed:${f.projectId}`),
      );
    });
    await runCase(
      "interrupted startup grants no shutdown ownership",
      async (f) => {
        await f.acquire(true);
        await f.preserve();
      },
    );
    await runCase(
      "dependent targets stop in reverse order before engine",
      async (f) => {
        await f.acquire();
        const second = `${f.projectId}-secondary`;
        const dependent = f.config(second, 58332, "publication/.rehearsal");
        await writeFile(
          resolve(f.project, "secondary.config.mjs"),
          `export default ${JSON.stringify(dependent)};\n`,
        );
        await writeFile(
          f.configPath,
          `export default ${JSON.stringify({ ...f.configuration, dependentTargets: [{ name: "secondary", configPath: "secondary.config.mjs" }] })};\n`,
        );
        const s = await f.state();
        s.targets = [f.target(), f.target(second)];
        await f.saveState(s);
        await f.succeed(["stop"]);
        const after = await f.state();
        assert.deepEqual(
          after.events.filter(
            (e) => e.startsWith("docker.stop:") || e === "colima.stop",
          ),
          [
            `docker.stop:${second}`,
            `docker.stop:${f.projectId}`,
            "colima.stop",
          ],
        );
      },
    );
    await runCase(
      "concurrent public mutation preserves first operation",
      async (f) => {
        await f.acquire();
        const s = await f.state();
        s.holdNextInfo = true;
        await f.saveState(s);
        const first = f.cli(["stop"]);
        // Attach immediately: even a failed hold must await and clean its owned child.
        const settled = first.then(
          (result) => ({ result }),
          () => ({ result: null }),
        );
        try {
          const deadline = Date.now() + 5000;
          while (!(await f.state()).holdReached && Date.now() < deadline)
            await delay(25);
          assert.equal(
            (await f.state()).holdReached,
            true,
            "First operation did not reach its bounded owned hold.",
          );
          const heldReceipt = await readFile(f.receipt);
          const heldEvents = (await f.state()).events;
          const second = await f.cli(["stop"]);
          assert.equal(
            second.status,
            10,
            "Concurrent mutation must refuse its live operation lock.",
          );
          const refusal = parseJsonOutput(second.stdout, "Concurrent refusal");
          assert.equal(refusal.status, "error");
          const error = refusal.error as Record<string, unknown>;
          assert.equal(error.category, "internal_failure");
          assert.equal(error.code, "INTERNAL_FAILURE");
          assert.match(
            String(error.message),
            /^Another Rehearsal operation is already running for this project \(PID \d+\)\.$/u,
          );
          assert.deepEqual(await readFile(f.receipt), heldReceipt);
          assert.deepEqual(
            (await f.state()).events,
            heldEvents,
            "Refused concurrent operation must not call an engine tool.",
          );
        } finally {
          const held = await f.state();
          held.holdReleased = true;
          await f.saveState(held);
          assert.equal((await settled).result?.status, 0);
        }
        assert.equal(
          (await f.state()).events.filter((e) => e === "colima.stop").length,
          1,
        );
      },
    );
    const remainingLocks = await readdir(
      resolve(workspace, "tmp/rehearsal-db-operation-locks"),
    ).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return [];
      throw error;
    });
    assert.deepEqual(
      remainingLocks,
      [],
      "A simulated project operation lock remained before workspace removal.",
    );
    assert.equal(
      await compareInstalledPackage(resolve(extracted, "package"), packageRoot),
      installedFiles,
    );
  } catch {
    failure =
      "An installed engine-ownership assertion or bounded preparation failed; raw output is withheld.";
  } finally {
    try {
      await reapOwnedWorkspaceProcesses(workspace);
      if (failure === null) {
        await removeWorkspace(workspace);
        cleanup = "removed";
      } else cleanup = "retained-for-diagnosis";
    } catch {
      cleanup = "failed-owned-process-cleanup";
      failure ??= "Owned simulation cleanup could not be verified.";
    }
    try {
      if (extracted) await rm(extracted, { recursive: true, force: true });
    } catch {
      failure ??= "Owned artifact inspection cleanup could not be verified.";
    } finally {
      for (const signal of signals) process.removeListener(signal, cancel);
    }
  }
  const report = {
    schemaVersion: 1,
    task: "RDB-116",
    status: failure === null && cases.length === 10 ? "passed" : "failed",
    artifact,
    installedFiles,
    cases,
    cleanup,
    failure,
    limitations: [
      "Executable engine simulation only: no real Docker/Colima invocation, VM startup/shutdown, memory release or native-provider claim.",
      "No SQL/full database restore is simulated or certified; target image availability is deliberately refused after startup ownership acquisition.",
      "Preserved volume identities and the absence of deletion calls are simulated trace evidence, not physical database/Storage persistence proof.",
      "Deterministic workload interleavings and public project-operation refusal do not eliminate races with external Docker clients.",
      "Windows executable simulation is unsupported; pure decision tests remain portable.",
    ],
  };
  await writeFile(
    resolve(directory, "engine-ownership.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return report;
}
