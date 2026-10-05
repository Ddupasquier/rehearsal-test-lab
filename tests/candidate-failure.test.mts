import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import { requireArray, requireObject } from "../scripts/shared/validation.mts";

const root = resolve(import.meta.dirname, "..");

test("candidate acceptance rejects unsafe archives and records skipped stages without installing them", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "lab-candidate-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = resolve(directory, "lab");
  const bin = resolve(directory, "bin");
  const staging = resolve(directory, "staging");
  await Promise.all([
    mkdir(fixture),
    mkdir(bin),
    mkdir(resolve(staging, "package"), { recursive: true }),
  ]);
  await cp(resolve(root, "scripts"), resolve(fixture, "scripts"), {
    recursive: true,
  });
  const commands = resolve(directory, "commands.jsonl");
  await writeFile(
    resolve(bin, "npm"),
    `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.LAB_FAKE_COMMANDS, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
    { mode: 0o755 },
  );

  await writeFile(resolve(staging, "outside.txt"), "synthetic");
  await symlink("../outside.txt", resolve(staging, "package/link"));
  for (const [name, entry] of [
    ["outside", "outside.txt"],
    ["symlink", "package"],
  ] as const) {
    const artifact = resolve(directory, `${name}.tgz`);
    const packed = spawnSync("tar", ["-czf", artifact, "-C", staging, entry], {
      encoding: "utf8",
    });
    assert.equal(packed.status, 0, packed.stderr);
    const executed = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "scripts/verify-candidate.mts",
        artifact,
      ],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          LAB_FAKE_COMMANDS: commands,
        },
      },
    );
    assert.notEqual(executed.status, 0);
    assert.match(executed.stderr, /unsafe archive path/u);
  }
  const acceptance = resolve(fixture, "test-results/candidate-acceptance");
  const reports = await readdir(acceptance);
  assert.equal(reports.length, 2);
  for (const name of reports) {
    const report = requireObject(
      JSON.parse(
        await readFile(resolve(acceptance, name, "acceptance.json"), "utf8"),
      ),
      "Acceptance report",
    );
    assert.equal(report.status, "failed");
    const stages = requireArray(report.stages, "Stages").map((value) =>
      requireObject(value, "Stage"),
    );
    assert.equal(stages[0]?.status, "failed");
    assert.ok(stages.slice(1).every(({ status }) => status === "skipped"));
    assert.ok(
      requireArray(report.teardown, "Teardown").every(
        (value) => requireObject(value, "Teardown stage").status === "passed",
      ),
    );
  }
  const invocations = (await readFile(commands, "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  assert.deepEqual(invocations, [
    ["run", "postgresql:stop"],
    ["run", "supabase:stop"],
    ["run", "postgresql:stop"],
    ["run", "supabase:stop"],
  ]);
});
