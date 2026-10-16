/** Independent assertions over installed public CLI inventory; no private receipt reads. */
import assert from "node:assert/strict";
import { basename } from "node:path";
import {
  requireArray,
  requireObject,
  requireString,
} from "../shared/validation.mts";

const digest = /^[a-f0-9]{64}$/u;
const generation = /^\d{8}T\d{6}Z-[a-f0-9]{12}$/u;
const count = (value: unknown) => {
  assert.equal(typeof value, "number");
  assert.ok(Number.isSafeInteger(value) && Number(value) >= 0);
  return Number(value);
};
const timestamp = (value: unknown) => {
  assert.equal(typeof value, "string");
  assert.ok(Number.isFinite(Date.parse(String(value))));
  return String(value);
};

export function readPublicProfileBaseline(value: unknown) {
  const envelope = requireObject(value, "Baseline envelope");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.command, "inspect baseline");
  assert.equal(envelope.status, "success");
  const baseline = requireObject(envelope.data, "Baseline evidence");
  assert.match(requireString(baseline.generationId, "Generation"), generation);
  assert.match(requireString(baseline.dataSha256, "Baseline checksum"), digest);
  assert.equal(baseline.verification, "checksums_verified");
  assert.equal(baseline.rowCount, 100);
  return {
    generationId: String(baseline.generationId),
    dataSha256: String(baseline.dataSha256),
  };
}

export interface ProfileInventoryExpectation {
  projectId: string;
  provider: "postgresql" | "supabase";
  configPath: string;
  version: string;
  databasePort: number;
  state: "running" | "stopped" | "absent" | "unavailable";
  presence: "created" | "not-created" | "unknown";
  receipt: "compatible" | "unknown";
  review: "due" | "not-due" | "unknown";
  staleAfterSeconds: number;
  baseline: ReturnType<typeof readPublicProfileBaseline> | null;
}

export function assertPublicProfileInventory(
  value: unknown,
  expected: ProfileInventoryExpectation,
) {
  const envelope = requireObject(value, "Inventory envelope");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.status, "success");
  assert.ok(
    envelope.command === "resources" || envelope.command === "environments",
  );
  const inventory = requireObject(envelope.data, "Inventory");
  assert.equal(inventory.schemaVersion, 1);
  const engine = requireObject(inventory.engine, "Inventory engine");
  assert.equal(
    engine.state,
    expected.state === "unavailable" ? "stopped" : "running",
  );
  const entries = requireArray(
    inventory.environments,
    "Configured environments",
  );
  assert.equal(entries.length, 1);
  const entry = requireObject(entries[0], "Configured environment");
  assert.equal(entry.target, "primary");
  assert.equal(entry.projectId, expected.projectId);
  assert.equal(entry.provider, expected.provider);
  assert.equal(entry.configPath, expected.configPath);
  assert.equal(entry.state, expected.state);
  assert.equal(
    entry.retention,
    "persistent",
    "Stopping after a run does not make user data disposable.",
  );
  const containers = count(entry.containerCount),
    running = count(entry.runningContainerCount),
    volumes = count(entry.volumeCount);
  assert.ok(running <= containers);
  if (expected.state === "absent")
    assert.deepEqual([containers, running, volumes], [0, 0, 0]);
  if (expected.state === "running") {
    assert.ok(containers > 0);
    assert.equal(running, containers);
  }
  if (expected.state === "stopped") {
    assert.ok(containers > 0);
    assert.equal(running, 0);
  }
  if (expected.presence === "created") {
    timestamp(entry.createdAt);
    timestamp(entry.lastActivityAt);
    assert.ok(volumes > 0);
  }
  if (expected.presence !== "created") {
    assert.equal(entry.createdAt, null);
    assert.equal(entry.lastActivityAt, null);
  }
  const classification = requireObject(entry.classification, "Classification");
  assert.equal(classification.schemaVersion, 1);
  assert.equal(classification.role, "configured-environment");
  assert.equal(classification.dataPersistence, "preserved-on-stop");
  const presence = requireObject(classification.presence, "Presence");
  assert.equal(presence.state, expected.presence);
  assert.equal(
    presence.reason,
    expected.presence === "created"
      ? "owned-resources-observed"
      : expected.presence === "not-created"
        ? "no-owned-resources-observed"
        : "ownership-inspection-unavailable",
  );
  const receipt = requireObject(
    classification.receipt,
    "Recorded compatibility",
  );
  assert.equal(receipt.state, expected.receipt);
  assert.equal(receipt.scope, "format-and-provider-only");
  assert.equal(
    receipt.reason,
    expected.receipt === "compatible"
      ? "supported-receipt-format-and-provider"
      : "receipt-unavailable",
  );
  const review = requireObject(classification.review, "Age review");
  assert.equal(review.state, expected.review);
  assert.equal(review.staleAfterSeconds, expected.staleAfterSeconds);
  assert.equal(
    review.reason,
    expected.review === "due"
      ? "observable-cutoff-exceeded"
      : expected.review === "not-due"
        ? "not-running"
        : "ownership-inspection-unavailable",
  );
  if (expected.review === "due") timestamp(review.lastObservableActivityAt);
  const provenance = requireObject(entry.provenance, "Recorded provenance");
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.inspectorVersion, expected.version);
  assert.equal(provenance.verification, "recorded-not-reverified");
  const ports = requireArray(provenance.configuredPorts, "Configured ports");
  assert.ok(ports.length > 0 && ports.length <= 4);
  const services = new Set<string>();
  for (const raw of ports) {
    const port = requireObject(raw, "Configured port");
    const service = requireString(port.service, "Configured service");
    assert.ok(["application", "api", "database", "studio"].includes(service));
    assert.equal(services.has(service), false);
    services.add(service);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(String(port.host)));
    assert.ok(
      Number.isSafeInteger(port.port) &&
        Number(port.port) >= 1024 &&
        Number(port.port) <= 65535,
    );
  }
  assert.ok(
    ports.some((raw) => {
      const port = requireObject(raw, "Port");
      return port.service === "database" && port.port === expected.databasePort;
    }),
  );
  let recordedBaseline: ReturnType<typeof readPublicProfileBaseline> | null =
    null;
  if (expected.baseline) {
    assert.equal(provenance.runtimeReason, null);
    const runtime = requireObject(provenance.runtime, "Runtime provenance");
    assert.equal(runtime.rehearsalVersion, expected.version);
    assert.equal(runtime.versionReason, null);
    assert.equal(runtime.baselineGenerationId, expected.baseline.generationId);
    assert.equal(runtime.baselineDataSha256, expected.baseline.dataSha256);
    if (runtime.candidateSha256 === null)
      assert.equal(runtime.migrationReason, "receipt-unavailable");
    else {
      assert.match(
        requireString(runtime.candidateSha256, "Migration digest"),
        digest,
      );
      assert.equal(runtime.migrationReason, null);
    }
    recordedBaseline = expected.baseline;
  } else {
    assert.equal(provenance.runtime, null);
    assert.equal(provenance.runtimeReason, "receipt-unavailable");
  }
  return {
    target: "primary",
    provider: expected.provider,
    configuration: basename(expected.configPath),
    state: expected.state,
    presence: expected.presence,
    receipt: expected.receipt,
    review: expected.review,
    retention: "persistent",
    dataPersistence: "preserved-on-stop",
    staleAfterSeconds: expected.staleAfterSeconds,
    containers,
    running,
    volumes,
    baseline: recordedBaseline,
    provenanceScope:
      "recorded-not-reverified; format/provider only; configured ports are not listener evidence",
  };
}

export function requireStaleProfileRefusal(value: unknown) {
  const envelope = requireObject(value, "Refused stop envelope");
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.status, "error");
  const error = requireObject(envelope.error, "Stop refusal");
  assert.equal(error.category, "internal_failure");
  assert.equal(
    error.message,
    "The exact stop-stale confirmation is missing or stale. No environment was stopped; review a fresh preview.",
  );
  return { refused: true, reason: "exact-confirmation-stale" };
}
