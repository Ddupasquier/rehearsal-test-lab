import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createIdleApplicationSource,
  requireIdleCompletion,
  requireIdleObservations,
  supportsForegroundIdle,
  syntheticActivityTransition,
} from "../scripts/candidate/idle.mts";

const metadata = () => ({
  schemaVersion: 1,
  fields: [
    { path: "application.activity.url", kind: "local-url" },
    { path: "lifecycle.openIdleTimeoutSeconds", kind: "nullable-integer" },
  ],
  patchContract: {
    schemaVersion: 1,
    input: "project-local-json-file",
    maximumBytes: 65536,
    concurrentChanges: "refuse",
    writesConfiguration: false,
    executesProposedCommands: false,
  },
});
const completion = () => ({
  schemaVersion: 1,
  command: "open",
  status: "success",
  data: {
    application: { stoppedBy: "idle-timeout", closeReason: "idle-timeout" },
    lifecycle: { mode: "stop-on-application-exit", runtimeState: "stopped" },
  },
});

test("foreground idle acceptance is selected only by both explicit public configuration fields", () => {
  assert.equal(supportsForegroundIdle(metadata()), true);
  assert.equal(supportsForegroundIdle({ ...metadata(), fields: [] }), false);
  for (const change of [
    { fields: [metadata().fields[0]] },
    {
      fields: [{ ...metadata().fields[0], kind: "text" }, metadata().fields[1]],
    },
    {
      patchContract: {
        writesConfiguration: true,
        executesProposedCommands: false,
      },
    },
  ])
    assert.throws(() => supportsForegroundIdle({ ...metadata(), ...change }));
});

test("synthetic work changes sequence explicitly; health/polling is not an activity transition", () => {
  const initial = {
    schemaVersion: 1 as const,
    busy: false,
    activitySequence: 0,
  };
  const busy = syntheticActivityTransition(initial, "begin");
  assert.deepEqual(busy, { schemaVersion: 1, busy: true, activitySequence: 1 });
  const quiet = syntheticActivityTransition(busy, "finish");
  assert.deepEqual(quiet, {
    schemaVersion: 1,
    busy: false,
    activitySequence: 2,
  });
  assert.deepEqual(initial, {
    schemaVersion: 1,
    busy: false,
    activitySequence: 0,
  });
  assert.throws(() => syntheticActivityTransition(initial, "finish"));
  assert.throws(() => syntheticActivityTransition(busy, "begin"));
  assert.throws(() =>
    syntheticActivityTransition(
      { ...initial, activitySequence: Number.MAX_SAFE_INTEGER },
      "begin",
    ),
  );
});

test("a successful exit or interrupt alone cannot certify a real 30-second idle shutdown", () => {
  assert.equal(
    requireIdleCompletion(completion(), 30_000).closeReason,
    "idle-timeout",
  );
  assert.throws(() => requireIdleCompletion(completion(), 29_999));
  assert.throws(() => requireIdleCompletion(completion(), Number.NaN));
  for (const application of [
    { stoppedBy: "SIGINT", closeReason: "interrupted" },
    { stoppedBy: "idle-timeout", closeReason: "interrupted" },
  ])
    assert.throws(() =>
      requireIdleCompletion(
        { ...completion(), data: { ...completion().data, application } },
        45_000,
      ),
    );
  assert.throws(() =>
    requireIdleCompletion(
      {
        ...completion(),
        data: {
          ...completion().data,
          lifecycle: { mode: "keep-until-stop", runtimeState: "running" },
        },
      },
      45_000,
    ),
  );
  assert.throws(() =>
    requireIdleCompletion({ ...completion(), status: "error" }, 45_000),
  );
});

test("independent app observations require busy polling, sequence progress, and repeated quiet samples", () => {
  const observed = {
    activityReads: 10,
    busyReads: 2,
    quietReads: 8,
    workBegins: 1,
    workFinishes: 1,
    lastSequence: 2,
  };
  assert.deepEqual(requireIdleObservations(observed), observed);
  for (const change of [
    { busyReads: 0, quietReads: 10 },
    { quietReads: 0, activityReads: 2 },
    { lastSequence: 1 },
    { workFinishes: 0 },
    { activityReads: 11 },
    { busyReads: -1 },
  ])
    assert.throws(() => requireIdleObservations({ ...observed, ...change }));
});

test("generated isolated activity application is valid JavaScript without starting a server", async (context) => {
  for (const port of [80, 0, 65536, Number.NaN])
    assert.throws(() => createIdleApplicationSource(port));
  const directory = await mkdtemp(resolve(tmpdir(), "lab-idle-syntax-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const script = resolve(directory, "app.mjs");
  await writeFile(script, createIdleApplicationSource(42128), { mode: 0o600 });
  const checked = spawnSync(process.execPath, ["--check", script], {
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr);
});
