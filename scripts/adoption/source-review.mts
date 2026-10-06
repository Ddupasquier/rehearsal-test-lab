import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  requireArray,
  requireObject,
  requireString,
} from "../shared/validation.mts";

export interface SchemaColumn {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  identity: "YES" | "NO";
  generated: "ALWAYS" | "NEVER";
}
export interface SchemaForeignKey {
  schema_name: string;
  table_name: string;
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
}

export function verifyReviewedSchema(
  columns: SchemaColumn[],
  foreignKeys: SchemaForeignKey[],
  sourceValue: unknown,
  privacyValue: unknown,
) {
  const source = requireObject(sourceValue, "Reviewed source policy"),
    privacy = requireObject(privacyValue, "Reviewed privacy policy");
  assert.notEqual(
    privacy.draft,
    true,
    "Privacy decisions must be reviewed before copying",
  );
  const tables = requireArray(privacy.tables, "Privacy tables").map((table) =>
    requireObject(table, "Privacy table"),
  );
  const approved: string[] = [];
  for (const value of requireArray(
    source.relations,
    "Reviewed source relations",
  )) {
    const relation = requireObject(value, "Source relation");
    const origin = requireObject(relation.source, "Source table");
    const schema = requireString(origin.schema, "Source schema"),
      name = requireString(origin.table, "Source table name");
    const target = tables.find(
      (table) =>
        (table.schema ?? "public") === relation.targetSchema &&
        table.name === relation.targetTable,
    );
    assert.ok(target, `Missing privacy decisions for ${schema}.${name}`);
    const decisions = requireArray(target.columns, "Column decisions").map(
      (column) => requireObject(column, "Privacy column"),
    );
    const selected = requireArray(relation.columns, "Approved columns").map(
      (column) => requireString(column, "Approved column"),
    );
    assert.equal(
      new Set(selected).size,
      selected.length,
      `Duplicate export decisions for ${schema}.${name}`,
    );
    for (const column of selected) {
      const key = `${schema}.${name}.${column}`;
      const actual = columns.find(
        (entry) =>
          entry.schema_name === schema &&
          entry.table_name === name &&
          entry.column_name === column,
      );
      assert.ok(actual, `Approved column does not exist: ${key}`);
      const matches = decisions.filter((entry) => entry.name === column);
      assert.equal(
        matches.length,
        1,
        `Exactly one privacy decision is required for ${key}`,
      );
      const decision = matches[0]!;
      assert.ok(
        ["KEEP", "REPLACE", "PSEUDONYMIZE", "DERIVE", "EXCLUDE"].includes(
          String(decision.action),
        ),
        `Unreviewed privacy action for ${key}`,
      );
      if (
        ["REPLACE", "PSEUDONYMIZE", "DERIVE"].includes(String(decision.action))
      )
        requireObject(decision.recipe, `Required privacy recipe for ${key}`);
      assert.equal(
        decision.identity,
        actual.identity,
        `Identity decision differs from database schema: ${key}`,
      );
      assert.equal(
        decision.generated,
        actual.generated,
        `Generated-column decision differs from database schema: ${key}`,
      );
      const fk = foreignKeys.find(
        (entry) =>
          entry.schema_name === schema &&
          entry.table_name === name &&
          entry.column_name === column,
      );
      assert.deepEqual(
        decision.foreignKey,
        fk
          ? {
              schema: fk.referenced_schema,
              table: fk.referenced_table,
              column: fk.referenced_column,
            }
          : null,
        `Foreign-key decision differs from database schema: ${key}`,
      );
      approved.push(key);
    }
    assert.deepEqual(
      decisions.map((entry) => entry.name).sort(),
      [...selected].sort(),
      `Privacy decisions must match the approved export of ${schema}.${name}`,
    );
  }
  return {
    approvedColumns: approved.sort(),
    notExported: columns
      .map(
        (column) =>
          `${column.schema_name}.${column.table_name}.${column.column_name}`,
      )
      .filter((key) => !approved.includes(key))
      .sort(),
  };
}

export function assessSourceHandoff(transcript: string) {
  const options = [
    ...new Set(
      [...transcript.matchAll(/^\s*[›>]?\s*\d+\.\s*(.+)$/gmu)].map((match) =>
        match[1]!.trim(),
      ),
    ),
  ];
  const requiresFiles =
    transcript.includes("Sanitized NDJSON records") &&
    transcript.includes("Migration ledger");
  const sourceEntryObserved = options.some((option) =>
    /source|prepare.*database|copy.*database/iu.test(option),
  );
  return {
    status:
      requiresFiles && !sourceEntryObserved
        ? "gap-observed"
        : "needs-focused-verification",
    observedMenuOptions: options,
    preExportedFilesRequested: requiresFiles,
    sourceEntryObserved,
    unmetScenario:
      "An app with a working database and no pre-exported files needs a public guided source/schema/privacy review path.",
    scope:
      "Observed public menu and file prompts only; this assessment does not certify a future source wizard.",
  };
}

export function assessReviewDiagnostics(
  diagnostics: { code: string; message: unknown; suggestions: unknown }[],
) {
  const genericFailures = diagnostics.filter(
    (diagnostic) => diagnostic.code === "INTERNAL_FAILURE",
  ).length;
  return {
    status: genericFailures ? "gap-observed" : "needs-focused-verification",
    genericInternalFailuresForUserDecisions: genericFailures,
    unmetScenario:
      "Approval and privacy-review mistakes need user-correctable categories and precise next steps for reviewing a fresh source plan or completing privacy decisions.",
    scope:
      "Characterization of observed diagnostics; a different code alone does not certify actionable recovery guidance.",
  };
}

export async function assertCanaryAbsent(directory: string, canary: string) {
  let files = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        assert.equal(
          (await readFile(file)).includes(Buffer.from(canary)),
          false,
          `Sensitive source marker persisted in ${file}`,
        );
        files++;
      } else if (!entry.isSymbolicLink())
        throw new Error(`Unsupported baseline entry: ${file}`);
    }
  };
  await visit(directory);
  return files;
}
