import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createConsumerWorkspace } from "../scripts/consumer-workspace.mts";

async function fixture(context: TestContext) {
  const directory = await realpath(
    await mkdtemp(resolve(tmpdir(), "rtl-consumer-workspace-")),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const labRoot = resolve(directory, "lab");
  const consumerRoot = resolve(directory, "ordinary consumer");
  const project = async (path: string, name: string) => {
    await mkdir(path, { recursive: true });
    await writeFile(
      resolve(path, "package.json"),
      JSON.stringify({
        name,
        scripts: { test: "never execute package scripts" },
      }),
    );
    // A module that would fail if loaded: workspace creation only checks its metadata.
    await writeFile(
      resolve(path, "rehearsal.config.mjs"),
      'throw new Error("do not execute project configuration");\n',
    );
  };
  await mkdir(labRoot);
  await writeFile(
    resolve(labRoot, "package.json"),
    JSON.stringify({ name: "rehearsal-test-lab" }),
  );
  await project(
    resolve(labRoot, "projects/postgresql"),
    "@rehearsal-test-lab/postgresql",
  );
  await project(
    resolve(labRoot, "projects/supabase"),
    "@rehearsal-test-lab/supabase",
  );
  await project(consumerRoot, "ordinary-consumer");
  return { directory, labRoot, consumerRoot, project };
}

test("consumer workspace links independent roots without executing or copying consumer state", async (context) => {
  const paths = await fixture(context);
  const env = resolve(paths.consumerRoot, ".env.private");
  const ignoredState = resolve(paths.consumerRoot, ".rehearsal");
  await writeFile(env, "private-fixture-sentinel", { mode: 0o600 });
  await mkdir(ignoredState);
  await writeFile(resolve(ignoredState, "baseline-sentinel"), "untouched");
  const namesBefore = await readdir(paths.consumerRoot);
  const metadataBefore = await stat(env);
  const created = await createConsumerWorkspace(paths);
  assert.equal(
    created.path,
    resolve(
      paths.labRoot,
      "test-results/consumer-workspaces/ordinary-consumer.code-workspace",
    ),
  );
  assert.equal((await stat(created.path)).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(await readFile(created.path, "utf8")),
    created.workspace,
  );
  assert.deepEqual(
    created.workspace.folders.map(({ path }) => path),
    [
      resolve(paths.labRoot, "projects/postgresql"),
      resolve(paths.labRoot, "projects/supabase"),
      paths.consumerRoot,
    ],
  );
  assert.deepEqual(created.workspace.settings, {
    "rehearsal.configPath": "rehearsal.config.mjs",
    "rehearsal.openDashboardAutomatically": false,
  });
  assert.deepEqual(await readdir(paths.consumerRoot), namesBefore);
  assert.equal(await readFile(env, "utf8"), "private-fixture-sentinel");
  assert.equal(
    await readFile(resolve(ignoredState, "baseline-sentinel"), "utf8"),
    "untouched",
  );
  const metadataAfter = await stat(env);
  assert.equal(metadataAfter.ino, metadataBefore.ino);
  assert.equal(metadataAfter.mode, metadataBefore.mode);
  assert.equal("tasks" in created.workspace, false);
  assert.equal(
    JSON.stringify(created.workspace).includes("private-fixture-sentinel"),
    false,
  );
});

test("repeat creation refuses to overwrite reviewed workspace settings", async (context) => {
  const paths = await fixture(context);
  const first = await createConsumerWorkspace(paths);
  await writeFile(first.path, "reviewed user workspace\n");
  await assert.rejects(createConsumerWorkspace(paths), { code: "EEXIST" });
  assert.equal(await readFile(first.path, "utf8"), "reviewed user workspace\n");
});

test("consumer validation refuses missing root config rather than importing nested config", async (context) => {
  const paths = await fixture(context);
  await rm(resolve(paths.consumerRoot, "rehearsal.config.mjs"));
  await mkdir(resolve(paths.consumerRoot, "infrastructure"));
  await writeFile(
    resolve(paths.consumerRoot, "infrastructure/rehearsal.config.mjs"),
    "export default {};\n",
  );
  await assert.rejects(createConsumerWorkspace(paths), { code: "ENOENT" });
  await assert.rejects(stat(resolve(paths.labRoot, "test-results")), {
    code: "ENOENT",
  });
});

for (const file of ["package.json", "rehearsal.config.mjs"]) {
  test(`consumer workspace refuses symlinked ${file}`, async (context) => {
    const paths = await fixture(context);
    const target = resolve(paths.consumerRoot, file);
    const contents = await readFile(target);
    await writeFile(resolve(paths.directory, "outside"), contents);
    await rm(target);
    await symlink(resolve(paths.directory, "outside"), target);
    await assert.rejects(createConsumerWorkspace(paths), /regular files/u);
  });

  test(`consumer workspace bounds ${file}`, async (context) => {
    const paths = await fixture(context);
    await writeFile(
      resolve(paths.consumerRoot, file),
      "x".repeat(1024 * 1024 + 1),
    );
    await assert.rejects(createConsumerWorkspace(paths), /at most 1 MiB/u);
  });
}

test("consumer workspace refuses directory symlinks and links within Lab", async (context) => {
  const paths = await fixture(context);
  const alias = resolve(paths.directory, "alias");
  await symlink(paths.consumerRoot, alias, "dir");
  await assert.rejects(
    createConsumerWorkspace({ ...paths, consumerRoot: alias }),
    /not a symbolic link/u,
  );
  await assert.rejects(
    createConsumerWorkspace({
      ...paths,
      consumerRoot: resolve(paths.labRoot, "projects/postgresql"),
    }),
    /separate consumer/u,
  );
  await assert.rejects(
    createConsumerWorkspace({ ...paths, consumerRoot: "../consumer" }),
    /absolute/u,
  );
});

test("consumer workspace refuses a parent project containing the Lab", async (context) => {
  const paths = await fixture(context);
  await paths.project(paths.directory, "parent-consumer");
  await assert.rejects(
    createConsumerWorkspace({ ...paths, consumerRoot: paths.directory }),
    /separate consumer/u,
  );
});

test("consumer workspace refuses unsafe output directories without touching their target", async (context) => {
  const paths = await fixture(context);
  const outside = resolve(paths.directory, "outside");
  await mkdir(outside);
  await symlink(outside, resolve(paths.labRoot, "test-results"), "dir");
  await assert.rejects(
    createConsumerWorkspace(paths),
    /Lab-owned directories/u,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("consumer workspace validates Lab identity and bounded package JSON without echoing contents", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    resolve(paths.consumerRoot, "package.json"),
    "{private fixture malformed}",
  );
  await assert.rejects(
    createConsumerWorkspace(paths),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "The project's package.json must contain a JSON object.",
  );
  await paths.project(paths.consumerRoot, "ordinary-consumer");
  await writeFile(
    resolve(paths.labRoot, "package.json"),
    JSON.stringify({ name: "unrelated-project" }),
  );
  await assert.rejects(
    createConsumerWorkspace(paths),
    /Lab root has an unexpected package identity/u,
  );
});

test("consumer workspace CLI help does not prepare a workspace or run inference", () => {
  const executed = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/consumer-workspace.mts", "--help"],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(executed.status, 0, executed.stderr);
  assert.match(
    executed.stdout,
    /No configuration, environment, baseline, dependency or runtime is copied or changed/u,
  );
  assert.equal(executed.stderr, "");
});
