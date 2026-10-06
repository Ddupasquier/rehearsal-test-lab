import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, relative } from "node:path";
import { sha256File } from "../candidate/process.mts";
import { requireObject, requireString } from "../shared/validation.mts";

export interface TerminalStep {
  timeoutSeconds?: number;
  expect: string;
  send?: string;
  select?: string;
}
export async function runTerminal(
  options: {
    command: string;
    args: string[];
    cwd: string;
    steps: TerminalStep[];
    styled?: boolean;
    timeoutSeconds?: number;
  },
  transcriptPath: string,
) {
  const child = spawn(
    "python3",
    [resolve(import.meta.dirname, "terminal-driver.py")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "",
    errorOutput = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    errorOutput += chunk;
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  child.stdin.end(
    JSON.stringify({ ...options, livePath: `${transcriptPath}.txt` }),
  );
  const code = await exited;
  assert.equal(code, 0, errorOutput);
  const result = requireObject(JSON.parse(output), "Terminal result");
  await writeFile(transcriptPath, `${JSON.stringify(result, null, 2)}\n`);
  assert.equal(
    result.failure,
    null,
    `${String(result.failure)}\n${String(result.transcript)}`,
  );
  return {
    exitCode: result.exitCode,
    transcript: requireString(result.transcript, "Terminal transcript"),
    transport: result.transport,
  };
}

export async function snapshotProject(project: string) {
  const result: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    const entry = await lstat(path),
      key = relative(project, path);
    if (entry.isSymbolicLink()) result[key] = `link:${await readlink(path)}`;
    else if (entry.isDirectory()) {
      result[key] = `directory:${entry.mode & 0o777}`;
      for (const name of (await readdir(path)).sort())
        if (name !== "node_modules") await walk(resolve(path, name));
    } else if (entry.isFile())
      result[key] = `file:${entry.mode & 0o777}:${await sha256File(path)}`;
    else throw new Error(`Unsupported project state: ${path}`);
  };
  for (const name of (await readdir(project)).sort())
    if (name !== "node_modules") await walk(resolve(project, name));
  return result;
}

const home = "What would you like to do? [1]:";
const command = (project: string) =>
  resolve(project, "node_modules/.bin/rehearsal");

export async function exerciseInteractiveSetup(
  project: string,
  reportDirectory: string,
) {
  const before = await snapshotProject(project);
  const mistakes = await runTerminal(
    {
      command: command(project),
      args: ["--plain"],
      cwd: project,
      steps: [
        { expect: home, send: "not-a-number\r" },
        { expect: "Choose a number from 1 to", send: "999\r" },
        { expect: "Choose a number from 1 to", select: "Prepare the script" },
        {
          expect: "Sanitized NDJSON records",
          send: "missing-records.ndjson\r",
        },
        { expect: "Migration ledger", send: "missing-ledger.json\r" },
        { expect: "BASELINE INPUTS NEED ATTENTION", send: "" },
        { expect: home, select: "Exit" },
      ],
    },
    resolve(reportDirectory, "terminal-invalid-inputs.json"),
  );
  assert.equal(mistakes.exitCode, 0);
  assert.match(mistakes.transcript, /PostgreSQL project detected/u);
  assert.match(mistakes.transcript, /Migration history detected/u);
  assert.deepEqual(
    await snapshotProject(project),
    before,
    "Invalid wizard input changed the application",
  );

  const cancelled = await runTerminal(
    {
      command: command(project),
      args: [],
      cwd: project,
      styled: true,
      steps: [{ expect: "Exit", send: "\u0003" }],
    },
    resolve(reportDirectory, "terminal-styled-cancellation.json"),
  );
  assert.ok(
    [0, 130, -2].includes(Number(cancelled.exitCode)),
    "Unexpected cancellation result",
  );
  assert.match(cancelled.transcript, /What would you like to do/u);
  assert.deepEqual(
    await snapshotProject(project),
    before,
    "Cancelling the styled wizard changed the application",
  );

  const config = await readFile(
    resolve(project, "rehearsal.config.mjs"),
    "utf8",
  );
  await rm(resolve(project, "rehearsal.config.mjs"));
  const missing = await snapshotProject(project);
  const declined = await runTerminal(
    {
      command: command(project),
      args: ["--plain"],
      cwd: project,
      steps: [
        { expect: home, select: "Set the stage" },
        {
          expect: "Which database should Rehearsal use? [1]:",
          select: "PostgreSQL",
        },
        { expect: "Create these project-local files? (y/N)", send: "n\r" },
        { expect: "No changes made.", send: "" },
        { expect: home, select: "Exit" },
      ],
    },
    resolve(reportDirectory, "terminal-declined-setup.json"),
  );
  assert.equal(declined.exitCode, 0);
  assert.deepEqual(
    await snapshotProject(project),
    missing,
    "Declining setup wrote project files",
  );
  const accepted = await runTerminal(
    {
      command: command(project),
      args: ["--plain"],
      cwd: project,
      steps: [
        { expect: home, select: "Set the stage" },
        {
          expect: "Which database should Rehearsal use? [1]:",
          select: "PostgreSQL",
        },
        { expect: "Create these project-local files? (y/N)", send: "y\r" },
        { expect: home, select: "Exit" },
      ],
    },
    resolve(reportDirectory, "terminal-approved-setup.json"),
  );
  assert.equal(accepted.exitCode, 0);
  assert.equal(
    await readFile(resolve(project, "rehearsal.config.mjs"), "utf8"),
    config,
    "Wizard-generated configuration differs from the ordinary installation template",
  );
  assert.deepEqual(
    await snapshotProject(project),
    before,
    "Approved setup changed files outside its reviewed plan",
  );
  return {
    terminalTransport: "real POSIX pseudo-terminal",
    invalidChoicesRecover: true,
    missingInputFilesRecover: true,
    styledCancellationPreservedApp: true,
    declinedSetupPreservedApp: true,
    approvedSetupMatchedDiscoveredTemplate: true,
  };
}

export async function exerciseGuidedRun(
  project: string,
  reportDirectory: string,
) {
  const result = await runTerminal(
    {
      command: command(project),
      args: [],
      styled: true,
      cwd: project,
      timeoutSeconds: 120,
      steps: [
        { expect: "Exit", send: "\r" },
        { expect: "Apply exactly this migration?", send: "y" },
        { expect: "REHEARSAL PASSED", send: "" },
        { expect: "What would you like to do?", send: "\u0003" },
      ],
    },
    resolve(reportDirectory, "terminal-guided-rehearsal.json"),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.transcript, /REHEARSAL PASSED/u);
  assert.match(result.transcript, /Project proofs passed/u);
  assert.match(result.transcript, /20260102000100_index_available_loans\.sql/u);
  assert.match(result.transcript, /Candidate set: [a-f0-9]{12}/u);
  return { guidedRehearsalExitedSuccessfully: true };
}

export async function exerciseGuidedRefusal(
  project: string,
  reportDirectory: string,
) {
  const before = await snapshotProject(project);
  const result = await runTerminal(
    {
      command: command(project),
      args: [],
      styled: true,
      cwd: project,
      steps: [
        { expect: "Exit", send: "\r" },
        { expect: "Apply exactly this migration?", send: "n" },
        { expect: "No changes made.", send: "" },
        { expect: "What would you like to do?", send: "\u0003" },
      ],
    },
    resolve(reportDirectory, "terminal-declined-migration.json"),
  );
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.transcript, /REHEARSAL PASSED/u);
  assert.deepEqual(
    await snapshotProject(project),
    before,
    "Declining the migration changed project or baseline files",
  );
  return { declinedMigrationPreservedState: true };
}
