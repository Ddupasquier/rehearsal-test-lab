import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  fakeEngineExecutable,
  isolatedEngineEnvironment,
  newEngineDoubleState,
  requireEngineTrace,
  runOwnedSimulationCommand,
  stepEngineDouble,
} from "../scripts/candidate/engine-ownership.mts";

test("simulated tools fail closed on unknown, destructive, redirected and SQL commands", () => {
  for (const [tool, args] of [
    ["docker", ["system", "prune", "--all"]],
    ["docker", ["run", "postgres:17-alpine"]],
    ["docker", ["exec", "database", "psql"]],
    ["docker", ["volume", "inspect", "--unsafe", "missing"]],
    ["docker", ["container", "inspect", "other-project"]],
    ["docker", ["--host", "ssh://production.invalid", "info"]],
    ["colima", ["start", "--memory", "8"]],
    ["unknown", ["info"]],
  ] as const) {
    const state = newEngineDoubleState();
    const result = stepEngineDouble(state, tool, [...args]);
    assert.equal(result.status, 97);
    assert.equal(state.unexpected, 1);
    assert.deepEqual(state.events, ["unexpected-command"]);
    assert.throws(() => requireEngineTrace(state), /unexpected/u);
  }
});

test("the positive double models engine ownership observations without database emulation", () => {
  const s = newEngineDoubleState();
  assert.equal(stepEngineDouble(s, "docker", ["info"]).status, 1);
  assert.equal(stepEngineDouble(s, "colima", ["start"]).status, 0);
  assert.equal(s.running, true);
  assert.equal(
    stepEngineDouble(s, "docker", ["image", "inspect", "postgres:17-alpine"])
      .status,
    1,
  );
  s.targets = [
    {
      projectId: "synthetic-target",
      name: "synthetic-target-postgresql",
      running: true,
    },
  ];
  assert.equal(
    stepEngineDouble(s, "docker", ["stop", "synthetic-target-postgresql"])
      .status,
    0,
  );
  assert.equal(s.targets[0]!.running, false);
  assert.equal(
    stepEngineDouble(s, "docker", ["container", "ls", "--quiet"]).stdout,
    "",
  );
  stepEngineDouble(s, "colima", ["stop"]);
  assert.equal(s.running, false);
  requireEngineTrace(s);
});

test("the final-scan workload and failed-target-stop controls preserve synthetic state", () => {
  const s = newEngineDoubleState();
  s.foreignAtFinalScan = true;
  assert.equal(
    stepEngineDouble(s, "docker", ["container", "ls", "--quiet"]).stdout,
    "",
  );
  assert.equal(
    stepEngineDouble(s, "docker", ["container", "ls", "--quiet"]).stdout,
    "foreign-workload",
  );
  s.targets = [{ projectId: "owned", name: "owned-postgresql", running: true }];
  s.failTargetStop = true;
  assert.equal(
    stepEngineDouble(s, "docker", ["stop", "owned-postgresql"]).status,
    1,
  );
  assert.equal(s.targets[0]!.running, true);
  requireEngineTrace(s);
});

test("only the exact public failure-capacity probe reports unavailable without poisoning the trace", () => {
  const format =
    "{{.NCPU}} {{.MemTotal}} {{.ContainersRunning}} {{.Containers}}";
  const state = newEngineDoubleState();
  state.running = true;
  const result = stepEngineDouble(state, "docker", [
    "info",
    "--format",
    format,
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(state.running, true);
  assert.deepEqual(state.events, ["docker.capacity.unavailable"]);
  requireEngineTrace(state);
  for (const args of [
    ["info", "--format", "{{json .}}"],
    ["info", "--format", `${format} `],
    ["info", "--format", format, "--unsafe"],
    ["info", `--format=${format}`],
  ]) {
    const changed = newEngineDoubleState();
    assert.equal(stepEngineDouble(changed, "docker", args).status, 97);
    assert.equal(changed.unexpected, 1);
    assert.deepEqual(changed.events, ["unexpected-command"]);
  }
});

test("unknown arguments never enter retained simulation output", () => {
  const s = newEngineDoubleState();
  const result = stepEngineDouble(s, "docker", [
    "run",
    "PRIVATE_CREDENTIAL_CANARY",
  ]);
  assert.equal(
    JSON.stringify({ s, result }).includes("PRIVATE_CREDENTIAL_CANARY"),
    false,
  );
});

test("child environment contains only private paths and no ambient engine/provider credentials", () => {
  const env = isolatedEngineEnvironment(
    "/private/simulation",
    "/private/simulation/bin",
  );
  assert.equal(env.PATH, "/private/simulation/bin");
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "SUPABASE_ACCESS_TOKEN",
    "DATABASE_URL",
    "COLIMA_HOME",
    "NODE_OPTIONS",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.HOME, resolve("/private/simulation/home"));
  assert.equal(env.TMPDIR, resolve("/private/simulation/tmp"));
});

test("fake executables require an absolute Node shebang and contain no process-launch fallback", () => {
  assert.throws(
    () => fakeEngineExecutable("node", "/private/state", "docker"),
    /absolute/u,
  );
  assert.throws(
    () => fakeEngineExecutable("/node\nunsafe", "/private/state", "docker"),
    /absolute/u,
  );
  const source = fakeEngineExecutable(
    "/absolute/node",
    "/private/state",
    "docker",
  );
  assert.ok(source.startsWith("#!/absolute/node\n"));
  assert.equal(
    /child_process|\/usr\/bin\/env|execSync|spawnSync|shell:/u.test(source),
    false,
  );
});

test("serialized fake decision function is self-contained executable JavaScript", () => {
  const restored = Function(
    `return (${stepEngineDouble.toString()});`,
  )() as typeof stepEngineDouble;
  const state = newEngineDoubleState();
  assert.equal(restored(state, "colima", ["start"]).status, 0);
  assert.equal(state.running, true);
});

test(
  "generated executable runs its absolute Node shebang without tsx helpers or tool fallback",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "rehearsal-engine-double-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stateFile = resolve(directory, "state.json");
    const file = resolve(directory, "colima");
    await writeFile(stateFile, JSON.stringify(newEngineDoubleState()), {
      mode: 0o600,
    });
    await writeFile(
      file,
      fakeEngineExecutable(process.execPath, stateFile, "colima"),
      { mode: 0o700 },
    );
    const result = await promisify(execFile)(file, ["start"], {
      timeout: 3000,
      maxBuffer: 65536,
      env: { PATH: directory },
    });
    assert.equal(result.stdout, "");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.running, true);
    assert.deepEqual(state.events, ["colima.start"]);
    requireEngineTrace(state);
  },
);

test(
  "owned subprocess bounds output, time and explicit cancellation without exposing child output",
  { skip: process.platform === "win32" },
  async () => {
    const cwd = process.cwd();
    for (const [script, milliseconds, controller] of [
      [
        "process.stdout.write('PRIVATE_OUTPUT_CANARY'.repeat(10000))",
        3000,
        new AbortController(),
      ],
      ["setInterval(()=>{},1000)", 50, new AbortController()],
    ] as const) {
      await assert.rejects(
        runOwnedSimulationCommand(
          process.execPath,
          ["-e", script],
          cwd,
          {},
          controller.signal,
          milliseconds,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /bound|interrupted/u);
          assert.equal(error.message.includes("PRIVATE_OUTPUT_CANARY"), false);
          return true;
        },
      );
    }
    const interrupted = new AbortController();
    const pending = runOwnedSimulationCommand(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      cwd,
      {},
      interrupted.signal,
      3000,
    );
    interrupted.abort();
    await assert.rejects(pending, /interrupted/u);
    await assert.rejects(
      runOwnedSimulationCommand(
        process.execPath,
        ["-e", "throw new Error('must not launch')"],
        cwd,
        {},
        interrupted.signal,
        3000,
      ),
      /before launch/u,
    );
  },
);
