import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquirePortLease,
  createWorkspace,
  isolationBindings,
  removeOwnedResources,
  removeWorkspace,
} from "./candidate/isolation.mts";
import {
  requireRegularFile,
  runCommand,
  sha256File,
} from "./candidate/process.mts";
import { errorMessage } from "./shared/validation.mts";

const root = resolve(import.meta.dirname, "..");
const upgrading = process.argv[2] === "--upgrade";
const requested = process.argv[upgrading ? 4 : 2];
const previousRequested = upgrading ? process.argv[3] : undefined;
if (!upgrading && (requested === "--help" || requested === "-h")) {
  console.log(`Usage: npm run candidate:verify -- /absolute/path/to/rehearsal-db-core-*.tgz

Snapshots the lab and exact artifact into an independent workspace with dedicated
ports, Docker identities, and package installs. Supabase phases share a resource
slot to limit memory use. Reports remain in test-results/candidate-acceptance/.
Failed workspaces are retained for diagnosis; successful workspaces are removed.`);
  process.exit(0);
}
if (!requested || process.argv.length !== (upgrading ? 5 : 3))
  throw new Error(
    "Pass one exact candidate tarball: npm run candidate:verify -- /absolute/path/to/rehearsal-db-core-*.tgz",
  );
const artifact = resolve(process.cwd(), requested);
await requireRegularFile(artifact, "Candidate artifact");
const sha256 = await sha256File(artifact);
const previousPath = previousRequested
  ? resolve(process.cwd(), previousRequested)
  : undefined;
if (previousPath)
  await requireRegularFile(previousPath, "Previous release artifact");
const previousSha256 = previousPath
  ? await sha256File(previousPath)
  : undefined;
const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
const reportDirectory = resolve(
  root,
  upgrading
    ? "test-results/upgrade-acceptance"
    : "test-results/candidate-acceptance",
  runId,
);
const workspace = resolve(reportDirectory, "workspace");
await mkdir(reportDirectory, { recursive: true });
const lease = await acquirePortLease();
const bindings = isolationBindings(lease.base);
let exitCode = 1;
let resourcesMayExist = false;
let cleanupFailed = false;
let workspaceCleanupStatus: "retained" | "removed" | "failed" = "retained";
const errors: string[] = [];
const startedAt = new Date().toISOString();
let snapshotSha256: string | undefined;
try {
  const labSnapshot = await createWorkspace(root, workspace, bindings);
  snapshotSha256 = labSnapshot.sha256;
  await writeFile(
    resolve(reportDirectory, "workspace-snapshot.json"),
    `${JSON.stringify(labSnapshot, null, 2)}\n`,
  );
  const snapshot = resolve(reportDirectory, "candidate.tgz");
  await copyFile(artifact, snapshot);
  if ((await sha256File(snapshot)) !== sha256)
    throw new Error("Candidate artifact changed while being copied.");
  const previousSnapshot = previousPath
    ? resolve(reportDirectory, "previous.tgz")
    : undefined;
  if (previousPath && previousSnapshot) {
    await copyFile(previousPath, previousSnapshot);
    if ((await sha256File(previousSnapshot)) !== previousSha256)
      throw new Error("Previous artifact changed while being copied.");
  }
  console.log(
    `Isolated run: ${bindings.prefix}\nWorkspace: ${workspace}\nDedicated ports: ${lease.base}-${lease.base + 31}`,
  );
  runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: workspace,
  });
  resourcesMayExist = true;
  exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/verify-candidate-worker.mts", snapshot],
      {
        cwd: workspace,
        detached: process.platform !== "win32",
        stdio: "inherit",
        env: {
          ...process.env,
          LAB_REPORT_DIRECTORY: reportDirectory,
          LAB_RUN_ID: bindings.prefix,
          LAB_PREVIOUS_ARTIFACT: previousSnapshot ?? "",
          LAB_POSTGRESQL_APP_PORT: String(lease.base + 28),
          LAB_SUPABASE_APP_PORT: String(lease.base + 27),
        },
      },
    );
    const forward = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const detach = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => {
      detach();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      detach();
      if (signal)
        errors.push(`Acceptance worker was interrupted by ${signal}.`);
      done(code ?? 1);
    });
  });
} catch (error) {
  errors.push(errorMessage(error));
} finally {
  if (resourcesMayExist) {
    try {
      await removeOwnedResources(workspace, bindings);
    } catch (error) {
      cleanupFailed = true;
      errors.push(errorMessage(error));
    }
  }
  // Keep the port lease when cleanup failed: a later run must not reuse live resources' ports.
  if (!cleanupFailed) await lease.release();
  if (errors.length) exitCode = 1;
  if (exitCode === 0) {
    try {
      await removeWorkspace(workspace);
      workspaceCleanupStatus = "removed";
    } catch (error) {
      workspaceCleanupStatus = "failed";
      errors.push(errorMessage(error));
      exitCode = 1;
    }
  }
  const passed = exitCode === 0;
  await writeFile(
    resolve(reportDirectory, "isolation.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: passed ? "passed" : "failed",
        workerExitCode: exitCode,
        startedAt,
        completedAt: new Date().toISOString(),
        artifact: { originalPath: artifact, sha256 },
        ...(previousPath
          ? {
              previousArtifact: {
                originalPath: previousPath,
                sha256: previousSha256,
              },
            }
          : {}),
        workspace,
        snapshotSha256,
        workspaceRetained: !passed,
        workspaceCleanupStatus,
        bindings,
        portLease: lease.path,
        portLeaseRetained: cleanupFailed,
        cleanupStatus:
          cleanupFailed || workspaceCleanupStatus === "failed"
            ? "failed"
            : "passed",
        errors,
      },
      null,
      2,
    )}\n`,
  );
}
for (const error of errors) console.error(error);
console.log(`Isolation report: ${resolve(reportDirectory, "isolation.json")}`);
process.exitCode = exitCode;
