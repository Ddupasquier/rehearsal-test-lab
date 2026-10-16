import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicProfileInventory,
  readPublicProfileBaseline,
  requireStaleProfileRefusal,
} from "../scripts/candidate/inventory.mts";

const baseline = {
  generationId: "20261016T030000Z-1234567890ab",
  dataSha256: "a".repeat(64),
};
const expected = {
  projectId: "rtl-1234567890-postgresql-rehearsal",
  provider: "postgresql" as const,
  configPath: "/synthetic/rehearsal.config.mjs",
  version: "0.1.0-rc.7",
  databasePort: 55442,
  state: "running" as const,
  presence: "created" as const,
  receipt: "compatible" as const,
  review: "due" as const,
  staleAfterSeconds: 1,
  baseline,
};
function inventory() {
  return {
    schemaVersion: 1,
    command: "resources",
    status: "success",
    data: {
      schemaVersion: 1,
      engine: { state: "running" },
      environments: [
        {
          target: "primary",
          projectId: expected.projectId,
          provider: String(expected.provider),
          configPath: expected.configPath,
          state: "running",
          retention: "persistent",
          containerCount: 1,
          runningContainerCount: 1,
          volumeCount: 1,
          createdAt: "2026-10-16T03:00:00Z",
          lastActivityAt: "2026-10-16T03:00:01Z",
          classification: {
            schemaVersion: 1,
            role: "configured-environment",
            dataPersistence: "preserved-on-stop",
            presence: { state: "created", reason: "owned-resources-observed" },
            receipt: {
              state: "compatible",
              reason: "supported-receipt-format-and-provider",
              scope: "format-and-provider-only",
            },
            review: {
              state: "due",
              reason: "observable-cutoff-exceeded",
              staleAfterSeconds: 1,
              lastObservableActivityAt: "2026-10-16T03:00:01Z",
            },
          },
          provenance: {
            schemaVersion: 1,
            inspectorVersion: expected.version,
            verification: "recorded-not-reverified",
            configuredPorts: [
              {
                service: "database",
                host: "127.0.0.1",
                port: expected.databasePort,
              },
            ],
            runtimeReason: null,
            runtime: {
              rehearsalVersion: expected.version,
              versionReason: null,
              baselineGenerationId: baseline.generationId,
              baselineDataSha256: baseline.dataSha256,
              candidateSha256: null,
              migrationReason: "receipt-unavailable",
            },
          },
        },
      ],
    },
  };
}
test("public inventory proves provider, configured path, persistent owned state and recorded provenance", () => {
  const result = assertPublicProfileInventory(inventory(), expected);
  assert.equal(result.state, "running");
  assert.deepEqual(result.baseline, baseline);
  assert.equal(result.configuration, "rehearsal.config.mjs");
  assert.equal(JSON.stringify(result).includes("/synthetic"), false);
  const supabase = inventory();
  supabase.data.environments[0]!.provider = "supabase";
  assertPublicProfileInventory(supabase, { ...expected, provider: "supabase" });
});
test("absent or unavailable inventory keeps missing receipts unknown, never compatible or freshly verified", () => {
  for (const unavailable of [false, true]) {
    const value = inventory(),
      row = value.data.environments[0]!;
    value.data.engine.state = unavailable ? "stopped" : "running";
    row.state = unavailable ? "unavailable" : "absent";
    row.containerCount = row.runningContainerCount = row.volumeCount = 0;
    const unknown = row as unknown as Record<string, unknown>;
    unknown.createdAt = unknown.lastActivityAt = null;
    row.classification.presence = {
      state: unavailable ? "unknown" : "not-created",
      reason: unavailable
        ? "ownership-inspection-unavailable"
        : "no-owned-resources-observed",
    };
    row.classification.receipt = {
      state: "unknown",
      reason: "receipt-unavailable",
      scope: "format-and-provider-only",
    };
    row.classification.review = {
      state: unavailable ? "unknown" : "not-due",
      reason: unavailable ? "ownership-inspection-unavailable" : "not-running",
      staleAfterSeconds: 1,
      lastObservableActivityAt: "",
    };
    const provenance = row.provenance as unknown as Record<string, unknown>;
    provenance.runtime = null;
    provenance.runtimeReason = "receipt-unavailable";
    assertPublicProfileInventory(value, {
      ...expected,
      state: unavailable ? "unavailable" : "absent",
      presence: unavailable ? "unknown" : "not-created",
      receipt: "unknown",
      review: unavailable ? "unknown" : "not-due",
      baseline: null,
    });
    assert.throws(() => assertPublicProfileInventory(value, expected));
  }
});
test("stopped environments remain created and persistent while age review is not due", () => {
  const value = inventory(),
    row = value.data.environments[0]!;
  row.state = "stopped";
  row.runningContainerCount = 0;
  row.classification.review.state = "not-due";
  row.classification.review.reason = "not-running";
  assertPublicProfileInventory(value, {
    ...expected,
    state: "stopped",
    review: "not-due",
  });
});
test("foreign, stale or contradictory metadata cannot certify a valid inventory", () => {
  const corruptions: Array<
    (row: ReturnType<typeof inventory>["data"]["environments"][number]) => void
  > = [
    (row) => {
      row.projectId = "foreign";
    },
    (row) => {
      row.provider = "supabase";
    },
    (row) => {
      row.configPath = "/foreign/rehearsal.config.mjs";
    },
    (row) => {
      row.retention = "disposable";
    },
    (row) => {
      row.classification.role = "temporary-helper";
    },
    (row) => {
      row.classification.receipt.scope = "database-verified";
    },
    (row) => {
      row.classification.review.staleAfterSeconds = 60;
    },
    (row) => {
      row.provenance.runtime.baselineDataSha256 = "b".repeat(64);
    },
    (row) => {
      row.provenance.runtime.rehearsalVersion = "0.1.0-rc.4";
    },
    (row) => {
      row.provenance.configuredPorts[0]!.host = "production.example";
    },
    (row) => {
      row.runningContainerCount = 0;
    },
  ];
  for (const corrupt of corruptions) {
    const value = inventory();
    corrupt(value.data.environments[0]!);
    assert.throws(() => assertPublicProfileInventory(value, expected));
  }
});
test("baseline bindings come only from verified public metadata and refusal must be the intended stale-plan error", () => {
  const value = {
    schemaVersion: 1,
    command: "inspect baseline",
    status: "success",
    data: { ...baseline, rowCount: 100, verification: "checksums_verified" },
  };
  assert.deepEqual(readPublicProfileBaseline(value), baseline);
  assert.throws(() =>
    readPublicProfileBaseline({
      ...value,
      data: { ...value.data, dataSha256: "malformed" },
    }),
  );
  const refused = {
    schemaVersion: 1,
    status: "error",
    error: {
      category: "internal_failure",
      message:
        "The exact stop-stale confirmation is missing or stale. No environment was stopped; review a fresh preview.",
    },
  };
  assert.equal(requireStaleProfileRefusal(refused).refused, true);
  assert.throws(() =>
    requireStaleProfileRefusal({
      ...refused,
      error: {
        category: "runtime_dependency_failure",
        message: "Docker unavailable",
      },
    }),
  );
  assert.throws(() =>
    requireStaleProfileRefusal({ ...refused, status: "success" }),
  );
});
