/** Explicit exact-artifact runner; never contacts a real container engine. */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runEngineOwnershipAcceptance } from "./candidate/engine-ownership.mts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(
    "Usage: node --import tsx scripts/verify-engine-ownership.mts /absolute/path/to/candidate.tgz\nTests installed public CLI engine decisions with strict simulated executables; never starts/stops a real engine.",
  );
} else {
  if (args.length !== 1 || args[0]!.startsWith("-"))
    throw new Error(
      "Select exactly one package tarball; use --help for usage.",
    );
  if (process.platform === "win32")
    throw new Error(
      "Engine-ownership executable simulation is unsupported on Windows; no shell fallback is allowed.",
    );
  const reports = resolve("test-results/engine-ownership");
  await mkdir(reports, { recursive: true });
  const directory = resolve(
    reports,
    `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}`,
  );
  const report = await runEngineOwnershipAcceptance(
    resolve(args[0]!),
    directory,
  );
  console.log(
    `Engine ownership simulation: ${report.status.toUpperCase()}\nReport: ${resolve(directory, "engine-ownership.json")}\nArtifact SHA-256: ${report.artifact?.sha256 ?? "unavailable"}`,
  );
  if (report.status !== "passed") process.exitCode = 1;
}
