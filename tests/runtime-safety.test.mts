import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("PostgreSQL fallback refuses to start or stop containers it does not own", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "lab-docker-safety-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const commands = resolve(directory, "commands.jsonl");
  await writeFile(
    resolve(directory, "docker"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LAB_DOCKER_COMMANDS, JSON.stringify(args) + "\\n");
if (args[0] === "volume" && args[1] === "create") process.exit(0);
if (args[0] === "volume" && args[1] === "inspect") {
  console.log(process.env.LAB_VOLUME_OWNER || "postgresql");
  process.exit(0);
}
if (args[0] === "container" && args[1] === "inspect") {
  if (process.env.LAB_DOCKER_UNAVAILABLE) { console.error("Cannot connect to the Docker daemon"); process.exit(1); }
  if (process.env.LAB_CONTAINER_ABSENT) { console.error("Error response from daemon: No such container: rehearsal-test-lab-postgresql"); process.exit(1); }
  console.log(args.includes("--format") ? (process.env.LAB_CONTAINER_OWNER || "unowned") : "[]");
  process.exit(0);
}
if (args[0] === "inspect") { console.log("healthy"); process.exit(0); }
if (["start", "stop"].includes(args[0])) process.exit(0);
console.error("Unexpected fake Docker command"); process.exit(2);
`,
    { mode: 0o755 },
  );

  const run = (action: "start" | "stop", environment: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/postgresql-runtime.mts", action],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          LAB_DOCKER_COMMANDS: commands,
          ...environment,
        },
      },
    );
  const invocations = async () =>
    (await readFile(commands, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));

  const unownedStart = run("start");
  assert.notEqual(unownedStart.status, 0);
  assert.match(unownedStart.stderr, /Refusing to start unowned container/u);
  const unownedStop = run("stop");
  assert.notEqual(unownedStop.status, 0);
  assert.match(unownedStop.stderr, /Refusing to stop unowned container/u);
  assert.ok(
    !(await invocations()).some(
      (args) => Array.isArray(args) && ["start", "stop"].includes(args[0]),
    ),
  );

  const unownedVolume = run("start", { LAB_VOLUME_OWNER: "unowned" });
  assert.notEqual(unownedVolume.status, 0);
  assert.match(unownedVolume.stderr, /Refusing to reuse unowned volume/u);
  const unavailable = run("stop", { LAB_DOCKER_UNAVAILABLE: "1" });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /Cannot connect to the Docker daemon/u);
  const absent = run("stop", { LAB_CONTAINER_ABSENT: "1" });
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /already absent/u);
  for (const action of ["start", "stop"] as const) {
    const owned = run(action, { LAB_CONTAINER_OWNER: "postgresql" });
    assert.equal(owned.status, 0, owned.stderr);
  }
});
