import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  verifyReviewedSchema,
  assessSourceHandoff,
  assertCanaryAbsent,
  assessReviewDiagnostics,
} from "../scripts/adoption/source-review.mts";
import type {
  SchemaColumn,
  SchemaForeignKey,
} from "../scripts/adoption/source-review.mts";

const columns: SchemaColumn[] = [
  {
    schema_name: "public",
    table_name: "books",
    column_name: "id",
    data_type: "bigint",
    identity: "YES",
    generated: "NEVER",
  },
  {
    schema_name: "public",
    table_name: "loans",
    column_name: "id",
    data_type: "bigint",
    identity: "YES",
    generated: "NEVER",
  },
  {
    schema_name: "public",
    table_name: "loans",
    column_name: "book_id",
    data_type: "bigint",
    identity: "NO",
    generated: "NEVER",
  },
  {
    schema_name: "public",
    table_name: "loans",
    column_name: "reader_label",
    data_type: "text",
    identity: "NO",
    generated: "NEVER",
  },
];
const foreignKeys: SchemaForeignKey[] = [
  {
    schema_name: "public",
    table_name: "loans",
    column_name: "book_id",
    referenced_schema: "public",
    referenced_table: "books",
    referenced_column: "id",
  },
];
const source = {
  relations: [
    {
      source: { schema: "public", table: "books" },
      targetSchema: "public",
      targetTable: "books",
      columns: ["id"],
    },
    {
      source: { schema: "public", table: "loans" },
      targetSchema: "public",
      targetTable: "loans",
      columns: ["id", "book_id", "reader_label"],
    },
  ],
};
const privacy = {
  tables: [
    {
      schema: "public",
      name: "books",
      columns: [
        {
          name: "id",
          action: "KEEP",
          identity: "YES",
          generated: "NEVER",
          foreignKey: null,
        },
      ],
    },
    {
      schema: "public",
      name: "loans",
      columns: [
        {
          name: "id",
          action: "KEEP",
          identity: "YES",
          generated: "NEVER",
          foreignKey: null,
        },
        {
          name: "book_id",
          action: "KEEP",
          identity: "NO",
          generated: "NEVER",
          foreignKey: { schema: "public", table: "books", column: "id" },
        },
        {
          name: "reader_label",
          action: "REPLACE",
          identity: "NO",
          generated: "NEVER",
          foreignKey: null,
          recipe: { kind: "constant", value: "Anonymous reader" },
        },
      ],
    },
  ],
};

test("source review reports only approved columns and leaves new fields outside the export", () => {
  const schema: SchemaColumn[] = [
    ...columns,
    {
      schema_name: "public",
      table_name: "loans",
      column_name: "private_note",
      data_type: "text",
      identity: "NO",
      generated: "NEVER",
    },
  ];
  const result = verifyReviewedSchema(schema, foreignKeys, source, privacy);
  assert.equal(result.approvedColumns.length, 4);
  assert.deepEqual(result.notExported, ["public.loans.private_note"]);
});

test("source review refuses draft, missing, and incomplete privacy decisions", () => {
  assert.throws(
    () =>
      verifyReviewedSchema(columns, foreignKeys, source, {
        ...privacy,
        draft: true,
      }),
    /reviewed before copying/u,
  );
  const missing = structuredClone(privacy);
  missing.tables[1]!.columns.pop();
  assert.throws(
    () => verifyReviewedSchema(columns, foreignKeys, source, missing),
    /Exactly one privacy decision/u,
  );
  const undecided = structuredClone(privacy);
  undecided.tables[1]!.columns[2]!.action = "REVIEW REQUIRED";
  assert.throws(
    () => verifyReviewedSchema(columns, foreignKeys, source, undecided),
    /Unreviewed privacy action/u,
  );
  const incomplete = structuredClone(privacy);
  delete incomplete.tables[1]!.columns[2]!.recipe;
  assert.throws(
    () => verifyReviewedSchema(columns, foreignKeys, source, incomplete),
    /Required privacy recipe/u,
  );
});

test("source review refuses incorrect identity and foreign-key classifications", () => {
  const identity = structuredClone(privacy);
  identity.tables[0]!.columns[0]!.identity = "NO";
  assert.throws(
    () => verifyReviewedSchema(columns, foreignKeys, source, identity),
    /Identity decision differs/u,
  );
  const fk = structuredClone(foreignKeys);
  fk[0]!.referenced_column = "wrong_column";
  assert.throws(
    () => verifyReviewedSchema(columns, fk, source, privacy),
    /Foreign-key decision differs/u,
  );
  const unknown = structuredClone(source);
  unknown.relations[0]!.columns.push("unknown");
  assert.throws(
    () => verifyReviewedSchema(columns, foreignKeys, unknown, privacy),
    /Approved column does not exist/u,
  );
});

test("source handoff assessment records the observed gap without certifying a new menu entry", () => {
  const existing = assessSourceHandoff(
    "  › 1. Prepare the script\n    2. Exit\nSanitized NDJSON records (required):\nMigration ledger (required):",
  );
  assert.equal(existing.status, "gap-observed");
  assert.equal(existing.sourceEntryObserved, false);
  const future = assessSourceHandoff(
    "  › 1. Prepare source database\n    2. Exit",
  );
  assert.equal(future.sourceEntryObserved, true);
  assert.equal(future.status, "needs-focused-verification");
});

test("sensitive marker inspection detects leaked artifact bytes and does not follow external links", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "lab-canary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = resolve(directory, "artifacts");
  await mkdir(artifacts);
  await writeFile(
    resolve(artifacts, "records.ndjson"),
    '{"reader_label":"Anonymous reader"}\n',
  );
  await writeFile(resolve(directory, "outside"), "PRIVATE_CANARY");
  await symlink(resolve(directory, "outside"), resolve(artifacts, "external"));
  assert.equal(await assertCanaryAbsent(artifacts, "PRIVATE_CANARY"), 1);
  await writeFile(
    resolve(artifacts, "records.ndjson"),
    '{"reader_label":"PRIVATE_CANARY"}\n',
  );
  await assert.rejects(
    assertCanaryAbsent(artifacts, "PRIVATE_CANARY"),
    /Sensitive source marker persisted/u,
  );
});

test("recoverable review failures remain a guidance gap when labeled internal failures", () => {
  const current = assessReviewDiagnostics([
    {
      code: "INTERNAL_FAILURE",
      message: "Review the privacy draft",
      suggestions: ["Run doctor"],
    },
  ]);
  assert.equal(current.status, "gap-observed");
  assert.equal(current.genericInternalFailuresForUserDecisions, 1);
  const revised = assessReviewDiagnostics([
    {
      code: "REVIEW_REQUIRED",
      message: "Review the privacy draft",
      suggestions: ["Complete privacy choices"],
    },
  ]);
  assert.equal(revised.status, "needs-focused-verification");
});
