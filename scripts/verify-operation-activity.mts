/** Exact-artifact activity contract acceptance; no runtime dependencies. */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runOperationActivityAcceptance } from "./candidate/operation-activity.mts";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help")
  console.log(
    "Usage: node --import tsx scripts/verify-operation-activity.mts /absolute/path/to/candidate.tgz [--editor-review]\nDefault: installed operation activity/history without an engine or database.\nOpt-in editor review: deliberately adds a retained two-row baseline and nested configuration fixture, then validates read-only proposals and aggregate comparison evidence.",
  );
else {
  const editorReview = args.length === 2 && args[1] === "--editor-review";
  if (!(args.length === 1 || editorReview) || args[0]!.startsWith("-"))
    throw new Error("Select one exact artifact; use --help for usage.");
  if (process.platform === "win32")
    throw new Error(
      "Deny-only executable activity acceptance is unsupported on Windows; no shell fallback is permitted.",
    );
  const reports = resolve("test-results/operation-activity");
  await mkdir(reports, { recursive: true });
  const directory = resolve(
    reports,
    `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`,
  );
  const report = await runOperationActivityAcceptance(
    resolve(args[0]!),
    directory,
    { editorReview },
  );
  console.log(
    `Operation activity: ${report.status.toUpperCase()}\nReport: ${resolve(directory, "operation-activity.json")}\nArtifact SHA-256: ${report.artifact?.sha256 ?? "unavailable"}`,
  );
  if (report.status !== "passed") process.exitCode = 1;
}
