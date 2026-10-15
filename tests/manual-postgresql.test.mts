import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  checkManualInstallation,
  manualConfiguration,
  manualInstructions,
  prepareManualPostgresql,
} from "../scripts/manual-postgresql.mts";
import { runCommand, sha256File } from "../scripts/candidate/process.mts";

async function fixture(directory: string) {
  directory = await realpath(directory);
  const root = resolve(directory, "lab");
  await mkdir(root);
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\n.rehearsal/\n**/.rehearsal/\ntest-results/\n",
    "package.json": '{"name":"synthetic-lab","private":true}',
    "projects/postgresql/rehearsal.config.mjs":
      'export default {runtime:{projectId:"rehearsal-test-lab-postgresql-rehearsal",databasePort:58642,applicationUrl:"http://localhost:5176"},containerRuntime:{autoStartColima:true},preparation:{privacyKey:".rehearsal/secrets/privacy.key"}};\n',
    "projects/postgresql/compose.yaml":
      "name: rehearsal-test-lab-postgresql\ncontainer_name: rehearsal-test-lab-postgresql\nport: 127.0.0.1:55432:5432\nvolume: rehearsal_lab_postgresql\n",
    "projects/postgresql/app/server.mts":
      "const port = Number(process.env.PORT ?? 5176);\n",
    "projects/postgresql/infrastructure/rehearsal/source-access-policy.json":
      '{"targetFingerprint":"original","relations":[]}',
    "projects/supabase/infrastructure/rehearsal/source-access-policy.json":
      '{"targetFingerprint":"original","relations":[],"assetReader":{"endpointFingerprint":"original"}}',
    "projects/postgresql/.rehearsal/secrets/privacy.key":
      "private original marker",
    "projects/postgresql/.rehearsal/generations/old/manifest.json":
      "private baseline marker",
  };
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, relative)), { recursive: true });
    await writeFile(resolve(root, relative), contents);
  }
  runCommand("git", ["init", "--quiet"], { cwd: root });
  const packageDirectory = resolve(directory, "package");
  await mkdir(packageDirectory);
  await writeFile(
    resolve(packageDirectory, "package.json"),
    '{"name":"@rehearsal-db/core","version":"0.0.0-manual-test"}\n',
  );
  await writeFile(
    resolve(packageDirectory, "entry.mjs"),
    "export const synthetic = true;\n",
  );
  const artifact = resolve(directory, "candidate.tgz");
  runCommand("tar", ["-czf", artifact, "-C", directory, "package"]);
  return {
    root,
    artifact,
    expectedSha256: await sha256File(artifact),
    reportRoot: resolve(directory, "reports"),
    leaseRoot: resolve(directory, "leases"),
  };
}

test("manual preparation is isolated, starts from no private state and pins exact candidate bytes", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-manual-pg-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  const original = await readFile(
    resolve(input.root, "projects/postgresql/rehearsal.config.mjs"),
    "utf8",
  );
  const originalGitHead = await readFile(
    resolve(input.root, ".git/HEAD"),
    "utf8",
  );
  const originalGitConfig = await readFile(
    resolve(input.root, ".git/config"),
    "utf8",
  );
  const result = await prepareManualPostgresql(input);
  assert.equal(result.state, "prepared-not-executed");
  assert.equal(result.artifact.sha256, input.expectedSha256);
  assert.equal(
    await sha256File(resolve(result.directory, "candidate.tgz")),
    input.expectedSha256,
  );
  assert.equal(result.persistentPortLease, true);
  const lease = JSON.parse(
    await readFile(resolve(result.portLease, "owner.json"), "utf8"),
  );
  assert.equal(lease.purpose, "manual-postgresql");
  assert.equal(lease.persistent, true);
  assert.equal(lease.workspace, result.workspace);
  assert.equal((await lstat(result.directory)).mode & 0o777, 0o700);
  assert.equal(
    (await lstat(resolve(result.directory, "manual-session.json"))).mode &
      0o777,
    0o600,
  );
  assert.match(
    await readFile(
      resolve(result.workspace, "projects/postgresql/rehearsal.config.mjs"),
      "utf8",
    ),
    /autoStartColima:\s*false/u,
  );
  assert.match(
    await readFile(
      resolve(result.workspace, "projects/postgresql/rehearsal.config.mjs"),
      "utf8",
    ),
    /stopOwnedColimaWhenIdle: false/u,
  );
  const copied = await readFile(
    resolve(
      result.workspace,
      "projects/postgresql/fixture-original.mjs",
    ),
    "utf8",
  );
  assert.ok(copied.includes(result.bindings.targetPostgresql));
  assert.ok(copied.includes(String(result.bindings.base + 25)));
  assert.ok(copied.includes(String(result.bindings.base + 28)));
  const projectFiles = await readdir(
    resolve(result.workspace, "projects/postgresql"),
  );
  // Match public discovery's root config filename family, not just its default name.
  assert.deepEqual(
    projectFiles.filter((name) =>
      /^rehearsal(?:\.[a-z0-9_-]+)?\.config\.(?:mjs|js|ts)$/iu.test(name)
    ),
    ["rehearsal.config.mjs"],
  );
  assert.ok(!projectFiles.includes("rehearsal.fixture.config.mjs"));
  assert.equal(
    await readFile(
      resolve(result.workspace, "projects/postgresql/rehearsal.config.mjs"),
      "utf8",
    ),
    manualConfiguration(copied),
  );
  assert.match(
    await readFile(
      resolve(result.workspace, "projects/postgresql/app/server.mts"),
      "utf8",
    ),
    new RegExp(String(result.bindings.base + 28), "u"),
  );
  await assert.rejects(
    lstat(resolve(result.workspace, "projects/postgresql/.rehearsal")),
    { code: "ENOENT" },
  );
  await assert.rejects(lstat(resolve(result.workspace, "node_modules")), {
    code: "ENOENT",
  });
  assert.equal(
    runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: result.workspace,
    }).stdout.trim(),
    result.workspace,
  );
  assert.equal(
    runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve(result.workspace, "projects/postgresql"),
    }).stdout.trim(),
    result.workspace,
  );
  assert.equal(
    runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: input.root,
    }).stdout.trim(),
    input.root,
  );
  assert.equal(
    await readFile(resolve(input.root, ".git/HEAD"), "utf8"),
    originalGitHead,
  );
  assert.equal(
    await readFile(resolve(input.root, ".git/config"), "utf8"),
    originalGitConfig,
  );
  await assert.rejects(lstat(resolve(result.workspace, ".git/hooks")), {
    code: "ENOENT",
  });
  assert.throws(() =>
    runCommand("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: result.workspace,
    }),
  );
  assert.equal(
    await readFile(
      resolve(input.root, "projects/postgresql/rehearsal.config.mjs"),
      "utf8",
    ),
    original,
  );
  assert.equal(
    await readFile(
      resolve(input.root, "projects/postgresql/.rehearsal/secrets/privacy.key"),
      "utf8",
    ),
    "private original marker",
  );
  const instructions = await readFile(result.instructions, "utf8");
  assert.match(instructions, /prepared|supplied/u);
  assert.ok(instructions.includes(`${result.bindings.base + 28}/summary`));
  assert.ok(instructions.includes("../../../candidate.tgz"));
  assert.ok(
    instructions.indexOf("npm run postgresql:stop") <
      instructions.indexOf("rehearsal run --plain"),
  );
  assert.ok(!instructions.includes("docker system prune"));
});

test("manual preparation rejects a wrong or abbreviated hash before allocating workspace or ports", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-manual-pg-hash-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  for (const expectedSha256 of ["short", "0".repeat(64)]) {
    await assert.rejects(
      prepareManualPostgresql({ ...input, expectedSha256 }),
      /SHA-256/u,
    );
    await assert.rejects(lstat(input.reportRoot), { code: "ENOENT" });
    await assert.rejects(lstat(input.leaseRoot), { code: "ENOENT" });
  }
});

test("manual preparation refuses symlink artifacts and releases its own lease after snapshot failure", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-manual-pg-refusal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  const link = resolve(directory, "linked.tgz");
  await symlink(input.artifact, link);
  await assert.rejects(
    prepareManualPostgresql({ ...input, artifact: link }),
    /not a symlink/u,
  );
  await symlink(
    resolve(directory, "package/entry.mjs"),
    resolve(input.root, "unsafe.mjs"),
  );
  await assert.rejects(prepareManualPostgresql(input), /non-regular file/u);
  assert.deepEqual(await readdir(input.leaseRoot), []);
});

test("manual preparation refuses redirected roots and output ancestors without writing outside", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-manual-pg-paths-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  const parent = dirname(input.root);
  const rootLink = resolve(parent, "lab-link");
  await symlink(input.root, rootLink, "dir");
  await assert.rejects(
    prepareManualPostgresql({ ...input, root: rootLink }),
    /Lab root.*canonical/u,
  );
  await assert.rejects(lstat(input.reportRoot), { code: "ENOENT" });
  const outside = resolve(parent, "outside");
  await mkdir(outside);
  await symlink(outside, resolve(input.root, "test-results"), "dir");
  await assert.rejects(
    prepareManualPostgresql({
      ...input,
      reportRoot: resolve(input.root, "test-results/manual-postgresql"),
    }),
    /Manual session output.*canonical/u,
  );
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(lstat(input.leaseRoot), { code: "ENOENT" });
  const leaseParent = resolve(parent, "lease-link");
  await symlink(outside, leaseParent, "dir");
  await assert.rejects(
    prepareManualPostgresql({
      ...input,
      leaseRoot: resolve(leaseParent, "leases"),
    }),
    /Port lease output.*canonical/u,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("manual inspection uses only the verified private copy when the original changes", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-manual-pg-copy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  const session = await prepareManualPostgresql(
    input,
    async (source, destination) => {
      await copyFile(source, destination);
      await writeFile(source, "the original changed after copying");
    },
  );
  assert.equal(session.artifact.version, "0.0.0-manual-test");
  assert.equal(session.artifact.sha256, input.expectedSha256);
  assert.equal(
    await sha256File(resolve(session.directory, "candidate.tgz")),
    input.expectedSha256,
  );
  assert.notEqual(await sha256File(input.artifact), input.expectedSha256);
});

test("changed copied bytes refuse before archive inspection or port allocation", async (context) => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "rtl-manual-pg-copy-refusal-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  await assert.rejects(
    prepareManualPostgresql(input, async (_source, destination) => {
      await writeFile(destination, "changed archive bytes");
    }),
    /Candidate changed during preparation/u,
  );
  await assert.rejects(lstat(input.leaseRoot), { code: "ENOENT" });
  const [session] = await readdir(input.reportRoot);
  assert.ok(session);
  await assert.rejects(
    lstat(resolve(input.reportRoot, session, "manual-session.json")),
    { code: "ENOENT" },
  );
});

test("manual sessions do not compete for resource names or ports", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-manual-pg-parallel-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  const [first, second] = await Promise.all([
    prepareManualPostgresql(input),
    prepareManualPostgresql(input),
  ]);
  assert.notEqual(first.workspace, second.workspace);
  assert.notEqual(first.portLease, second.portLease);
  assert.notEqual(first.bindings.base, second.bindings.base);
  assert.notEqual(
    first.bindings.targetPostgresql,
    second.bindings.targetPostgresql,
  );
  assert.notEqual(first.bindings.sourceVolume, second.bindings.sourceVolume);
});

test("each subsequent manual round starts fresh without changing a used session", async (context) => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "rtl-manual-pg-fresh-round-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  const options = {
    ...input,
    reportRoot: resolve(input.root, "test-results/manual-postgresql"),
  };
  const originalConfiguration = await readFile(
    resolve(input.root, "projects/postgresql/rehearsal.config.mjs"),
    "utf8",
  );
  const first = await prepareManualPostgresql(options);
  const configurationPath = "projects/postgresql/rehearsal.config.mjs";
  const firstConfiguration = await readFile(
    resolve(first.workspace, configurationPath),
    "utf8",
  );
  const firstState: Record<string, string> = {
    "node_modules/first-session-dependency.txt":
      "first session dependency marker",
    "projects/postgresql/node_modules/@rehearsal-db/core/package.json":
      '{"name":"@rehearsal-db/core","version":"0.0.0-first-session"}',
    "projects/postgresql/.rehearsal/secrets/privacy.key":
      "synthetic first session key",
    "projects/postgresql/.rehearsal/generations/first/manifest.json":
      '{"synthetic":"first session baseline"}',
    ".manual-source-data/source.marker": "synthetic first session source data",
    [configurationPath]: `${firstConfiguration}// First-session reviewed edit stays here.\n`,
  };
  for (const [relative, contents] of Object.entries(firstState)) {
    await mkdir(dirname(resolve(first.workspace, relative)), {
      recursive: true,
    });
    await writeFile(resolve(first.workspace, relative), contents);
  }

  const second = await prepareManualPostgresql(options);
  assert.notEqual(second.workspace, first.workspace);
  assert.notEqual(second.portLease, first.portLease);
  assert.notEqual(second.bindings.base, first.bindings.base);
  assert.notEqual(
    second.bindings.targetPostgresql,
    first.bindings.targetPostgresql,
  );
  assert.notEqual(
    second.bindings.sourcePostgresql,
    first.bindings.sourcePostgresql,
  );
  assert.notEqual(second.bindings.sourceVolume, first.bindings.sourceVolume);
  for (const relative of [
    "node_modules",
    "projects/postgresql/node_modules",
    "projects/postgresql/.rehearsal",
    ".manual-source-data",
    "test-results",
  ])
    await assert.rejects(lstat(resolve(second.workspace, relative)), {
      code: "ENOENT",
    });
  const secondConfiguration = await readFile(
    resolve(second.workspace, configurationPath),
    "utf8",
  );
  assert.ok(!secondConfiguration.includes("First-session reviewed edit"));
  assert.ok(!secondConfiguration.includes(first.bindings.prefix));
  assert.ok(secondConfiguration.includes(second.bindings.prefix));
  for (const [relative, contents] of Object.entries(firstState))
    assert.equal(
      await readFile(resolve(first.workspace, relative), "utf8"),
      contents,
    );
  assert.equal(
    await readFile(resolve(input.root, configurationPath), "utf8"),
    originalConfiguration,
  );
  for (const session of [first, second]) {
    const lease = JSON.parse(
      await readFile(resolve(session.portLease, "owner.json"), "utf8"),
    );
    assert.equal(lease.workspace, session.workspace);
    assert.equal(lease.persistent, true);
  }
});

test("exact manual installation check detects wrong bytes and wrong-workspace receipts", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "rtl-manual-pg-install-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(directory);
  const session = await prepareManualPostgresql(input);
  const installed = resolve(
    session.workspace,
    "projects/postgresql/node_modules/@rehearsal-db/core",
  );
  await mkdir(installed, { recursive: true });
  for (const file of ["package.json", "entry.mjs"])
    await copyFile(
      resolve(directory, "package", file),
      resolve(installed, file),
    );
  assert.deepEqual(await checkManualInstallation(session.workspace), {
    version: "0.0.0-manual-test",
    sha256: input.expectedSha256,
    files: 2,
  });
  await writeFile(resolve(installed, "entry.mjs"), "changed");
  await assert.rejects(
    checkManualInstallation(session.workspace),
    /bytes differ/u,
  );
  const receiptPath = resolve(session.directory, "manual-session.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  await writeFile(
    receiptPath,
    JSON.stringify({ ...receipt, workspace: "/another/project" }),
  );
  await assert.rejects(
    checkManualInstallation(session.workspace),
    /exact prepared manual workspace/u,
  );
});

test("manual instructions quote workspace paths safely and preserve explicit review boundaries", () => {
  const guide = manualInstructions("/tmp/my project's/workspace", 45028);
  assert.ok(guide.includes("cd '/tmp/my project'\\''s/workspace'"));
  assert.ok(guide.includes("--confirm-source-access=PASTE_FULL_DIGEST"));
  assert.ok(guide.includes("--confirm-source-retirement=PASTE_FULL_DIGEST"));
  assert.ok(guide.includes("lease is intentionally retained"));
  assert.ok(guide.includes("not prove applying a new migration"));
  assert.ok(guide.includes("docs/manual-postgresql.md"));
});

test("manual configuration changes only real engine booleans without executing imports or statements", () => {
  const source = `import { defineRehearsalConfig } from "@fixture/do-not-import";
throw new Error("This configuration must never execute during preparation");
// autoStartColima: true and stopOwnedColimaWhenIdle: true are lookalike comments.
export default defineRehearsalConfig({
  project: { name: "Keep this friendly name" },
  application: { startCommand: "npm run dev", readiness: { url: "http://localhost:5176/health" } },
  runtime: { applicationUrl: "http://localhost:5176", projectId: "unchanged" },
  containerRuntime: {
    autoStartColima: /* retain comment */ true,
    stopOwnedColimaWhenIdle: true,
    approvedSetting: "unchanged",
  },
});
`;
  const expected = source
    .replace(
      "autoStartColima: /* retain comment */ true",
      "autoStartColima: /* retain comment */ false",
    )
    .replace(
      "    stopOwnedColimaWhenIdle: true",
      "    stopOwnedColimaWhenIdle: false",
    );
  assert.equal(manualConfiguration(source), expected);
  assert.equal(manualConfiguration(expected), expected);
});

test("manual configuration supports direct literal roots and adds only missing safe engine policies", () => {
  for (const source of [
    'export default { runtime: { projectId: "literal-root" } };\n',
    "export default { containerRuntime: {} };\n",
    "export default { containerRuntime: { autoStartColima: false } };\n",
    'export default {\r\n  runtime: { projectId: "keep" },\r\n  containerRuntime: {\r\n    autoStartColima: true // retain comment\r\n  },\r\n};\r\n',
  ]) {
    const transformed = manualConfiguration(source);
    assert.match(transformed, /autoStartColima:\s*false/u);
    assert.match(transformed, /stopOwnedColimaWhenIdle:\s*false/u);
    assert.equal(manualConfiguration(transformed), transformed);
    assert.ok(!transformed.includes("...base"));
    if (source.includes('projectId: "keep"')) {
      assert.ok(transformed.includes('projectId: "keep"'));
      assert.ok(transformed.includes("// retain comment"));
      assert.ok(!transformed.replaceAll("\r\n", "").includes("\n"));
    }
  }
});

test("manual configuration preserves real trailing separators and ignores commas in comments", () => {
  for (const source of [
    "export default { containerRuntime: { autoStartColima: true, } };\n",
    "export default { containerRuntime: { autoStartColima: true /* comma only in comment , */ } };\n",
    "export default {\n  containerRuntime: {\n    autoStartColima: true,\n  },\n};\n",
    "export default {\n  containerRuntime: {\n    autoStartColima: true, // keep this trailing comment ,\n  },\n};\n",
    "export default {\n  containerRuntime: {\n    autoStartColima: true /* keep , in block comment */,\n  },\n};\n",
    "export default {\n  containerRuntime: {\n    autoStartColima: true // no separator here; comma is comment-only ,\n  },\n};\n",
    "export default {\n  runtime: { projectId: 'trailing-root-comma' }, // keep root comment ,\n};\n",
  ]) {
    const transformed = manualConfiguration(source);
    assert.match(transformed, /autoStartColima:\s*false/u);
    assert.match(transformed, /stopOwnedColimaWhenIdle:\s*false/u);
    assert.ok(!transformed.includes("false,,"));
    assert.equal(manualConfiguration(transformed), transformed);
    for (const comment of source.match(/\/\*[^]*?\*\/|\/\/[^\n]*/gu) ?? [])
      assert.ok(transformed.includes(comment));
  }
});

test("manual configuration transforms the actual reviewed PostgreSQL fixture into valid editable literals", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "../projects/postgresql/rehearsal.config.mjs"),
    "utf8",
  );
  const transformed = manualConfiguration(source);
  assert.equal(
    transformed.replace("    stopOwnedColimaWhenIdle: false,\n", ""),
    source.replace("autoStartColima: true", "autoStartColima: false"),
  );
  assert.equal(manualConfiguration(transformed), transformed);
  assert.ok(transformed.includes("runtime: {"));
  assert.ok(transformed.includes("application: {"));
});

test("manual configuration refuses spreads, ambiguous keys, computed properties and dynamic engine policies", () => {
  for (const source of [
    "export default { ...base, containerRuntime: { autoStartColima: true } };",
    "export default { containerRuntime: { ...engine } };",
    "export default { runtime: { ...runtime }, containerRuntime: {} };",
    'export default { ["containerRuntime"]: {} };',
    'export default { containerRuntime: {}, "containerRuntime": {} };',
    'export default { containerRuntime: { autoStartColima: true, "autoStartColima": false } };',
    'export default { containerRuntime: { ["autoStartColima"]: true } };',
    "export default { containerRuntime: engine };",
    "export default { containerRuntime: { autoStartColima: getChoice() } };",
    "export default { containerRuntime: { get autoStartColima() { return true; } } };",
    "export default arbitraryFactory({ containerRuntime: {} });",
    "export default defineRehearsalConfig({}, {});",
    "export default {}; export default {};",
    "export default { containerRuntime: { autoStartColima: ",
  ])
    assert.throws(() => manualConfiguration(source), /Manual fixture/u);
});
