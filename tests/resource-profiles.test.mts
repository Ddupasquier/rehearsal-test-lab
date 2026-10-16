import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import {
  inspectProfileEndpoint,
  localProfileEndpoint,
  readProfileMetrics,
  summarizeProfileSamples,
  verifyProfileServices,
  selectResourceProfiles,
  profileProbeTmpfsMounts,
  profileMeasurementScope,
  profileDatabaseContainerName,
  requireProfileDatabaseContainer,
  readProfilePersistenceSnapshot,
  assertProfileRestartPersistence,
  runProfileDatabaseProbe,
} from "../scripts/candidate/resource-profiles.mts";

test("synthetic database probes bound Docker transport/output without a shell and preserve endpoint pinning", () => {
  const endpoint = "unix:///tmp/rehearsal-probe.sock";
  const args = ["info", "--format", "{{json .ID}}"];
  const success: SpawnSyncReturns<string> = {
    pid: 12,
    output: [null, '"engine"', ""],
    stdout: '"engine"',
    stderr: "",
    status: 0,
    signal: null,
  };
  let calls = 0;
  assert.equal(
    runProfileDatabaseProbe(args, {
      endpoint,
      run: (command, received, options) => {
        calls += 1;
        assert.equal(command, "docker");
        assert.deepEqual(received, args);
        assert.equal(options.shell, false);
        assert.equal(options.timeout, 15000);
        assert.equal(options.maxBuffer, 65536);
        assert.equal(options.killSignal, "SIGKILL");
        assert.equal(options.encoding, "utf8");
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        assert.equal(options.env?.DOCKER_HOST, endpoint);
        for (const name of [
          "DOCKER_CONTEXT",
          "DOCKER_TLS_VERIFY",
          "DOCKER_CERT_PATH",
          "DOCKER_CONFIG",
        ])
          assert.equal(options.env?.[name], undefined);
        return success;
      },
    }),
    '"engine"',
  );
  assert.equal(calls, 1);
  const privateOutput = "PROVIDER-DETAIL-MUST-NOT-ESCAPE";
  for (const failure of [
    {
      ...success,
      error: Object.assign(new Error(privateOutput), { code: "ETIMEDOUT" }),
    },
    {
      ...success,
      error: Object.assign(new Error(privateOutput), { code: "ENOBUFS" }),
    },
    { ...success, status: 9, stderr: privateOutput },
    { ...success, status: null, signal: "SIGKILL" as const },
    { ...success, stdout: "x".repeat(65536), stderr: privateOutput },
  ]) {
    assert.throws(
      () => runProfileDatabaseProbe(args, { endpoint, run: () => failure }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "The bounded synthetic database probe did not complete; raw provider output was withheld.",
        );
        assert.equal(error.message.includes(privateOutput), false);
        return true;
      },
    );
  }
  assert.throws(
    () =>
      runProfileDatabaseProbe(args, {
        endpoint: "ssh://production.example",
        run: () => {
          throw new Error("must not execute");
        },
      }),
    /pinned local engine/u,
  );
});

test("resource profile selection keeps the complete default and rejects ambiguous options", () => {
  assert.deepEqual(selectResourceProfiles([]), [
    "postgresql",
    "application",
    "full",
  ]);
  assert.deepEqual(selectResourceProfiles(["--profile=postgresql"]), [
    "postgresql",
  ]);
  for (const args of [
    ["postgresql"],
    ["--profile=unknown"],
    ["--profile="],
    ["--profile=postgresql", "--profile=full"],
  ])
    assert.throws(() => selectResourceProfiles(args));
});

test("stopped conflict probes cover all image-declared volume paths without accepting unsafe mounts", () => {
  assert.deepEqual(profileProbeTmpfsMounts(null), []);
  assert.deepEqual(
    profileProbeTmpfsMounts({ "/var/lib/postgresql/data": {}, "/second": {} }),
    [
      "--mount",
      "type=tmpfs,destination=/var/lib/postgresql/data",
      "--mount",
      "type=tmpfs,destination=/second",
    ],
  );
  for (const value of [
    undefined,
    [],
    { "/": {} },
    { relative: {} },
    { "/a/../b": {} },
    { "/a//b": {} },
    { "/a,b": {} },
    { "/a\n": {} },
    Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`/volume${index}`, {}]),
    ),
  ])
    assert.throws(() => profileProbeTmpfsMounts(value));
});

test("resource profiles refuse remote engines before contacting a Docker daemon", () => {
  const calls: string[][] = [];
  assert.throws(
    () =>
      inspectProfileEndpoint((program, args = []) => {
        calls.push([program, ...args]);
        const stdout =
          args[1] === "show"
            ? "remote"
            : JSON.stringify("ssh://production.example");
        return { stdout, stderr: "", output: stdout };
      }),
    /refuses remote/u,
  );
  assert.equal(calls.length, 2);
  for (const endpoint of [
    "unix:///tmp/docker.sock",
    "tcp://127.0.0.1:2375",
    "npipe:////./pipe/docker_engine",
  ])
    assert.equal(localProfileEndpoint(endpoint), true);
  for (const endpoint of [
    "tcp://production.example:2375",
    "tcp://name:secret@localhost:2375",
    "unix://remote/tmp/docker.sock",
  ])
    assert.equal(localProfileEndpoint(endpoint), false);
});

test("measurement scope distinguishes fresh containers from cache attribution and VM/host claims", () => {
  const cached = profileMeasurementScope(0);
  assert.equal(cached.coldImageOrVmBenchmark, false);
  assert.equal(cached.engineStartupMeasured, false);
  assert.match(cached.imageCache, /no new cached image IDs/u);
  assert.match(cached.resourceMeasurementScope, /not host/u);
  assert.equal(cached.sampleWindow.samples, 3);
  const changed = profileMeasurementScope(2);
  assert.equal(changed.newCachedImageCount, 2);
  assert.match(changed.imageCache, /attribution unknown/u);
  for (const count of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => profileMeasurementScope(count));
});

test("profile measurements reject unavailable, mixed, foreign and nonnumeric telemetry", () => {
  const entry = {
    projectId: "isolated",
    state: "running",
    containerCount: 1,
    runningContainerCount: 1,
    cpuPercent: 1.5,
    memoryUsageBytes: 1024,
    diskUsageBytes: null,
  };
  const value = (changes = {}) => ({
    data: {
      schemaVersion: 1,
      engine: { state: "running" },
      environments: [{ ...entry, ...changes }],
    },
  });
  assert.deepEqual(readProfileMetrics(value(), "isolated"), {
    containers: 1,
    cpuPercent: 1.5,
    memoryUsageBytes: 1024,
    ownedVolumeBytes: null,
  });
  for (const change of [
    { projectId: "foreign" },
    { state: "mixed" },
    { cpuPercent: null },
    { memoryUsageBytes: -1 },
    { runningContainerCount: 0 },
  ])
    assert.throws(() => readProfileMetrics(value(change), "isolated"));
  const sample = readProfileMetrics(value(), "isolated");
  assert.equal(
    summarizeProfileSamples([sample, sample, sample]).meanCpuPercent,
    1.5,
  );
  assert.throws(() => summarizeProfileSamples([sample]), /Three consistent/u);
});

test("profile service presence is independent of the requested profile's name", () => {
  const app = [
    "supabase_db_test",
    "supabase_auth_test",
    "supabase_storage_test",
    "supabase_rest_test",
    "supabase_kong_test",
    "supabase_inbucket_test",
  ];
  verifyProfileServices("postgresql", ["isolated-postgresql"]);
  verifyProfileServices("application", app);
  assert.throws(
    () =>
      verifyProfileServices(
        "application",
        app.filter((name) => !name.includes("inbucket")),
      ),
    /mail/u,
  );
  assert.throws(
    () =>
      verifyProfileServices("application", [...app, "supabase_realtime_test"]),
    /unexpectedly started/u,
  );
  assert.throws(() => verifyProfileServices("full", app), /missing required/u);
  const full = [
    ...app,
    "supabase_studio_test",
    "supabase_realtime_test",
    "supabase_edge_runtime_test",
    "supabase_analytics_test",
    "supabase_vector_test",
    "supabase_imgproxy_test",
  ];
  verifyProfileServices("full", full);
  assert.throws(
    () =>
      verifyProfileServices(
        "full",
        full.filter((name) => !name.includes("inbucket")),
      ),
    /mail/u,
  );
  assert.throws(
    () => verifyProfileServices("postgresql", ["wrong", "wrong2"]),
    /one database/u,
  );
});

test("synthetic persistence queries require exact running run/provider ownership, not a database-looking name", () => {
  for (const profile of ["postgresql", "application", "full"] as const) {
    const projectId = `rtl-0123456789-${profile === "postgresql" ? "postgresql" : "supabase"}-rehearsal`;
    const label =
      profile === "postgresql"
        ? "com.rehearsal-db.project"
        : "com.supabase.cli.project";
    const other =
      profile === "postgresql"
        ? "com.supabase.cli.project"
        : "com.rehearsal-db.project";
    const row = {
      id: "a".repeat(64),
      name: `/${profileDatabaseContainerName(profile, projectId)}`,
      running: true,
      labels: { [label]: projectId },
    };
    assert.equal(
      requireProfileDatabaseContainer(row, profile, projectId),
      row.id,
    );
    for (const invalid of [
      { ...row, id: "short-id" },
      { ...row, name: "/supabase_db_unrelated" },
      { ...row, running: false },
      { ...row, labels: {} },
      { ...row, labels: { [label]: "other-project" } },
      { ...row, labels: { ...row.labels, [other]: "other-project" } },
    ])
      assert.throws(() =>
        requireProfileDatabaseContainer(invalid, profile, projectId),
      );
    assert.throws(() => profileDatabaseContainerName(profile, "production"));
    assert.throws(() =>
      profileDatabaseContainerName(
        profile,
        projectId.replace("-rehearsal", "-source"),
      ),
    );
  }
});

const persistenceRows = () =>
  Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    title:
      index === 0
        ? "Rehearsal synthetic persistence control"
        : `Synthetic library book ${index + 1}`,
  }));

test("independent synthetic snapshots require all primary keys and the actual safe edit without exposing rows", () => {
  const rows = persistenceRows();
  const result = readProfilePersistenceSnapshot(JSON.stringify(rows));
  assert.equal(result.rowCount, 100);
  assert.equal(result.sentinelEditPreserved, true);
  assert.match(result.rowsSha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    JSON.stringify(result).includes("Synthetic library book"),
    false,
  );
  const missingKey = structuredClone(rows);
  missingKey[1]!.id = 1;
  const lostEdit = structuredClone(rows);
  lostEdit[0]!.title = "Synthetic library book 1";
  for (const invalid of [
    rows.slice(1),
    [...rows, { id: 101, title: "extra" }],
    missingKey,
    lostEdit,
    rows.map((row) => ({ ...row, extra: "unexpected field" })),
    rows.map((row) => ({ ...row, title: "x".repeat(257) })),
  ])
    assert.throws(() =>
      readProfilePersistenceSnapshot(JSON.stringify(invalid)),
    );
  assert.throws(() => readProfilePersistenceSnapshot(" ".repeat(65537)));
});

test("provider-correct restart preserves exact volumes and data while only Supabase may replace containers", () => {
  const before = {
    containers: ["a".repeat(64)],
    volumes: [{ name: "owned_database", createdAt: "2026-10-16T06:00:00Z" }],
  };
  const data = readProfilePersistenceSnapshot(
    JSON.stringify(persistenceRows()),
  );
  const applicationServices = [
    "supabase_db_test",
    "supabase_auth_test",
    "supabase_storage_test",
    "supabase_rest_test",
    "supabase_kong_test",
    "supabase_inbucket_test",
  ];
  const pg = {
    profile: "postgresql" as const,
    before,
    after: structuredClone(before),
    services: ["owned-postgresql"],
    beforeData: data,
    afterData: data,
  };
  assert.equal(
    assertProfileRestartPersistence(pg).containerIdentity,
    "preserved",
  );
  const replaced = { ...before, containers: ["b".repeat(64)] };
  assert.throws(
    () => assertProfileRestartPersistence({ ...pg, after: replaced }),
    /container identity/u,
  );
  const application = {
    ...pg,
    profile: "application" as const,
    after: replaced,
    services: applicationServices,
  };
  assert.equal(
    assertProfileRestartPersistence(application).containerIdentity,
    "provider-may-recreate",
  );
  const full = {
    ...application,
    profile: "full" as const,
    services: [
      ...applicationServices,
      "supabase_studio_test",
      "supabase_realtime_test",
      "supabase_edge_runtime_test",
      "supabase_analytics_test",
      "supabase_vector_test",
      "supabase_imgproxy_test",
    ],
  };
  assert.equal(
    assertProfileRestartPersistence(full).exactVolumesPreserved,
    true,
  );
  for (const after of [
    { ...replaced, volumes: [] },
    {
      ...replaced,
      volumes: [{ ...before.volumes[0]!, name: "different_volume" }],
    },
    {
      ...replaced,
      volumes: [{ ...before.volumes[0]!, createdAt: "2026-10-16T06:01:00Z" }],
    },
    {
      ...replaced,
      volumes: [
        ...before.volumes,
        { name: "unexpected", createdAt: "2026-10-16T06:00:00Z" },
      ],
    },
  ])
    assert.throws(() =>
      assertProfileRestartPersistence({ ...application, after }),
    );
  assert.throws(
    () =>
      assertProfileRestartPersistence({
        ...application,
        services: applicationServices.filter(
          (name) => !name.includes("inbucket"),
        ),
      }),
    /mail/u,
  );
  const changed = persistenceRows();
  changed[50]!.title = "Different synthetic data";
  assert.throws(
    () =>
      assertProfileRestartPersistence({
        ...application,
        afterData: readProfilePersistenceSnapshot(JSON.stringify(changed)),
      }),
    /synthetic rows/u,
  );
});
