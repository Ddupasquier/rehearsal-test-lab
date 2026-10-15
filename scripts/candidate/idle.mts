/** Independent foreground acceptance; invokes only the installed public package CLI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseJsonOutput, runCommand } from "./process.mts";
import type { CommandResult } from "./process.mts";
import {
  requireArray,
  requireObject,
  requireString,
} from "../shared/validation.mts";

export function supportsForegroundIdle(value: unknown): boolean {
  const metadata = requireObject(value, "Configuration metadata");
  const rawFields = requireArray(metadata.fields, "Configuration fields");
  if (rawFields.length > 100)
    throw new Error("Configuration capability exceeds its public field bound.");
  const fields = rawFields.map((field) =>
    requireObject(field, "Configuration field"),
  );
  const activity = fields.find(
    (field) => field.path === "application.activity.url",
  );
  const timeout = fields.find(
    (field) => field.path === "lifecycle.openIdleTimeoutSeconds",
  );
  if (!activity && !timeout) return false;
  const patch = requireObject(
    metadata.patchContract,
    "Configuration patch contract",
  );
  if (
    metadata.schemaVersion !== 1 ||
    !activity ||
    !timeout ||
    fields.filter((field) => field.path === activity.path).length !== 1 ||
    fields.filter((field) => field.path === timeout.path).length !== 1 ||
    activity.kind !== "local-url" ||
    timeout.kind !== "nullable-integer" ||
    patch.schemaVersion !== 1 ||
    patch.input !== "project-local-json-file" ||
    patch.maximumBytes !== 65536 ||
    patch.concurrentChanges !== "refuse" ||
    patch.writesConfiguration !== false ||
    patch.executesProposedCommands !== false
  )
    throw new Error("Foreground idle capability is incomplete or unsafe.");
  return true;
}

export interface SyntheticActivity {
  schemaVersion: 1;
  busy: boolean;
  activitySequence: number;
}
/** Explicit work signals, not request-count or health-check inference. */
export function syntheticActivityTransition(
  state: SyntheticActivity,
  action: "begin" | "finish",
): SyntheticActivity {
  if (
    state.schemaVersion !== 1 ||
    typeof state.busy !== "boolean" ||
    !Number.isSafeInteger(state.activitySequence) ||
    state.activitySequence < 0 ||
    state.activitySequence === Number.MAX_SAFE_INTEGER ||
    (action === "begin" ? state.busy : !state.busy)
  )
    throw new Error("Invalid synthetic work transition.");
  return {
    schemaVersion: 1,
    busy: action === "begin",
    activitySequence: state.activitySequence + 1,
  };
}

export function createIdleApplicationSource(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid leased application port.");
  return `import {createServer} from "node:http";
import {writeFileSync,renameSync} from "node:fs";
const transition=${syntheticActivityTransition.toString()};
let activity={schemaVersion:1,busy:false,activitySequence:0};
const audit={activityReads:0,busyReads:0,quietReads:0,workBegins:0,workFinishes:0,lastSequence:0};
const persist=()=>{const next=new URL("./candidate-idle-observations.next.json",import.meta.url);writeFileSync(next,JSON.stringify(audit),{mode:0o600,flag:"wx"});renameSync(next,new URL("./candidate-idle-observations.json",import.meta.url));};
const server=createServer((request,response)=>{
  response.setHeader("content-type","application/json");
  if(request.method==="GET"&&request.url==="/health"){response.end(JSON.stringify({ok:true}));return;}
  if(request.method==="GET"&&request.url==="/activity"){
    audit.activityReads++;if(activity.busy)audit.busyReads++;else audit.quietReads++;
    audit.lastSequence=activity.activitySequence;persist();response.end(JSON.stringify(activity));return;
  }
  if(request.method==="POST"&&["/work/begin","/work/finish"].includes(request.url)){
    try{const action=request.url.endsWith("begin")?"begin":"finish";activity=transition(activity,action);if(action==="begin")audit.workBegins++;else audit.workFinishes++;audit.lastSequence=activity.activitySequence;persist();response.end(JSON.stringify(activity));}
    catch{response.writeHead(409).end(JSON.stringify({error:"invalid-transition"}));}return;
  }
  response.writeHead(404).end(JSON.stringify({error:"not-found"}));
});
server.listen(${port},"127.0.0.1");
`;
}

export function requireIdleCompletion(
  value: unknown,
  quietElapsedMilliseconds: number,
) {
  const envelope = requireObject(value, "Open result");
  const data = requireObject(envelope.data, "Open data");
  const application = requireObject(data.application, "Open application");
  const lifecycle = requireObject(data.lifecycle, "Open lifecycle");
  if (
    envelope.schemaVersion !== 1 ||
    envelope.command !== "open" ||
    envelope.status !== "success" ||
    application.stoppedBy !== "idle-timeout" ||
    application.closeReason !== "idle-timeout" ||
    lifecycle.mode !== "stop-on-application-exit" ||
    lifecycle.runtimeState !== "stopped" ||
    !Number.isFinite(quietElapsedMilliseconds) ||
    quietElapsedMilliseconds < 30_000
  )
    throw new Error(
      "Open did not prove a full real-time idle timeout with non-destructive owned runtime stop.",
    );
  return {
    closeReason: "idle-timeout",
    runtimeState: "stopped",
    quietElapsedMilliseconds,
  };
}

const safeCount = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid idle observation count.");
  return value;
};
export function requireIdleObservations(value: unknown) {
  const audit = requireObject(value, "Synthetic activity observations");
  const result = {
    activityReads: safeCount(audit.activityReads),
    busyReads: safeCount(audit.busyReads),
    quietReads: safeCount(audit.quietReads),
    workBegins: safeCount(audit.workBegins),
    workFinishes: safeCount(audit.workFinishes),
    lastSequence: safeCount(audit.lastSequence),
  };
  if (
    result.workBegins !== 1 ||
    result.workFinishes !== 1 ||
    result.lastSequence !== 2 ||
    result.busyReads < 2 ||
    result.quietReads < 2 ||
    result.activityReads !== result.busyReads + result.quietReads
  )
    throw new Error(
      "The package did not observe explicit busy/sequence work followed by repeated quiet activity.",
    );
  return result;
}

interface RuntimeIdentity {
  id: string;
  running: boolean;
  volumes: readonly { name: string; createdAt: string }[];
}
function runtimeIdentity(projectId: string): RuntimeIdentity {
  const ids = runCommand("docker", [
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--quiet",
    "--filter",
    `label=com.rehearsal-db.project=${projectId}`,
  ])
    .stdout.trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0]!))
    throw new Error(
      "Idle acceptance requires exactly one proved project-owned PostgreSQL container.",
    );
  const details = requireObject(
    JSON.parse(
      runCommand("docker", [
        "container",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.rehearsal-db.project")}},"mounts":{{json .Mounts}}}',
        ids[0]!,
      ]).stdout,
    ),
    "Idle container identity",
  );
  assert.equal(details.id, ids[0]);
  assert.equal(details.project, projectId);
  assert.equal(typeof details.running, "boolean");
  const mounts = requireArray(details.mounts, "Idle volume attachments").map(
    (mount) => requireObject(mount, "Volume attachment"),
  );
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0]!.Type, "volume");
  const volumes = mounts.map((mount) => {
    const name = requireString(mount.Name, "Owned data volume");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u.test(name))
      throw new Error("Invalid owned volume identity.");
    const volume = requireObject(
      JSON.parse(
        runCommand("docker", [
          "volume",
          "inspect",
          "--format",
          '{"name":{{json .Name}},"createdAt":{{json .CreatedAt}},"project":{{json (index .Labels "com.rehearsal-db.project")}}}',
          name,
        ]).stdout,
      ),
      "Idle volume identity",
    );
    assert.equal(volume.name, name);
    assert.equal(volume.project, projectId);
    return {
      name,
      createdAt: requireString(volume.createdAt, "Volume creation identity"),
    };
  });
  return { id: ids[0]!, running: details.running as boolean, volumes };
}
const sql = (containerId: string, statement: string) =>
  runCommand("docker", [
    "exec",
    containerId,
    "psql",
    "--no-align",
    "--tuples-only",
    "--username",
    "postgres",
    "--dbname",
    "postgres",
    "--command",
    statement,
  ]).stdout.trim();
const databaseState = (id: string) =>
  requireObject(
    JSON.parse(
      sql(
        id,
        `select json_build_object(
  'accounts',(select count(*) from lab_api.accounts),
  'entries',(select count(*) from lab_api.entries),
  'documents',(select count(*) from publication.documents),
  'candidateProbe',(select count(*) from lab_api.rehearsal_candidate_probe),
  'sandboxEdit',(select count(*) from lab_api.entries where title='Foreground idle preservation probe')
);`,
      ),
    ),
    "Idle database preservation state",
  );

function openSession(project: string, configuration: string) {
  const child = spawn(
    resolve(project, "node_modules/.bin/rehearsal"),
    ["open", `--config=${configuration}`, "--json"],
    { cwd: project, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    bytes = 0,
    overflow = false,
    ended = false;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 1024 * 1024) stdout += chunk.toString();
    else {
      overflow = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      overflow = true;
      child.kill("SIGINT");
    }
  });
  let startupError = false;
  child.on("error", () => {
    startupError = true;
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
  }>((done) =>
    child.once("close", (code, signal) => {
      ended = true;
      done({ code, signal, stdout });
    }),
  );
  const wait = async (timeout: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<never>((_done, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Owned foreground idle session exceeded its bounded deadline.",
                ),
              ),
            timeout,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    ended: () => ended,
    wait,
    failureCode: () => {
      try {
        const envelope = parseJsonOutput(stdout, "Open diagnostic");
        const code = requireObject(envelope.error, "Open failure").code;
        return typeof code === "string" && /^[A-Z0-9_]{1,100}$/u.test(code)
          ? code
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
    assertOutput: () => {
      if (overflow || startupError)
        throw new Error(
          "Foreground idle output exceeded its bound or the public CLI could not start.",
        );
    },
    stop: async () => {
      if (ended) return;
      child.kill("SIGINT");
      try {
        await wait(15_000);
      } catch {
        child.kill("SIGTERM");
        try {
          await wait(5_000);
        } catch {
          child.kill("SIGKILL");
          await wait(5_000);
          throw new Error(
            "Owned idle CLI required forced shutdown; outer workspace cleanup must verify its resources.",
          );
        }
      }
    },
  };
}

async function portClosed(port: number): Promise<boolean> {
  return new Promise((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") done(true);
      else
        reject(
          new Error(
            "Application listener closure could not be independently proved.",
          ),
        );
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("Application listener closure check timed out."));
    });
  });
}

export async function exerciseForegroundIdle({
  project,
  configuration,
  port,
  runId,
  cli,
  trackTemporaryFile,
}: {
  project: string;
  configuration: string;
  port: number;
  runId: string;
  cli: (args: string[]) => CommandResult;
  trackTemporaryFile: (path: string) => void;
}) {
  if (
    !/^rtl-[a-f0-9]{10}$/u.test(runId) ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !/^\.rehearsal\/[a-zA-Z0-9.-]+\.mjs$/u.test(configuration)
  )
    throw new Error(
      "Idle acceptance requires the maintained isolated workspace and leased configuration.",
    );
  const plan = requireObject(
    parseJsonOutput(cli(["explain"]).stdout, "Idle execution plan").data,
    "Idle plan data",
  );
  const environment = requireObject(
    plan.environment,
    "Idle target environment",
  );
  const projectId = `${runId}-postgresql-rehearsal`;
  assert.equal(environment.target, "postgresql");
  assert.equal(environment.projectId, projectId);
  const appPath = resolve(project, ".rehearsal/candidate-idle-server.mjs"),
    configPath = resolve(project, ".rehearsal/candidate-idle.config.mjs"),
    auditPath = resolve(project, ".rehearsal/candidate-idle-observations.json"),
    nextAuditPath = resolve(
      project,
      ".rehearsal/candidate-idle-observations.next.json",
    );
  for (const [path, contents] of [
    [appPath, createIdleApplicationSource(port)],
    [auditPath, "{}"],
    [nextAuditPath, ""],
    [
      configPath,
      `import base from ${JSON.stringify("./" + basename(configuration))};\nexport default {...base,lifecycle:{...base.lifecycle,open:"stop-on-application-exit",openIdleTimeoutSeconds:30},application:{...base.application,startCommand:${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(appPath)}`)},activity:{url:"http://127.0.0.1:${port}/activity"},readiness:{...base.application.readiness,url:"http://127.0.0.1:${port}/health"}}};\n`,
    ],
  ] as const) {
    await writeFile(path, contents, { mode: 0o600, flag: "wx" });
    trackTemporaryFile(path);
  }
  await unlink(nextAuditPath);
  cli(["start"]);
  const original = runtimeIdentity(projectId);
  assert.equal(original.running, true);
  assert.equal(
    sql(
      original.id,
      "update lab_api.entries set title='Foreground idle preservation probe' where id=(select min(id) from lab_api.entries) returning 1;",
    ).split("\n")[0],
    "1",
  );
  const before = databaseState(original.id);
  assert.equal(before.sandboxEdit, 1);
  assert.equal(before.candidateProbe, 1);
  cli(["stop"]);
  const stopped = runtimeIdentity(projectId);
  assert.equal(stopped.running, false);
  assert.equal(stopped.id, original.id);
  assert.deepEqual(stopped.volumes, original.volumes);
  const session = openSession(project, ".rehearsal/candidate-idle.config.mjs");
  try {
    const origin = `http://127.0.0.1:${port}`;
    const readinessDeadline = performance.now() + 60_000;
    let ready = false;
    while (performance.now() < readinessDeadline) {
      if (session.ended())
        throw new Error(
          `Foreground open exited before application readiness (${session.failureCode()}).`,
        );
      try {
        const response = await fetch(origin + "/health", {
          signal: AbortSignal.timeout(2000),
        });
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert.equal(
      ready,
      true,
      "Synthetic activity application did not become ready.",
    );
    const work = async (action: "begin" | "finish") => {
      const response = await fetch(origin + "/work/" + action, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      return requireObject(await response.json(), "Explicit synthetic work");
    };
    assert.equal((await work("begin")).busy, true);
    await delay(12_000);
    assert.equal(
      session.ended(),
      false,
      "Foreground open stopped while explicit work was busy.",
    );
    const busyAudit = requireObject(
      JSON.parse(await readFile(auditPath, "utf8")),
      "Busy activity audit",
    );
    assert.ok(
      safeCount(busyAudit.busyReads) >= 2,
      "The package did not independently poll the busy application twice.",
    );
    const quietStarted = performance.now();
    assert.equal((await work("finish")).activitySequence, 2);
    const completed = await session.wait(75_000);
    const quietElapsedMilliseconds = performance.now() - quietStarted;
    session.assertOutput();
    assert.equal(completed.code, 0);
    assert.equal(completed.signal, null);
    const result = requireIdleCompletion(
      parseJsonOutput(completed.stdout, "Foreground open completion"),
      quietElapsedMilliseconds,
    );
    const observations = requireIdleObservations(
      JSON.parse(await readFile(auditPath, "utf8")),
    );
    assert.equal(await portClosed(port), true);
    const afterStop = runtimeIdentity(projectId);
    assert.equal(afterStop.running, false);
    assert.equal(afterStop.id, original.id);
    assert.deepEqual(afterStop.volumes, original.volumes);
    const activity = requireObject(
      parseJsonOutput(cli(["activity"]).stdout, "Idle operation release").data,
      "Idle operation activity",
    );
    assert.equal(activity.state, "idle");
    assert.equal(activity.operation, null);
    cli(["start"]);
    const restarted = runtimeIdentity(projectId);
    assert.equal(restarted.id, original.id);
    assert.deepEqual(restarted.volumes, original.volumes);
    assert.deepEqual(databaseState(restarted.id), before);
    const verified = parseJsonOutput(
      cli(["verify"]).stdout,
      "Preserved idle sandbox verification",
    );
    assert.equal(verified.status, "success");
    cli(["stop"]);
    return {
      ...result,
      observations,
      configuredTimeoutSeconds: 30,
      independentCounts: before,
      containerId: original.id,
      retainedVolumes: original.volumes.length,
      applicationPortClosed: true,
      operationLockReleased: true,
      sandboxEditPreserved: true,
      verification: "passed",
      scope:
        "Synthetic cooperative PostgreSQL application; no hosted provider, missing-signal, or sequence-regression acceptance claim.",
    };
  } finally {
    await session.stop();
  }
}
