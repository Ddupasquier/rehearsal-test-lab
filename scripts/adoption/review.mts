import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireObject } from "../shared/validation.mts";

// Automates the explicit review a developer performs AFTER public init/setup.
// These declarations never ship inside the ordinary application template.
export async function reviewGeneratedSetup(
  project: string,
  basePort: number,
  projectId: string,
) {
  const generated = requireObject(
    (await import(pathToFileURL(resolve(project, "rehearsal.config.mjs")).href))
      .default,
    "Generated configuration",
  );
  const application = requireObject(
    generated.application,
    "Discovered application",
  );
  const runtime = requireObject(generated.runtime, "Discovered runtime");
  assert.equal(
    application.startCommand,
    "npm run dev",
    "Setup must discover the app's ordinary development command",
  );
  assert.ok(
    ["npm run test", "npm test"].includes(String(application.proofCommand)),
    "Setup must discover the app's ordinary test command",
  );
  assert.equal(
    requireObject(generated.postgresql, "Discovered migrations")
      .migrationDirectory,
    "database/migrations",
    "Setup must discover the app's migration directory",
  );
  if (runtime.target !== "postgresql")
    throw new Error(
      "The ordinary PostgreSQL app was not discovered correctly.",
    );
  const url = `http://127.0.0.1:${basePort + 2}`;
  const config = {
    ...generated,
    project: { name: projectId },
    postgresql: {
      ...requireObject(generated.postgresql, "PostgreSQL settings"),
      migrationDirectory: "database/migrations",
      image: "postgres:17-alpine",
    },
    baseline: {
      ...requireObject(generated.baseline, "Baseline settings"),
      sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
    },
    preparation: {
      sourcePolicy: "infrastructure/rehearsal/source-access-policy.json",
      privacyKey: ".rehearsal/secrets/privacy.key",
      batchRows: 100,
      maximumRows: 100,
      maximumBytes: 1048576,
      diskHeadroomBytes: 67108864,
    },
    application: {
      ...application,
      startCommand: `npm run dev -- --port=${basePort + 2}`,
      proofCommand: `npm test -- --url=${url}`,
      environmentVariables: { DATABASE_URL: "primary:DATABASE_URL" },
      readiness: {
        url: `${url}/health`,
        expectedStatus: 200,
        timeoutSeconds: 30,
      },
    },
    runtime: {
      ...runtime,
      projectId,
      databasePort: basePort + 1,
      applicationUrl: url,
    },
    containerRuntime: { autoStartColima: false },
  };
  await writeFile(
    resolve(project, "rehearsal.config.mjs"),
    `import { defineRehearsalConfig } from "@rehearsal-db/core";\nexport default defineRehearsalConfig(${JSON.stringify(config, null, 2)});\n`,
  );
  const directory = resolve(project, "infrastructure/rehearsal");
  await mkdir(directory, { recursive: true });
  const fingerprint = createHash("sha256")
    .update(
      `${JSON.stringify({ protocol: "postgresql", hostname: "127.0.0.1", port: String(basePort), database: "library" }, null, "\t")}\n`,
    )
    .digest("hex");
  const source = {
    accessVersion: 1,
    targetFingerprint: fingerprint,
    administratorEnvironmentVariable: "REHEARSAL_SOURCE_ADMIN_URL",
    reader: {
      mode: "managed",
      role: "library_reader",
      ownerRole: "library_reader_owner",
      credentialFile: ".rehearsal/secrets/source-reader.env",
      validForMinutes: 30,
    },
    exportSchema: "library_export",
    migrationLedger: {
      schema: "app_migrations",
      table: "schema_migrations",
      versionColumn: "version",
      nameColumn: "name",
      statementsColumn: "statements",
    },
    relations: [
      {
        source: { schema: "public", table: "books" },
        view: "books",
        targetSchema: "public",
        targetTable: "books",
        columns: ["id", "title", "copies"],
        orderBy: ["id"],
        rowScope: { kind: "approved-public" },
      },
      {
        source: { schema: "public", table: "loans" },
        view: "loans",
        targetSchema: "public",
        targetTable: "loans",
        columns: ["id", "book_id", "reader_label", "returned_at"],
        orderBy: ["id"],
        rowScope: { kind: "approved-public" },
      },
    ],
    assets: [],
  };
  const column = (
    name: string,
    identity = "NO",
    foreignKey: null | { schema: string; table: string; column: string } = null,
  ) => ({ name, action: "KEEP", generated: "NEVER", identity, foreignKey });
  const privacy = {
    policyVersion: 2,
    migrationCutoff: "20260101000100",
    tables: [
      {
        schema: "public",
        name: "books",
        sourceRows: "STREAM AND SANITIZE",
        columns: [column("id", "YES"), column("title"), column("copies")],
      },
      {
        schema: "public",
        name: "loans",
        sourceRows: "STREAM AND SANITIZE",
        columns: [
          column("id", "YES"),
          column("book_id", "NO", {
            schema: "public",
            table: "books",
            column: "id",
          }),
          {
            ...column("reader_label"),
            action: "REPLACE",
            recipe: { kind: "constant", value: "Anonymous reader" },
          },
          column("returned_at"),
        ],
      },
    ],
  };
  await writeFile(
    resolve(directory, "source-access-policy.json"),
    `${JSON.stringify(source, null, 2)}\n`,
  );
  await writeFile(
    resolve(directory, "sanitization-policy.json"),
    `${JSON.stringify(privacy, null, 2)}\n`,
  );
  const review = {
    publicEntryPoints: ["init", "setup preview", "setup --write", "doctor"],
    applicationCommands: {
      discoveredStart: application.startCommand,
      discoveredProof: application.proofCommand,
      reviewedStart: config.application.startCommand,
      reviewedProof: config.application.proofCommand,
    },
    decisions: [
      "Use dedicated local ports and a disposable target",
      "Declare the app's ordinary migration ledger",
      "Approve only these synthetic fixture tables for export",
      "Replace reader labels while retaining catalog and loan relationships",
    ],
    limitations:
      "Automated public CLI adoption; does not simulate a human interactive wizard or hosted production data.",
  };
  return review;
}
