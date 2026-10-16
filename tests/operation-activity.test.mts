import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  activityEnvironment,
  createDeniedToolSource,
  parseObservedIdleActivity,
  runActivityCommand,
  snapshotOperationActivityFiles,
} from "../scripts/candidate/operation-activity.mts";
import {
  validateEditorBaselineSample,
  validateEditorConfigurationSample,
} from "../scripts/candidate/editor-review.mts";

test("editor fixture configuration metadata binds exact root/nested paths and refuses unsafe capabilities", () => {
  const sha = "a".repeat(64);
  for (const path of [
    "rehearsal.config.mjs",
    "infrastructure/rehearsal/rehearsal.config.mjs",
  ]) {
    const data = {
      schemaVersion: 1,
      path,
      sourceSha256: sha,
      patchContract: {
        schemaVersion: 1,
        input: "project-local-json-file",
        maximumBytes: 65536,
        writesConfiguration: false,
        executesProposedCommands: false,
        concurrentChanges: "refuse",
      },
      fields: [
        {
          path: "runtime.displayName",
          kind: "text",
          value: "Synthetic",
          provenance: "validated-active-configuration",
          confidence: "certain",
          reviewRequired: true,
        },
      ],
    };
    assert.equal(validateEditorConfigurationSample(data, path, sha), data);
    for (const changed of [
      { ...data, path: "other.mjs" },
      { ...data, sourceSha256: "b".repeat(64) },
      {
        ...data,
        patchContract: {
          ...data.patchContract,
          executesProposedCommands: true,
        },
      },
      { ...data, fields: [...data.fields, ...data.fields] },
    ])
      assert.throws(() =>
        validateEditorConfigurationSample(changed, path, sha),
      );
  }
});

test("editor baseline fixture requires actual active/retained counts and leaves source schema unavailable", () => {
  const data = {
    formatVersion: 2,
    generationId: "active",
    rowCount: 2,
    tableCount: 1,
    migrationCount: 1,
    verification: "checksums_verified",
    migrationHistorySha256: "a".repeat(64),
    sanitizationPolicySha256: "b".repeat(64),
    dataSha256: "c".repeat(64),
    sourceSchemaSha256: null,
    privacy: {
      sourceRowsExposed: false,
      sensitiveValuesIncludedInReport: false,
    },
    generations: [
      {
        generationId: "active",
        active: true,
        rowCount: 2,
        tableCount: 1,
        migrationCount: 1,
        storageAssetCount: 0,
      },
      {
        generationId: "retained",
        active: false,
        rowCount: 1,
        tableCount: 1,
        migrationCount: 1,
        storageAssetCount: 0,
      },
    ],
  };
  assert.equal(validateEditorBaselineSample(data, 2, 2), data);
  for (const changed of [
    { ...data, rowCount: 0 },
    { ...data, sourceSchemaSha256: "d".repeat(64) },
    { ...data, dataSha256: "invalid" },
    { ...data, generations: data.generations.slice(0, 1) },
    {
      ...data,
      generations: data.generations.map((item) => ({ ...item, active: true })),
    },
    { ...data, privacy: { ...data.privacy, sourceRowsExposed: true } },
  ])
    assert.throws(() => validateEditorBaselineSample(changed, 2, 2));
});

test(
  "preservation records only the canonical active generation pointer without following links",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "rehearsal-activity-links-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const artifacts = resolve(root, ".rehearsal");
    await mkdir(artifacts);
    const current = resolve(artifacts, "current");
    const first = "generations/20261016T070528Z-b6f0cbb1646b";
    const second = "generations/20261016T070529Z-aabbccddeeff";
    // No referent is needed: this inventories the pointer, not its target.
    await symlink(first, current);
    const before = await snapshotOperationActivityFiles(root);
    assert.deepEqual(before, [[".rehearsal/current", `symlink:${first}`]]);
    await rm(current);
    await symlink(second, current);
    assert.notDeepEqual(await snapshotOperationActivityFiles(root), before);
    for (const unsafe of [
      "../outside",
      resolve(root, "outside"),
      "generations/../outside",
      `${first}/extra`,
      `${first}\n`,
      `generations/${"x".repeat(150)}`,
    ]) {
      await rm(current);
      await symlink(unsafe, current);
      await assert.rejects(
        snapshotOperationActivityFiles(root),
        /canonical relative generation/u,
      );
    }
    await rm(current);
    await symlink(first, current);
    await symlink(first, resolve(artifacts, "unrelated"));
    await assert.rejects(
      snapshotOperationActivityFiles(root),
      /Unexpected synthetic link/u,
    );
  },
);

const time = "2026-10-16T06:00:00.000Z";
const terminal = (state = "completed", id = "a".repeat(64)) => ({
  kind: state === "failed" ? "run" : "baseline create",
  rehearsalVersion: "0.1.0-rc.7",
  progress: {
    schemaVersion: 1,
    operationId: id,
    state,
    startedAt: time,
    updatedAt: time,
    elapsedMilliseconds: 10,
    currentStage: null,
    completedStages: [],
    events: [
      {
        sequence: 1,
        code: "operation.started",
        phase: null,
        target: null,
        at: time,
      },
      {
        sequence: 2,
        code: `operation.${state}`,
        phase: null,
        target: null,
        at: time,
      },
    ],
    truncated: { stages: false, events: false },
  },
});
const sample = () => ({
  schemaVersion: 1,
  rehearsalVersion: "0.1.0-rc.7",
  command: "activity",
  status: "success",
  startedAt: time,
  durationMs: 1.5,
  warnings: [],
  data: {
    schemaVersion: 1,
    state: "idle",
    operation: null,
    recent: [terminal()],
  },
});

test("observed idle subset accepts empty, completed-baseline and failed-run history", () => {
  const success = sample();
  assert.deepEqual(parseObservedIdleActivity(success), success.data);
  const failed = sample();
  failed.data.recent = [terminal(), terminal("failed", "b".repeat(64))];
  assert.deepEqual(parseObservedIdleActivity(failed), failed.data);
  const data = { schemaVersion: 1, state: "idle", operation: null, recent: [] };
  assert.deepEqual(parseObservedIdleActivity({ ...sample(), data }), data);
});

test("public activity refuses unknown fields, schemas, unsafe metadata and contradictory states with safe errors", () => {
  const changes: ((v: ReturnType<typeof sample>) => unknown)[] = [
    (v) => ({ ...v, schemaVersion: 2 }),
    (v) => ({ ...v, command: "status" }),
    (v) => ({ ...v, private: "PRIVATE_OUTPUT_CANARY" }),
    (v) => ({ ...v, warnings: ["PRIVATE_OUTPUT_CANARY"] }),
    (v) => ({ ...v, data: { ...v.data, pid: 123 } }),
    (v) => ({ ...v, data: { ...v.data, state: ["idle"] } }),
    (v) => ({ ...v, data: { ...v.data, state: "busy" } }),
    (v) => ({ ...v, data: { ...v.data, state: "invalid" } }),
    (v) => ({ ...v, data: { ...v.data, recent: null } }),
    (v) => ({ ...v, data: { ...v.data, operation: { kind: "run" } } }),
    (v) => ({
      ...v,
      data: {
        ...v.data,
        recent: [{ ...terminal(), kind: "https://private.invalid" }],
      },
    }),
    (v) => ({
      ...v,
      data: { ...v.data, recent: [{ ...terminal(), kind: ["run"] }] },
    }),
    (v) => ({ ...v, data: { ...v.data, recent: [terminal("running")] } }),
    (v) => ({ ...v, data: { ...v.data, recent: [terminal(), terminal()] } }),
  ];
  for (const change of changes)
    assert.throws(
      () => parseObservedIdleActivity(change(sample())),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Observed idle activity violated its bounded safe contract.",
        );
        return true;
      },
    );
});

test("public progress refuses unbounded history/events, arbitrary logs, duplicate sequences and invalid durations", () => {
  for (const edit of [
    (p: Record<string, unknown>) => {
      p.events = Array.from({ length: 41 }, (_, i) => ({
        sequence: i + 1,
        code: "operation.started",
        phase: null,
        target: null,
        at: time,
      }));
    },
    (p: Record<string, unknown>) => {
      p.events = [
        {
          sequence: 1,
          code: "stage.output",
          phase: null,
          target: null,
          at: time,
        },
      ];
    },
    (p: Record<string, unknown>) => {
      p.events = [
        {
          sequence: 1,
          code: "operation.started",
          phase: null,
          target: null,
          at: time,
        },
        {
          sequence: 1,
          code: "operation.completed",
          phase: null,
          target: null,
          at: time,
        },
      ];
    },
    (p: Record<string, unknown>) => {
      p.completedStages = Array.from({ length: 21 }, () => ({}));
    },
    (p: Record<string, unknown>) => {
      p.elapsedMilliseconds = -1;
    },
    (p: Record<string, unknown>) => {
      p.elapsedMilliseconds = NaN;
    },
    (p: Record<string, unknown>) => {
      p.operationId = "pid-123";
    },
    (p: Record<string, unknown>) => {
      p.startedAt = "2026-10-16";
    },
    (p: Record<string, unknown>) => {
      p.rawOutput = "PRIVATE_OUTPUT_CANARY";
    },
  ]) {
    const v = sample();
    edit(v.data.recent[0]!.progress);
    assert.throws(() => parseObservedIdleActivity(v));
  }
  const v = sample();
  v.data.recent = Array.from({ length: 21 }, (_, i) =>
    terminal("completed", i.toString(16).padStart(64, "0")),
  );
  assert.throws(() => parseObservedIdleActivity(v));
  assert.throws(() =>
    parseObservedIdleActivity({
      ...sample(),
      private: "x".repeat(1_048_577),
    }),
  );
});

test("private child environment cannot inherit provider credentials or real engine paths", () => {
  const env = activityEnvironment("/private/owned", "/private/owned/fake-bin");
  assert.equal(env.PATH, "/private/owned/fake-bin");
  assert.equal(env.HOME, resolve("/private/owned/home"));
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DATABASE_URL",
    "SUPABASE_ACCESS_TOKEN",
    "NODE_OPTIONS",
    "COLIMA_HOME",
  ])
    assert.equal(env[key], undefined);
});

test(
  "deny-only generated tools never retain argv and cannot fall back to a runtime",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "rehearsal-activity-deny-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const audit = resolve(directory, "audit.txt"),
      file = resolve(directory, "docker");
    await writeFile(
      file,
      createDeniedToolSource(process.execPath, audit, "docker"),
      { mode: 0o700 },
    );
    await assert.rejects(
      promisify(execFile)(file, ["PRIVATE_ARGUMENT_CANARY"], {
        env: { PATH: directory },
        timeout: 3000,
        maxBuffer: 65536,
      }),
      (error: unknown) => {
        assert.equal((error as { code: unknown }).code, 97);
        return true;
      },
    );
    assert.equal(await readFile(audit, "utf8"), "docker\n");
    assert.throws(
      () => createDeniedToolSource("node", audit, "docker"),
      /absolute/u,
    );
  },
);

test(
  "owned command output/time/cancellation bounds withhold raw child errors",
  { skip: process.platform === "win32" },
  async () => {
    for (const [source, timeout] of [
      ["process.stdout.write('PRIVATE_OUTPUT_CANARY'.repeat(100000))", 3000],
      ["setInterval(()=>{},1000)", 50],
    ] as const)
      await assert.rejects(
        runActivityCommand(
          process.execPath,
          ["-e", source],
          process.cwd(),
          {},
          new AbortController().signal,
          timeout,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /bound/u);
          assert.equal(error.message.includes("PRIVATE_OUTPUT_CANARY"), false);
          return true;
        },
      );
    const controller = new AbortController();
    const running = runActivityCommand(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      process.cwd(),
      {},
      controller.signal,
      3000,
    );
    controller.abort();
    await assert.rejects(running, /interrupted/u);
    await assert.rejects(
      runActivityCommand(
        process.execPath,
        ["-e", "throw new Error('must not run')"],
        process.cwd(),
        {},
        controller.signal,
        3000,
      ),
      /before launch/u,
    );
  },
);
