import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  preserveForegroundIdleDiagnostic,
  probeIdleApplicationHealth,
  projectForegroundIdleDiagnostic,
  readIdleObservationDiagnostic,
} from "../scripts/candidate/idle.mts";

const observations = {
  activityReads: 10,
  busyReads: 3,
  quietReads: 7,
  workBegins: 1,
  workFinishes: 1,
  lastSequence: 2,
};
const input = () => ({
  runId: "rtl-1234567890",
  outcome: "failed" as const,
  checkpoint: "quiet-window" as const,
  capture: "before-owned-stop" as const,
  completionOutput: "",
  session: {
    ended: false,
    terminationRequested: false,
    outputOverflow: false,
    startupFailed: false,
    ownedStopFailed: false,
    stdoutBytes: 0,
    stderrBytes: 0,
  },
});
const activityOutput = () =>
  JSON.stringify({
    schemaVersion: 1,
    command: "activity",
    status: "success",
    data: {
      schemaVersion: 1,
      state: "busy",
      operation: {
        kind: "open",
        progress: {
          schemaVersion: 1,
          state: "running",
          elapsedMilliseconds: 90000,
          currentStage: { phase: "interactive-session" },
        },
      },
    },
  });

test("timeout diagnostics survive temporary fixture cleanup without replacing the primary failure", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-idle-diagnostic-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const temporary = resolve(directory, "observations.json");
  const report = resolve(directory, "foreground-idle-before-owned-stop.json");
  await writeFile(temporary, JSON.stringify(observations));
  const primary = new Error(
    "Owned foreground idle session exceeded its bounded deadline.",
  );
  await assert.rejects(
    async () => {
      try {
        throw primary;
      } finally {
        assert.equal(
          await preserveForegroundIdleDiagnostic({
            input: input(),
            readObservations: async () =>
              JSON.parse(await readFile(temporary, "utf8")),
            readActivity: activityOutput,
            record: async (diagnostic) => {
              await writeFile(report, JSON.stringify(diagnostic), {
                mode: 0o600,
                flag: "wx",
              });
            },
          }),
          true,
        );
        await rm(temporary);
      }
    },
    (error) => error === primary,
  );
  const saved = JSON.parse(await readFile(report, "utf8"));
  assert.equal(saved.outcome, "failed");
  assert.equal(saved.checkpoint, "quiet-window");
  assert.equal(saved.capture, "before-owned-stop");
  assert.deepEqual(saved.observations, observations);
  assert.equal(saved.activity.currentPhase, "interactive-session");
  assert.equal(saved.completion, null);
});

test("diagnostics retain only closed public fields and bounded synthetic counters", () => {
  const privateCanary =
    "postgresql://secret:private-token@private.example/database";
  const activity = JSON.parse(activityOutput());
  activity.secret = privateCanary;
  activity.data.operation.progress.currentStage.target = privateCanary;
  activity.data.operation.progress.currentStage.privatePath = privateCanary;
  activity.data.operation.progress.events = [
    {
      sequence: 1,
      code: "stage.started",
      phase: "interactive-session",
      target: privateCanary,
    },
  ];
  const diagnostic = projectForegroundIdleDiagnostic({
    ...input(),
    observations: { ...observations, privateRows: privateCanary },
    activityOutput: JSON.stringify(activity),
    completionOutput: JSON.stringify({
      schemaVersion: 1,
      status: "error",
      error: {
        category: "runtime_dependency_failure",
        code: "runtime_dependency_failure",
        message: privateCanary,
        context: { headers: privateCanary },
      },
    }),
  });
  assert.equal(diagnostic.completion?.errorCode, "runtime_dependency_failure");
  assert.equal(
    diagnostic.completion?.errorCategory,
    "runtime_dependency_failure",
  );
  assert.equal(JSON.stringify(diagnostic).includes(privateCanary), false);
  assert.deepEqual(diagnostic.observations, observations);
  assert.deepEqual(diagnostic.activity?.events, [
    { sequence: 1, code: "stage.started", phase: "interactive-session" },
  ]);
  activity.data.operation.progress.events = Array.from({ length: 41 }, () => ({
    sequence: 1,
    code: "stage.started",
    phase: "interactive-session",
  }));
  activity.data.operation.progress.currentStage.phase = privateCanary;
  const excessiveEvents = projectForegroundIdleDiagnostic({
    ...input(),
    observations,
    activityOutput: JSON.stringify(activity),
    completionOutput: "",
  });
  assert.equal(excessiveEvents.activity?.events, null);
  assert.equal(excessiveEvents.activity?.currentPhase, null);
  const invalid = projectForegroundIdleDiagnostic({
    ...input(),
    observations: { ...observations, quietReads: Number.MAX_SAFE_INTEGER + 1 },
    activityOutput: " ".repeat(65537),
    completionOutput: JSON.stringify({
      schemaVersion: 1,
      status: "error",
      error: {
        category: privateCanary,
        code: privateCanary,
      },
    }),
  });
  assert.equal(invalid.activity, null);
  assert.equal(invalid.observations, null);
  assert.equal(invalid.completion?.errorCode, null);
  assert.equal(invalid.completion?.errorCategory, null);
  assert.equal(JSON.stringify(invalid).includes(privateCanary), false);
});

test("interruption after a failed quiet window cannot become natural idle acceptance", () => {
  const interrupted = projectForegroundIdleDiagnostic({
    ...input(),
    capture: "after-owned-stop",
    observations,
    activityOutput: "",
    completionOutput: JSON.stringify({
      schemaVersion: 1,
      command: "open",
      status: "success",
      data: {
        application: { stoppedBy: "SIGINT", closeReason: "interrupted" },
        lifecycle: { runtimeState: "stopped" },
      },
    }),
    session: { ...input().session, ended: true, terminationRequested: true },
  });
  assert.equal(interrupted.outcome, "failed");
  assert.equal(interrupted.completion?.closeReason, "interrupted");
  assert.equal(interrupted.completion?.stoppedBy, "SIGINT");
});

test("successful completion stays passed and raw public completion is not retained", async () => {
  const completion = JSON.stringify({
    schemaVersion: 1,
    command: "open",
    status: "success",
    data: {
      application: {
        stoppedBy: "idle-timeout",
        closeReason: "idle-timeout",
        command: "private-command",
      },
      lifecycle: { runtimeState: "stopped" },
    },
  });
  let saved: ReturnType<typeof projectForegroundIdleDiagnostic> | undefined;
  assert.equal(
    await preserveForegroundIdleDiagnostic({
      input: {
        ...input(),
        outcome: "passed",
        checkpoint: "verified",
        completionOutput: completion,
      },
      readObservations: async () => observations,
      readActivity: () => "",
      record: (diagnostic) => {
        saved = diagnostic;
      },
    }),
    true,
  );
  assert.equal(saved?.outcome, "passed");
  assert.equal(saved?.completion?.closeReason, "idle-timeout");
  assert.equal(JSON.stringify(saved).includes("private-command"), false);
});

test("secondary observation, activity and report failures never mask the acceptance error", async () => {
  const primary = new Error("primary acceptance failure");
  await assert.rejects(
    async () => {
      try {
        throw primary;
      } finally {
        assert.equal(
          await preserveForegroundIdleDiagnostic({
            input: input(),
            readObservations: async () => {
              throw new Error("private read failure");
            },
            readActivity: () => {
              throw new Error("private activity failure");
            },
            readHealth: async () => {
              throw new Error("private health failure");
            },
            record: () => {
              throw new Error("private write failure");
            },
          }),
          false,
        );
      }
    },
    (error) => error === primary,
  );
  let saved: ReturnType<typeof projectForegroundIdleDiagnostic> | undefined;
  await preserveForegroundIdleDiagnostic({
    input: input(),
    readObservations: async () => {
      throw new Error("private read failure");
    },
    readActivity: () => {
      throw new Error("private activity failure");
    },
    record: (diagnostic) => {
      saved = diagnostic;
    },
  });
  assert.equal(saved?.observations, null);
  assert.equal(saved?.activity, null);
  assert.equal(saved?.applicationReachable, null);
  assert.equal(saved?.ownedRuntimeRunning, null);
});

test("observation reads refuse oversized files and symlinks before projecting any content", async (context) => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "rtl-idle-diagnostic-bound-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = resolve(directory, "source.json"),
    link = resolve(directory, "link.json");
  await writeFile(source, JSON.stringify(observations));
  assert.deepEqual(await readIdleObservationDiagnostic(source), observations);
  await symlink(source, link);
  await assert.rejects(readIdleObservationDiagnostic(link));
  await writeFile(source, " ".repeat(4097));
  await assert.rejects(readIdleObservationDiagnostic(source), /bound/);
});

test("diagnostic health has a hard bound even when fetch ignores abort and rejects late", async () => {
  let rejectRequest: (error: Error) => void = () => undefined;
  const observed: { signal: AbortSignal | null | undefined } = {
    signal: undefined,
  };
  const pending = new Promise<Response>((_done, reject) => {
    rejectRequest = reject;
  });
  const result = await probeIdleApplicationHealth(42128, {
    timeoutMilliseconds: 10,
    fetchImplementation: async (_url, options) => {
      observed.signal = options?.signal;
      return pending;
    },
  });
  assert.equal(result, null);
  assert.equal(observed.signal?.aborted, true);
  rejectRequest(new Error("private late transport failure"));
  await new Promise<void>((done) => setImmediate(done));
});

test("diagnostic health cancels response bodies and preserves success without opening a listener", async () => {
  let cancelled = false;
  const result = await probeIdleApplicationHealth(42128, {
    fetchImplementation: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result, true);
  assert.equal(cancelled, true);
  assert.equal(await probeIdleApplicationHealth(80), null);
  assert.equal(
    await probeIdleApplicationHealth(42128, { timeoutMilliseconds: 2001 }),
    null,
  );
});
