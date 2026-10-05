import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, resolve } from "node:path";
import test from "node:test";

for (const cleanupFails of [false, true]) {
  test(`failed isolated CLI run ${cleanupFails ? "retains ports when cleanup fails" : "releases ports after cleanup"}`, async (context) => {
    const root = resolve(import.meta.dirname, "..");
    const directory = await mkdtemp(resolve(tmpdir(), "rtl-isolated-failure-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const bin = resolve(directory, "bin");
    await mkdir(bin);
    // Dependency installation and Docker are mocked; real archive validation, snapshot,
    // worker orchestration, report writing, and lease cleanup run through the public CLI.
    await writeFile(
      resolve(bin, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "ci") fs.symlinkSync(process.env.LAB_TEST_DEPENDENCIES, "node_modules", "dir");
`,
      { mode: 0o755 },
    );
    await writeFile(
      resolve(bin, "docker"),
      `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.LAB_TEST_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.LAB_TEST_CLEANUP_FAIL === "1") { process.stderr.write("Docker daemon unavailable"); process.exit(1); }
`,
      { mode: 0o755 },
    );
    await writeFile(resolve(directory, "outside.txt"), "synthetic");
    const artifact = resolve(directory, "unsafe.tgz");
    const packed = spawnSync(
      "tar",
      ["-czf", artifact, "-C", directory, "outside.txt"],
      { encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const executed = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/verify-candidate.mts", artifact],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          LAB_TEST_DEPENDENCIES: resolve(root, "node_modules"),
          LAB_TEST_DOCKER_LOG: resolve(directory, "docker.jsonl"),
          LAB_TEST_CLEANUP_FAIL: cleanupFails ? "1" : "0",
        },
      },
    );
    assert.notEqual(executed.status, 0);
    assert.match(executed.stderr, /unsafe archive path/u);
    const reportPath = /Isolation report: (.+)/u.exec(executed.stdout)?.[1];
    assert.ok(reportPath, executed.stdout + executed.stderr);
    assert.ok(
      reportPath.startsWith(
        resolve(root, "test-results/candidate-acceptance") + "/",
      ),
    );
    context.after(() =>
      rm(dirname(reportPath), { recursive: true, force: true }),
    );
    const isolation = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(isolation.status, "failed");
    assert.equal(isolation.cleanupStatus, cleanupFails ? "failed" : "passed");
    assert.equal(isolation.workspaceRetained, true);
    assert.equal(isolation.portLeaseRetained, cleanupFails);
    assert.match(isolation.snapshotSha256, /^[a-f0-9]{64}$/u);
    await readFile(resolve(isolation.workspace, "package.json"));
    if (cleanupFails) {
      await readFile(resolve(isolation.portLease, "owner.json"));
      context.after(() =>
        rm(isolation.portLease, { recursive: true, force: true }),
      );
      assert.ok(
        isolation.errors.some((message: string) =>
          message.includes("Docker daemon unavailable"),
        ),
      );
    } else {
      await assert.rejects(
        readFile(resolve(isolation.portLease, "owner.json")),
        { code: "ENOENT" },
      );
    }
    const acceptance = JSON.parse(
      await readFile(resolve(dirname(reportPath), "acceptance.json"), "utf8"),
    );
    assert.equal(acceptance.status, "failed");
    assert.equal(acceptance.stages[0].status, "failed");
    assert.ok(
      acceptance.stages
        .slice(1)
        .every((stage: { status: string }) => stage.status === "skipped"),
    );
    const commands: string[][] = (
      await readFile(resolve(directory, "docker.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      commands.some((args) => args.includes("prune")),
      false,
    );
    assert.ok(
      commands.every(
        (args) =>
          args.includes("ls") ||
          (args[0] === "compose" && args.includes("down")),
      ),
    );
  });
}
