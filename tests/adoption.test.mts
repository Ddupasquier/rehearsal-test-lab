import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const project = resolve(import.meta.dirname, "../projects/library");
test("primary consumer is an independent ordinary app without prepared Rehearsal state", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(project, "package.json"), "utf8"),
  );
  assert.equal(manifest.dependencies["@rehearsal-db/core"], undefined);
  assert.equal(manifest.devDependencies?.["@rehearsal-db/core"], undefined);
  assert.deepEqual(Object.keys(manifest.scripts).sort(), [
    "dev",
    "migrate",
    "seed",
    "test",
  ]);
  for (const path of [
    "rehearsal.config.mjs",
    "infrastructure/rehearsal",
    ".rehearsal",
  ])
    await assert.rejects(access(resolve(project, path)), { code: "ENOENT" });
  for (const path of [
    "app/server.mts",
    "app/proof.mts",
    "scripts/database.mts",
    "database/migrations/20260101000100_create_library.sql",
  ]) {
    const source = await readFile(resolve(project, path), "utf8");
    assert.doesNotMatch(
      source,
      /rehearsal|blendcalc|lab_api|publication\.documents/iu,
    );
  }
});
