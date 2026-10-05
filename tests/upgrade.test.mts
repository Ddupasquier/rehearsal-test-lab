import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  assertUpgradeVersions,
  assertUpgradeState,
  snapshotUpgradeState,
  assertSupportedPreviousRelease,
} from "../scripts/candidate/upgrade.mts";

test("upgrade selection rejects equal builds, downgrades, and malformed versions", () => {
  for (const [from, to] of [
    ["0.1.0-beta.9", "0.1.0-beta.10"],
    ["0.1.0-beta.13", "0.1.0"],
    ["0.1.0", "0.2.0-beta.1"],
    ["1.0.0-1", "1.0.0-a"],
  ])
    assertUpgradeVersions(from!, to!);
  for (const [from, to] of [
    ["0.1.0-beta.13", "0.1.0-beta.12"],
    ["0.1.0-beta.13", "0.1.0-beta.13"],
    ["1.0.0+first", "1.0.0+second"],
    ["0.1.0", "0.1.0-beta.13"],
    ["0.1.0-beta.01", "0.1.0-beta.2"],
  ])
    assert.throws(() => assertUpgradeVersions(from!, to!));
});

test("unsupported previous releases are refused before creating consumer state", () => {
  assert.throws(
    () => assertSupportedPreviousRelease("0.1.0-beta.12"),
    /requires a previous release/u,
  );
  assertSupportedPreviousRelease("0.1.0-beta.13");
  assertSupportedPreviousRelease("0.1.0");
});

test("upgrade preservation detects baseline, pointer, configuration, and privacy permission changes", async (context) => {
  const project = await mkdtemp(resolve(tmpdir(), "rtl-upgrade-state-"));
  context.after(() => rm(project, { recursive: true, force: true }));
  for (const path of [
    "infrastructure/rehearsal",
    ".rehearsal/secrets",
    ".rehearsal/generations/previous",
  ])
    await mkdir(resolve(project, path), { recursive: true });
  for (const path of [
    "rehearsal.config.mjs",
    "package.json",
    ".rehearsal/candidate.config.mjs",
    ".rehearsal/secrets/privacy.key",
    ".rehearsal/generations/previous/baseline-manifest.json",
  ])
    await writeFile(resolve(project, path), "synthetic", { mode: 0o600 });
  await symlink("generations/previous", resolve(project, ".rehearsal/current"));
  const before = await snapshotUpgradeState(project);
  assertUpgradeState(before, await snapshotUpgradeState(project));
  await mkdir(resolve(project, "node_modules"));
  await writeFile(resolve(project, "node_modules/changed-package"), "allowed");
  assertUpgradeState(before, await snapshotUpgradeState(project));
  await writeFile(
    resolve(project, ".rehearsal/generations/previous/baseline-manifest.json"),
    "changed",
  );
  assert.throws(() =>
    assertUpgradeState(before, {
      ...before,
      "rehearsal.config.mjs": "changed",
    }),
  );
  assert.throws(() =>
    assertUpgradeState(before, withoutBaselineManifest(before)),
  );
  assert.notDeepEqual(before, await snapshotUpgradeState(project));
  await writeFile(
    resolve(project, ".rehearsal/generations/previous/baseline-manifest.json"),
    "synthetic",
  );
  await chmod(resolve(project, ".rehearsal/secrets/privacy.key"), 0o644);
  const after = await snapshotUpgradeState(project);
  assert.throws(() => assertUpgradeState(before, after));
  assert.throws(() =>
    assertUpgradeState(before, {
      ...before,
      ".rehearsal/current": "link:generations/different",
    }),
  );
});

function withoutBaselineManifest(before: Record<string, string>) {
  const after = { ...before };
  delete after[".rehearsal/generations/previous/baseline-manifest.json"];
  return after;
}
