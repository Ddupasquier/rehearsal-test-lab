/** Optional exact-package shape acceptance inside the existing isolated lab run. */

import assert from "node:assert/strict";
import { readFile, readlink, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CommandError, parseJsonOutput, runCommand } from "./process.mts";
import {
  requireArray,
  requireNumber,
  requireObject,
  requireString,
} from "../shared/validation.mts";

interface ShapeAcceptanceOptions {
  readonly target: "postgresql" | "supabase";
  readonly project: string;
  readonly configuration: string;
  readonly startSource: () => unknown;
  readonly stopSource: () => unknown;
}

const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error("Shape fixture identifier is invalid.");
  return `"${value}"`;
};

export const createLabShapeDeclaration = (privacy: Record<string, unknown>) => {
  const tables = requireArray(privacy.tables, "Shape privacy tables").map(
    (value) => requireObject(value, "Shape privacy table"),
  );
  const included = tables.filter((table) => table.sourceRows !== "EXCLUDE");
  assert.ok(included.some((table) => table.name === "entries"));
  const entries = included.find((table) => table.name === "entries")!;
  const hasReviewedStatus = requireArray(entries.columns, "Entry columns").some(
    (value) => {
      const column = requireObject(value, "Entry column");
      return column.name === "status" && column.action === "KEEP";
    },
  );
  const entryRows = hasReviewedStatus ? 200 : 100;
  const maximumRows = 300;
  return {
    shapeVersion: 1,
    seed: "independent-lab-shape-v1",
    maximumSourceRows: 20_000,
    maximumSourceBytes: 16 * 1024 * 1024,
    maximumRows,
    maximumDepth: 8,
    minimumCohortSize: 5,
    tables: included.map((table) => {
      const name = requireString(table.name, "Shape table name");
      const columns = requireArray(table.columns, "Shape columns").map(
        (value) => requireObject(value, "Shape column"),
      );
      assert.ok(
        columns.some(
          (column) => column.name === "id" && column.action !== "EXCLUDE",
        ),
      );
      return {
        schema: requireString(table.schema, "Shape schema"),
        name,
        key: ["id"],
        maximumRows: name === "entries" ? entryRows : 50,
        rootRows:
          name === "entries"
            ? entryRows
            : name === "audit_events"
              ? 10
              : name === "documents"
                ? 2
                : 0,
      };
    }),
    relationships: included.flatMap((table) =>
      requireArray(table.columns, "Shape columns").flatMap((value) => {
        const column = requireObject(value, "Shape column");
        if (!column.foreignKey || column.action === "EXCLUDE") return [];
        const key = requireObject(column.foreignKey, "Shape foreign key");
        return [
          {
            id: `${String(table.name)}_${String(column.name)}`,
            parent: {
              schema: requireString(key.schema, "Parent schema"),
              table: requireString(key.table, "Parent table"),
              columns: [requireString(key.column, "Parent column")],
            },
            child: {
              schema: requireString(table.schema, "Child schema"),
              table: requireString(table.name, "Child table"),
              columns: [requireString(column.name, "Child column")],
            },
            nullable: false,
            includeChildren: false,
            maximumChildrenPerParent: table.name === "entries" ? entryRows : 50,
            maximumRows,
          },
        ];
      }),
    ),
    distributions: [
      {
        id: "entry_id_ranges",
        schema: "lab_api",
        table: "entries",
        column: "id",
        kind: "number",
        boundaries: [5001],
        required: true,
        tolerance: hasReviewedStatus ? 0.03 : 0,
        minimumBucketRows: 5,
      },
      ...(hasReviewedStatus
        ? [
            {
              id: "entry_state",
              schema: "lab_api",
              table: "entries",
              column: "status",
              kind: "enum",
              values: ["draft", "active", "archived"],
              required: true,
              tolerance: 0.03,
              minimumBucketRows: 5,
              requiredBuckets: ["category-0", "category-1", "category-2"],
            },
          ]
        : []),
    ],
    jointDistributions: hasReviewedStatus
      ? [
          {
            id: "entry_state_ranges",
            schema: "lab_api",
            table: "entries",
            goals: ["entry_state", "entry_id_ranges"],
            required: true,
            tolerance: 0.03,
            minimumBucketRows: 5,
          },
        ]
      : [],
  };
};

export async function exerciseShapedBaseline({
  target,
  project,
  configuration,
  startSource,
  stopSource,
}: ShapeAcceptanceOptions) {
  const configPath = resolve(project, ".rehearsal/shape.config.mjs");
  const policyPath = resolve(project, ".rehearsal/shape-policy.json");
  const restorePath = resolve(project, ".rehearsal/shape-restore.mjs");
  const relativeConfig = ".rehearsal/shape.config.mjs";
  const artifactRoot = resolve(project, ".rehearsal");
  const originalBaselineLink = await readlink(resolve(artifactRoot, "current"));
  const originalBaselineId = originalBaselineLink.split("/").at(-1)!;
  assert.match(originalBaselineId, /^\d{8}T\d{6}Z-[a-f0-9]{12}$/u);
  const baseName = configuration.split("/").at(-1)!;
  assert.match(baseName, /^[a-zA-Z0-9_.-]+\.mjs$/u);
  const privacy = requireObject(
    JSON.parse(
      await readFile(
        resolve(project, "infrastructure/rehearsal/sanitization-policy.json"),
        "utf8",
      ),
    ),
    "Shape privacy policy",
  );
  const declaration = createLabShapeDeclaration(privacy);
  const command = resolve(project, "node_modules/.bin/rehearsal");
  const cli = (args: readonly string[]) =>
    runCommand(command, [...args, `--config=${relativeConfig}`, "--json"], {
      cwd: project,
    });
  const sourceCli = (args: readonly string[]) =>
    runCommand(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/with-local-source.mts",
        ...args,
        `--config=${relativeConfig}`,
        "--json",
      ],
      { cwd: project },
    );
  const data = (result: { stdout: string }) =>
    requireObject(
      parseJsonOutput(result.stdout, "Shape CLI envelope").data,
      "Shape CLI data",
    );
  const retire = () => {
    const preview = data(sourceCli(["source", "retire"]));
    sourceCli([
      "source",
      "retire",
      `--confirm-source-retirement=${requireString(requireObject(preview.plan, "Shape retirement").digest, "Shape retirement digest")}`,
    ]);
  };
  const apply = () => {
    const plan = data(sourceCli(["source", "plan"]));
    sourceCli([
      "source",
      "apply",
      `--confirm-source-access=${requireString(plan.digest, "Shape access digest")}`,
    ]);
  };
  let sourceAccess = false;
  let sourceRunning = true;
  let targetStarted = false;
  let result: Record<string, unknown> | undefined;
  try {
    await writeFile(
      configPath,
      `import base from "./${baseName}";\nexport default { ...base, preparation: { ...base.preparation, shapePolicy: ".rehearsal/shape-policy.json" } };\n`,
      { mode: 0o600 },
    );
    await writeFile(policyPath, `${JSON.stringify(declaration, null, 2)}\n`, {
      mode: 0o600,
    });
    const explanation = data(cli(["explain"]));
    const projectId = requireString(
      requireObject(explanation.environment, "Shape environment").projectId,
      "Shape project ID",
    );
    assert.match(
      projectId,
      /^rtl-[a-f0-9]{10}-(?:postgresql|supabase)-rehearsal$/u,
    );
    const container =
      target === "supabase"
        ? `supabase_db_${projectId}`
        : `${projectId}-postgresql`;
    const sql = (statement: string) => {
      const labels = requireObject(
        JSON.parse(
          runCommand("docker", [
            "container",
            "inspect",
            "--format",
            "{{json .Config.Labels}}",
            container,
          ]).stdout,
        ),
        "Shape target labels",
      );
      if (target === "postgresql")
        assert.equal(labels["com.rehearsal-db.project"], projectId);
      else {
        assert.equal(labels["com.supabase.cli.project"], projectId);
        const workdir = requireString(
          labels["com.supabase.cli.workdir"],
          "Shape Supabase workdir",
        );
        assert.ok(workdir === project || workdir.startsWith(`${project}/`));
      }
      return runCommand("docker", [
        "exec",
        container,
        "psql",
        "--no-align",
        "--tuples-only",
        "--username",
        "postgres",
        "--dbname",
        "postgres",
        "--command",
        statement,
      ]).stdout.trim();
    };
    apply();
    sourceAccess = true;
    const refreshed = data(sourceCli(["baseline", "refresh"]));
    const manifest = requireObject(
      refreshed.manifest,
      "Shaped baseline manifest",
    );
    const expectedCounts = requireObject(
      manifest.tableCounts,
      "Shape table counts",
    );
    assert.equal(
      expectedCounts["lab_api.entries"],
      declaration.tables.find((table) => table.name === "entries")!.rootRows,
    );
    const shape = requireObject(refreshed.shape, "Shape evidence");
    assert.equal(
      requireArray(shape.distributions, "Shape distributions").every(
        (goal) => requireObject(goal, "Shape goal").status === "passed",
      ),
      true,
    );
    assert.ok(
      requireArray(shape.relationships, "Shape relationships").length > 0,
    );
    retire();
    sourceAccess = false;
    stopSource();
    sourceRunning = false;
    cli(["reset"]);
    targetStarted = true;
    const countsSql = Object.keys(expectedCounts)
      .map((name) => {
        const [schema, table] = name.split(".");
        assert.ok(schema && table);
        return `'${schema}.${table}', (select count(*) from ${identifier(schema)}.${identifier(table)})`;
      })
      .join(", ");
    const actualCounts = requireObject(
      JSON.parse(sql(`select json_build_object(${countsSql});`)),
      "Independent shape counts",
    );
    assert.deepEqual(actualCounts, expectedCounts);
    const orphanCounts = declaration.relationships.map((relationship) => {
      const child = relationship.child,
        parent = relationship.parent;
      return `select count(*) from ${identifier(child.schema)}.${identifier(child.table)} c left join ${identifier(parent.schema)}.${identifier(parent.table)} p on c.${identifier(child.columns[0]!)} = p.${identifier(parent.columns[0]!)} where p.${identifier(parent.columns[0]!)} is null`;
    });
    for (const query of orphanCounts) assert.equal(Number(sql(query)), 0);
    assert.equal(
      Number(
        sql(
          "select count(*) from lab_api.accounts where id = '11111111-1111-4111-8111-111111111111';",
        ),
      ),
      0,
    );
    assert.equal(
      Number(
        sql(
          "select count(*) from lab_api.entries where title <> 'Synthetic entry';",
        ),
      ),
      0,
    );
    assert.equal(
      Number(
        sql(
          "select count(*) from lab_api.entries where normalized_title <> lower(title);",
        ),
      ),
      0,
    );
    const baseline = data(cli(["inspect", "baseline"]));
    assert.equal(
      requireObject(baseline.shape, "Inspected shape receipt").evidenceSha256,
      shape.evidenceSha256,
    );
    const shapeLink = await readlink(resolve(artifactRoot, "current"));
    sql(
      "update lab_api.entries set title = 'Safe shape sandbox edit' where id = (select min(id) from lab_api.entries);",
    );
    cli(["stop"]);
    targetStarted = false;
    startSource();
    sourceRunning = true;
    await writeFile(
      policyPath,
      `${JSON.stringify({ ...declaration, minimumCohortSize: 1000 }, null, 2)}\n`,
    );
    apply();
    sourceAccess = true;
    let refusal: Record<string, unknown> | undefined;
    try {
      sourceCli(["baseline", "refresh"]);
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      refusal = parseJsonOutput(error.output, "Required shape refusal");
    }
    assert.equal(refusal?.status, "error");
    assert.match(
      requireString(
        requireObject(refusal.error, "Shape refusal").message,
        "Shape refusal message",
      ),
      /Required shape goal/u,
    );
    assert.equal(await readlink(resolve(artifactRoot, "current")), shapeLink);
    retire();
    sourceAccess = false;
    stopSource();
    sourceRunning = false;
    cli(["start"]);
    targetStarted = true;
    assert.equal(
      Number(
        sql(
          "select count(*) from lab_api.entries where title = 'Safe shape sandbox edit';",
        ),
      ),
      1,
    );
    cli(["verify"]);
    result = {
      target,
      sourceRows: requireArray(
        shape.tables,
        "Shape source tables",
      ).reduce<number>(
        (sum, table) =>
          sum +
          requireNumber(
            requireObject(table, "Shape table").sourceRows,
            "Shape source row count",
          ),
        0,
      ),
      sampledRows: requireNumber(manifest.rowCount, "Shape row count"),
      independentCounts: actualCounts,
      relationshipsVerified: declaration.relationships.length,
      sourceSnapshotBound: true,
      requiredCohortRefused: true,
      oldBaselineAndSandboxEditPreserved: true,
      postSanitizationForeignKeysValid: true,
      generatedColumnValid: true,
      manualProviderConsentTested: false,
    };
  } finally {
    if (sourceAccess) retire();
    if (targetStarted) cli(["stop"]);
    await writeFile(
      restorePath,
      `import { activateBaselineGeneration } from "@rehearsal-db/core/baseline";\nawait activateBaselineGeneration({ artifactRoot: ${JSON.stringify(artifactRoot)}, generationId: ${JSON.stringify(originalBaselineId)} });\n`,
      { mode: 0o600 },
    );
    runCommand(process.execPath, [restorePath], { cwd: project });
    for (const path of [configPath, policyPath, restorePath])
      await rm(path, { force: true });
    if (!sourceRunning) startSource();
  }
  assert.ok(result);
  return result;
}
