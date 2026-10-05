import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import {
  acquirePortLease,
  acquireHeavyLease,
  createWorkspace,
  isolationBindings,
  rewriteFixture,
  removeOwnedResources,
  removeWorkspace,
} from "../scripts/candidate/isolation.mts";

test("successful workspace cleanup removes immutable baselines without following symlinks", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-immutable-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = resolve(directory, "workspace");
  const baseline = resolve(workspace, ".rehearsal/generations/immutable");
  await mkdir(baseline, { recursive: true });
  await writeFile(resolve(baseline, "manifest.json"), "{}", { mode: 0o400 });
  await chmod(baseline, 0o500);
  const outside = resolve(directory, "outside");
  await mkdir(outside);
  await writeFile(resolve(outside, "sentinel"), "untouched");
  await symlink(outside, resolve(workspace, "external"));
  await removeWorkspace(workspace);
  await assert.rejects(readFile(resolve(baseline, "manifest.json")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(resolve(outside, "sentinel"), "utf8"),
    "untouched",
  );
});

test("parallel acceptance leases and bindings do not share ports or Docker identities", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-leases-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const leases = await Promise.all([
    acquirePortLease(directory),
    acquirePortLease(directory),
  ]);
  try {
    assert.notEqual(leases[0]?.base, leases[1]?.base);
    const first = isolationBindings(leases[0]!.base);
    const second = isolationBindings(leases[1]!.base);
    for (const key of [
      "sourcePostgresql",
      "sourceSupabase",
      "targetPostgresql",
      "targetSupabase",
      "sourceVolume",
    ] as const)
      assert.notEqual(first[key], second[key]);
    assert.ok(first.targetPostgresql.length <= 40);
    assert.ok(first.targetSupabase.length <= 40);
    const server = createServer();
    await new Promise<void>((done) =>
      server.listen(first.base, "127.0.0.1", done),
    );
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    const releasedPath = leases[0]!.path;
    await leases[0]!.release();
    await assert.rejects(readFile(resolve(releasedPath, "owner.json")), {
      code: "ENOENT",
    });
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }
});

test("outer cleanup refuses a Supabase container from a different workspace", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-cleanup-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bindings = isolationBindings(45000, "cleanup123");
  const calls: string[][] = [];
  const command = (_name: string, args: readonly string[] = []) => {
    calls.push([...args]);
    let stdout = "";
    if (
      args.includes("ls") &&
      args.includes(`label=com.supabase.cli.project=${bindings.sourceSupabase}`)
    )
      stdout = "foreign-container";
    if (args.includes("inspect"))
      stdout = JSON.stringify({
        "com.supabase.cli.project": bindings.sourceSupabase,
        "com.supabase.cli.workdir": "/another/workspace",
      });
    return { stdout, stderr: "", output: stdout };
  };
  await assert.rejects(
    removeOwnedResources(directory, bindings, command),
    /ownership differs/u,
  );
  assert.equal(
    calls.some((args) => args.includes("rm") || args.includes("down")),
    false,
  );
});

test("Supabase resource slot serializes heavy phases and releases on completion", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-heavy-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const release = await acquireHeavyLease(directory);
  let secondEntered = false;
  const waiting = acquireHeavyLease(directory).then((releaseSecond) => {
    secondEntered = true;
    return releaseSecond;
  });
  assert.equal(secondEntered, false);
  await release();
  const releaseSecond = await waiting;
  assert.equal(secondEntered, true);
  await releaseSecond();
});

test("snapshot isolates installs, rebases all runtime endpoints, and preserves reviewed source scope", async (context) => {
  const root = resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-snapshot-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = resolve(directory, "workspace");
  const bindings = isolationBindings(45000, "abcdef1234");
  await createWorkspace(root, workspace, bindings);
  const text = await readFile(
    resolve(workspace, "projects/postgresql/compose.yaml"),
    "utf8",
  );
  assert.match(text, /rtl-abcdef1234-postgresql/u);
  assert.match(text, /127\.0\.0\.1:45024:5432/u);
  assert.match(text, /com\.rehearsal-test-lab\.resource/u);
  assert.equal(
    await readFile(
      resolve(workspace, "scripts/candidate/isolation.mts"),
      "utf8",
    ),
    await readFile(resolve(root, "scripts/candidate/isolation.mts"), "utf8"),
  );
  for (const excluded of [
    "node_modules",
    ".git",
    "test-results",
    "projects/postgresql/.rehearsal",
    "projects/postgresql/database/migrations/20261005000100_rehearsal_candidate_probe.sql",
  ])
    await assert.rejects(readFile(resolve(workspace, excluded)), {
      code: "ENOENT",
    });
  for (const provider of ["postgresql", "supabase"]) {
    const relative = `projects/${provider}/infrastructure/rehearsal/source-access-policy.json`;
    const original = JSON.parse(
      await readFile(resolve(root, relative), "utf8"),
    );
    const copied = JSON.parse(
      await readFile(resolve(workspace, relative), "utf8"),
    );
    assert.notEqual(copied.targetFingerprint, original.targetFingerprint);
    assert.deepEqual(copied.relations, original.relations);
    assert.deepEqual(copied.assets, original.assets);
  }
  await mkdir(resolve(workspace, "node_modules"));
  await writeFile(resolve(workspace, "node_modules/marker"), "independent");
  await assert.rejects(readFile(resolve(root, "node_modules/marker")), {
    code: "ENOENT",
  });
  assert.equal(
    rewriteFixture(
      "com.rehearsal-test-lab.resource rehearsal-test-lab 58422 58342 55432 8083",
      bindings,
    ),
    "com.rehearsal-test-lab.resource rtl-abcdef1234 45002 45014 45024 45026",
  );
});
