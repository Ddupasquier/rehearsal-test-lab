import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectProfileEndpoint,
  localProfileEndpoint,
  readProfileMetrics,
  summarizeProfileSamples,
  verifyProfileServices,
} from "../scripts/candidate/resource-profiles.mts";

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
  ];
  verifyProfileServices("postgresql", ["isolated-postgresql"]);
  verifyProfileServices("application", app);
  assert.throws(
    () =>
      verifyProfileServices("application", [...app, "supabase_realtime_test"]),
    /unexpectedly started/u,
  );
  assert.throws(() => verifyProfileServices("full", app), /missing required/u);
  assert.throws(
    () => verifyProfileServices("postgresql", ["wrong", "wrong2"]),
    /one database/u,
  );
});
