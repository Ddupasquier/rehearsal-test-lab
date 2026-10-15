import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createLabShapeDeclaration } from "../scripts/candidate/shape.mts";
import { requireObject } from "../scripts/shared/validation.mts";

const root = resolve(import.meta.dirname, "..");

for (const target of ["postgresql", "supabase"] as const) {
  test(`${target} shaping uses the independent reviewed fixture scope and every declared FK`, async () => {
    const privacy = requireObject(
      JSON.parse(
        await readFile(
          resolve(
            root,
            "projects",
            target,
            "infrastructure/rehearsal/sanitization-policy.json",
          ),
          "utf8",
        ),
      ),
      "Privacy policy",
    );
    const shape = createLabShapeDeclaration(privacy);
    const tables = privacy.tables as Record<string, unknown>[];
    assert.equal(shape.tables.length, tables.length);
    assert.equal(
      shape.tables.find((table) => table.name === "entries")?.rootRows,
      target === "supabase" ? 200 : 100,
    );
    assert.equal(shape.maximumRows, 300);
    assert.equal(shape.maximumSourceRows, 20_000);
    assert.equal(shape.maximumSourceBytes, 16 * 1024 * 1024);
    const foreignKeys = tables
      .flatMap((table) => table.columns as Record<string, unknown>[])
      .filter((column) => column.foreignKey && column.action !== "EXCLUDE");
    assert.equal(shape.relationships.length, foreignKeys.length);
    assert.equal(
      shape.relationships.every(
        (relation) => relation.includeChildren === false,
      ),
      true,
    );
    assert.equal(
      shape.relationships.every(
        (relation) =>
          relation.maximumChildrenPerParent >= 50 &&
          relation.maximumChildrenPerParent <= 200,
      ),
      true,
    );
    assert.equal(shape.distributions[0]?.required, true);
    assert.equal(
      shape.distributions[0]?.tolerance,
      target === "supabase" ? 0.03 : 0,
    );
    assert.equal(
      shape.jointDistributions.length,
      target === "supabase" ? 1 : 0,
    );
    assert.equal(
      /postgresql:\/\/|source-admin|source-reader|approved-owner|REHEARSAL_|blendcalc/iu.test(
        JSON.stringify(shape),
      ),
      false,
    );
  });
}

test("shape fixture refuses missing reviewed entry/key metadata", () => {
  assert.throws(() => createLabShapeDeclaration({ tables: [] }));
  assert.throws(() =>
    createLabShapeDeclaration({
      tables: [
        { schema: "lab_api", name: "entries", columns: [{ name: "owner_id" }] },
      ],
    }),
  );
});
