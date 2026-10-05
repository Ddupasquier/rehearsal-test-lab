import assert from "node:assert/strict";
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
import {
  CommandError,
  compareInstalledPackage,
  parseJsonOutput,
  runCommand,
} from "../scripts/candidate/process.mts";
import { createReporter } from "../scripts/candidate/report.mts";
import { requireApplicationSummary } from "../scripts/shared/validation.mts";

test("process failures retain command, output, and exit code", () => {
  const result = runCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.env.LAB_TEST_VALUE)"],
    { env: { LAB_TEST_VALUE: "synthetic" } },
  );
  assert.equal(result.stdout, "synthetic");
  assert.throws(
    () =>
      runCommand(process.execPath, [
        "-e",
        "console.log('out'); console.error('err'); process.exit(7)",
      ]),
    (error: unknown) => {
      assert.ok(error instanceof CommandError);
      assert.equal(error.exitCode, 7);
      assert.match(error.output, /out\nerr\n/u);
      assert.match(error.command, /process.exit\(7\)/u);
      return true;
    },
  );
});

test("CLI JSON accepts a preamble and rejects malformed or non-object data", () => {
  assert.deepEqual(
    parseJsonOutput('npm preamble\n{"status":"passed"}', "CLI"),
    { status: "passed" },
  );
  assert.throws(
    () => parseJsonOutput("no JSON", "CLI"),
    /did not return JSON/u,
  );
  assert.throws(() => parseJsonOutput("{bad}", "CLI"), /malformed JSON/u);
  assert.throws(
    () => parseJsonOutput('[{"status":"passed"}]', "CLI"),
    /malformed JSON/u,
  );
});

test("application proofs reject missing, string, empty, and false counts", () => {
  const valid = { ok: true, accounts: 1, entries: 10000, documents: 2 };
  assert.deepEqual(requireApplicationSummary(valid), valid);
  for (const invalid of [
    null,
    {},
    { ...valid, entries: "10000" },
    { ...valid, entries: 0 },
    { ...valid, accounts: 1.5 },
    { ...valid, entries: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, ok: false },
    { ...valid, documents: NaN },
  ]) {
    assert.throws(() => requireApplicationSummary(invalid));
  }
});

test("exact artifact comparison rejects changed bytes, missing files, and symlinks", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "lab-artifact-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const extracted = resolve(directory, "extracted");
  const installed = resolve(directory, "installed");
  await Promise.all([mkdir(extracted), mkdir(installed)]);
  await Promise.all([
    writeFile(resolve(extracted, "fixture.txt"), "synthetic"),
    writeFile(resolve(installed, "fixture.txt"), "synthetic"),
  ]);
  assert.equal(await compareInstalledPackage(extracted, installed), 1);
  await writeFile(resolve(installed, "fixture.txt"), "changed");
  await assert.rejects(
    compareInstalledPackage(extracted, installed),
    /bytes differ/u,
  );
  await rm(resolve(installed, "fixture.txt"));
  await assert.rejects(
    compareInstalledPackage(extracted, installed),
    /inventory differs/u,
  );
  await symlink(
    resolve(extracted, "fixture.txt"),
    resolve(installed, "fixture.txt"),
  );
  await assert.rejects(
    compareInstalledPackage(extracted, installed),
    /unsupported entry/u,
  );
});

test("acceptance reports cannot pass with skipped stages or failed teardown", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "lab-report-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = {
    name: "@rehearsal-db/core",
    version: "0.0.0-test",
    sha256: "synthetic-hash",
  };
  const reporter = createReporter({
    artifactPath: "synthetic.tgz",
    reportDirectory: directory,
  });
  await reporter.runStage("Artifact", () => ({ verified: true }));
  const result = await reporter.writeReport({
    artifact,
    plannedStages: ["Artifact", "Database"],
    teardown: [],
    failure: undefined,
  });
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.stages[1]?.status, "skipped");
  assert.match(await readFile(result.markdownPath, "utf8"), /SKIPPED/u);

  const failedReporter = createReporter({
    artifactPath: "synthetic.tgz",
    reportDirectory: directory,
  });
  const error = new CommandError(
    "synthetic failure",
    "lab command",
    "diagnostics",
    4,
  );
  await assert.rejects(
    failedReporter.runStage("Artifact", () => {
      throw error;
    }),
    CommandError,
  );
  const failed = await failedReporter.writeReport({
    artifact,
    plannedStages: ["Artifact"],
    teardown: [
      {
        name: "Cleanup",
        status: "failed",
        error: "synthetic teardown failure",
      },
    ],
    failure: error,
  });
  assert.equal(failed.report.status, "failed");
  assert.equal(failed.report.stages[0]?.command, "lab command");
  assert.equal(failed.report.stages[0]?.exitCode, 4);
  assert.equal(failed.report.failure, "synthetic failure");

  const cleanReporter = createReporter({
    artifactPath: "synthetic.tgz",
    reportDirectory: directory,
  });
  await cleanReporter.runStage("Artifact", () => ({}));
  const teardownFailed = await cleanReporter.writeReport({
    artifact,
    plannedStages: ["Artifact"],
    teardown: [{ name: "Cleanup", status: "failed" }],
    failure: undefined,
  });
  assert.equal(teardownFailed.report.status, "failed");
});
