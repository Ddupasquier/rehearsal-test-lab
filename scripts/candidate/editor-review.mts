/** Opt-in public configuration/baseline review; no runtime or editor writes. */
import assert from "node:assert/strict";
import { mkdir, readFile, lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256File } from "./process.mts";

type Json = Record<string, unknown>;
const ROOT_CONFIG = "rehearsal.config.mjs";
const NESTED_CONFIG = "infrastructure/rehearsal/rehearsal.config.mjs";
const digest = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const object = (value: unknown): Json => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Review metadata must be an object.",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(value)) <= 65536,
    "Review metadata exceeded its bound.",
  );
  return value as Json;
};

/** Narrow fixture assertions, not a substitute for production editor parsing. */
export function validateEditorConfigurationSample(
  value: unknown,
  path: string,
  sourceSha256: string,
) {
  const data = object(value),
    patch = object(data.patchContract);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.path, path);
  assert.ok(digest(data.sourceSha256) && data.sourceSha256 === sourceSha256);
  assert.equal(patch.schemaVersion, 1);
  assert.equal(patch.maximumBytes, 65536);
  assert.equal(patch.input, "project-local-json-file");
  assert.equal(patch.writesConfiguration, false);
  assert.equal(patch.executesProposedCommands, false);
  assert.equal(patch.concurrentChanges, "refuse");
  assert.ok(
    Array.isArray(data.fields) &&
      data.fields.length > 0 &&
      data.fields.length <= 100,
  );
  const fields = data.fields as Json[];
  assert.equal(new Set(fields.map((field) => field.path)).size, fields.length);
  for (const field of fields) {
    assert.equal(field.provenance, "validated-active-configuration");
    assert.equal(field.confidence, "certain");
    assert.equal(field.reviewRequired, true);
  }
  assert.equal(
    fields.find((field) => field.path === "runtime.displayName")?.kind,
    "text",
  );
  return data;
}
export function validateEditorBaselineSample(
  value: unknown,
  rows: number,
  generations: number,
) {
  const data = object(value);
  assert.equal(data.rowCount, rows);
  assert.equal(data.tableCount, 1);
  assert.equal(data.migrationCount, 1);
  assert.equal(data.verification, "checksums_verified");
  assert.ok(data.formatVersion === 1 || data.formatVersion === 2);
  for (const key of [
    "migrationHistorySha256",
    "sanitizationPolicySha256",
    "dataSha256",
  ])
    assert.ok(digest(data[key]));
  assert.equal(
    data.sourceSchemaSha256,
    null,
    "No source-column schema was observed in this file-only fixture.",
  );
  const privacy = object(data.privacy);
  assert.equal(privacy.sourceRowsExposed, false);
  assert.equal(privacy.sensitiveValuesIncludedInReport, false);
  assert.ok(
    Array.isArray(data.generations) && data.generations.length === generations,
  );
  const copies = (data.generations as unknown[]).map(object);
  assert.equal(
    new Set(copies.map((copy) => copy.generationId)).size,
    copies.length,
  );
  const active = copies.filter((copy) => copy.active === true);
  assert.equal(active.length, 1);
  assert.equal(active[0]!.generationId, data.generationId);
  assert.equal(active[0]!.rowCount, rows);
  for (const copy of copies) {
    assert.equal(copy.tableCount, 1);
    assert.equal(copy.migrationCount, 1);
    assert.equal(copy.storageAssetCount, 0);
  }
  return data;
}

export async function exerciseEditorReview({
  root,
  nested,
  cli,
  createNestedFixture,
  snapshot,
}: {
  root: string;
  nested: string;
  cli: (
    project: string,
    args: string[],
  ) => Promise<{ status: number | null; stdout: string }>;
  createNestedFixture: () => Promise<unknown>;
  snapshot: (project: string) => Promise<[string, string][]>;
}) {
  const checks: { name: string; status: "passed" | "failed" }[] = [];
  const refusals: {
    scenario: string;
    exitCode: number;
    category: string;
    code: string;
  }[] = [];
  const samples: Record<
    "root" | "nested",
    { configuration: Json; baseline: Json; proposalReview: Json } | null
  > = { root: null, nested: null };
  let rootSourceSha256: string | null = null,
    nestedSourceSha256: string | null = null;
  let originalGenerationFilesPreserved = false,
    reviewedFilesUnchanged = false;
  const check = async (name: string, task: () => Promise<void>) => {
    try {
      await task();
      checks.push({ name, status: "passed" });
      console.log(`✓ Editor review: ${name}`);
    } catch (error) {
      checks.push({ name, status: "failed" });
      throw error;
    }
  };
  const successful = async (project: string, args: string[]) => {
    const result = await cli(project, args);
    assert.equal(result.status, 0);
    const envelope = object(JSON.parse(result.stdout));
    assert.equal(envelope.status, "success");
    return object(envelope.data);
  };
  const metadata = new Map<string, Json>(),
    baselines = new Map<string, Json>();
  const rowCanary = "SYNTHETIC_EDITOR_ROW_NOT_TELEMETRY",
    privateCanary = "SYNTHETIC_PRIVATE_ENV_NOT_TELEMETRY";
  try {
    await check("actual retained and nested baselines", async () => {
      const first = validateEditorBaselineSample(
        await successful(root, ["inspect", "baseline"]),
        1,
        1,
      );
      const before = await snapshot(root);
      await mkdir(resolve(root, "editor-review"));
      await writeFile(
        resolve(root, "editor-review/records-2.ndjson"),
        [1, 2]
          .map((id) =>
            JSON.stringify({
              table: "activity_probe",
              row: { id, title: `${rowCanary}-${id}` },
            }),
          )
          .join("\n") + "\n",
        { mode: 0o600, flag: "wx" },
      );
      await successful(root, [
        "baseline",
        "create",
        "--records=editor-review/records-2.ndjson",
        "--ledger=ledger.json",
      ]);
      const active = validateEditorBaselineSample(
        await successful(root, ["inspect", "baseline"]),
        2,
        2,
      );
      const retained = (active.generations as Json[]).find(
        (copy) => copy.generationId === first.generationId,
      );
      assert.equal(retained?.active, false);
      assert.equal(retained?.rowCount, 1);
      const after = new Map(await snapshot(root));
      const originals = before.filter(([file]) =>
        file.startsWith(".rehearsal/generations/"),
      );
      assert.ok(originals.length > 0);
      for (const [file, checksum] of originals)
        assert.equal(after.get(file), checksum);
      originalGenerationFilesPreserved = true;
      baselines.set(root, active);
      await createNestedFixture();
      await successful(nested, [
        "baseline",
        "create",
        "--records=records.ndjson",
        "--ledger=ledger.json",
      ]);
      baselines.set(
        nested,
        validateEditorBaselineSample(
          await successful(nested, ["inspect", "baseline"]),
          2,
          1,
        ),
      );
    });
    await check("root and nested fingerprints", async () => {
      for (const [project, path] of [
        [root, ROOT_CONFIG],
        [nested, NESTED_CONFIG],
      ]) {
        const sha = await sha256File(resolve(project!, path!));
        metadata.set(
          project!,
          validateEditorConfigurationSample(
            await successful(project!, ["configuration"]),
            path!,
            sha,
          ),
        );
      }
      rootSourceSha256 = String(metadata.get(root)!.sourceSha256);
      nestedSourceSha256 = String(metadata.get(nested)!.sourceSha256);
      await assert.rejects(lstat(resolve(nested, ROOT_CONFIG)), {
        code: "ENOENT",
      });
    });
    const changes = [
      { path: "runtime.displayName", value: "Reviewed local sandbox" },
      {
        path: "application.proofCommand",
        value: "docker editor-review-must-not-execute",
      },
    ];
    for (const project of [root, nested]) {
      await mkdir(resolve(project, "editor-review"), { recursive: true });
      await writeFile(
        resolve(project, ".env"),
        `SYNTHETIC_PRIVATE_VALUE=${privateCanary}\n`,
        { mode: 0o600, flag: "wx" },
      );
      await writeFile(
        resolve(project, "editor-review/proposal.json"),
        JSON.stringify({
          schemaVersion: 1,
          sourceSha256: metadata.get(project)!.sourceSha256,
          changes,
        }),
        { mode: 0o600, flag: "wx" },
      );
    }
    await writeFile(
      resolve(root, "editor-review/invalid.json"),
      '{"private":"SYNTHETIC_INVALID_JSON_NOT_TELEMETRY",BROKEN',
      { mode: 0o600, flag: "wx" },
    );
    const rootBefore = await snapshot(root),
      nestedBefore = await snapshot(nested);
    await check("literal review and repeat without writes", async () => {
      for (const [key, project] of [
        ["root", root],
        ["nested", nested],
      ] as const) {
        const review = await successful(project, [
          "configuration",
          "review",
          "--proposal=editor-review/proposal.json",
        ]);
        assert.equal(review.path, metadata.get(project)!.path);
        assert.equal(review.sourceSha256, metadata.get(project)!.sourceSha256);
        assert.equal(review.writesConfiguration, false);
        assert.equal(review.executesProposedCommands, false);
        assert.equal(review.validation, "complete-config-passed");
        assert.equal(
          review.topologyValidation,
          "complete-configured-topology-passed",
        );
        assert.deepEqual(review.topologyTargets, ["primary"]);
        assert.deepEqual(
          (review.changes as Json[]).map((item) => ({
            path: item.path,
            value: item.proposed,
          })),
          changes,
        );
        assert.deepEqual(
          await successful(project, [
            "configuration",
            "review",
            "--proposal=editor-review/proposal.json",
          ]),
          review,
        );
        samples[key] = {
          configuration: metadata.get(project)!,
          baseline: baselines.get(project)!,
          proposalReview: review,
        };
      }
    });
    const refuse = async (scenario: string, args: string[]) => {
      const result = await cli(root, args);
      assert.equal(result.status, 2);
      const response = object(JSON.parse(result.stdout)),
        error = object(response.error);
      assert.equal(response.status, "error");
      assert.equal(error.category, "configuration_invalid");
      assert.equal(error.code, "CONFIGURATION_INVALID");
      assert.equal(
        JSON.stringify(response).includes(
          "SYNTHETIC_INVALID_JSON_NOT_TELEMETRY",
        ),
        false,
      );
      refusals.push({
        scenario,
        exitCode: 2,
        category: "configuration_invalid",
        code: "CONFIGURATION_INVALID",
      });
    };
    await check("stale and invalid proposals refuse", async () => {
      const sourcePath = resolve(root, ROOT_CONFIG),
        original = await readFile(sourcePath, "utf8");
      const changed =
        original + "\n// Deliberate source change after review.\n";
      try {
        await writeFile(sourcePath, changed);
        await refuse("stale-root", [
          "configuration",
          "review",
          "--proposal=editor-review/proposal.json",
        ]);
        assert.equal(await readFile(sourcePath, "utf8"), changed);
      } finally {
        await writeFile(sourcePath, original);
      }
      await refuse("invalid-proposal", [
        "configuration",
        "review",
        "--proposal=editor-review/invalid.json",
      ]);
    });
    await check("reviewed files and private values preserved", async () => {
      assert.deepEqual(await snapshot(root), rootBefore);
      assert.deepEqual(await snapshot(nested), nestedBefore);
      for (const project of [root, nested]) {
        assert.deepEqual(
          await successful(project, ["configuration"]),
          metadata.get(project),
        );
        assert.deepEqual(
          await successful(project, ["inspect", "baseline"]),
          baselines.get(project),
        );
      }
      await assert.rejects(lstat(resolve(nested, ROOT_CONFIG)), {
        code: "ENOENT",
      });
      for (const canary of [
        rowCanary,
        privateCanary,
        "SYNTHETIC_ACTIVITY_ROW_NOT_TELEMETRY",
        "SYNTHETIC_INVALID_JSON_NOT_TELEMETRY",
      ])
        assert.equal(JSON.stringify(samples).includes(canary), false);
      reviewedFilesUnchanged = true;
    });
  } catch {
    /* Caller retains failed workspace; no raw core errors or output enter evidence. */
  }
  return {
    schemaVersion: 1,
    status:
      checks.length === 5 && checks.every((check) => check.status === "passed")
        ? "passed"
        : "failed",
    checks,
    samples,
    refusals,
    preservation: {
      rootSourceSha256,
      nestedSourceSha256,
      originalGenerationFilesPreserved,
      reviewedFilesUnchanged,
    },
    limitations: [
      "A second baseline and nested fixture are deliberate scenario setup; preservation starts after that setup.",
      "Only file-baseline aggregate comparison: source schema, live provider/runtime, database equality and application behavior remain unverified.",
      "Core proposal validation is read-only; no editor source-write transaction, rendered UI, export destination, native cancellation or hosted-provider proof is claimed.",
    ],
  };
}
