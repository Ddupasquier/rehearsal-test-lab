import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CommandError } from "./process.mts";
import { errorMessage } from "../shared/validation.mts";
import type { JsonObject } from "../shared/validation.mts";

export interface Artifact {
  sha256: string;
  bytes?: number;
  name?: string;
  version?: string;
}

export interface TeardownResult {
  name: string;
  status: "passed" | "failed";
  error?: string;
}

interface Stage {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  details?: JsonObject;
  error?: string;
  command?: string;
  exitCode?: number | null;
}

interface ReportInput {
  previousArtifact?: Artifact & { path: string };
  artifact: Artifact;
  plannedStages: readonly string[];
  teardown: TeardownResult[];
  failure: unknown;
}

const duration = (milliseconds: number) =>
  `${(milliseconds / 1000).toFixed(1)}s`;

export function createReporter({
  artifactPath,
  reportDirectory,
}: {
  artifactPath: string;
  reportDirectory: string;
}) {
  const startedAt = new Date();
  const stages: Stage[] = [];

  const runStage = async (
    name: string,
    operation: () => JsonObject | Promise<JsonObject>,
  ) => {
    const started = performance.now();
    process.stdout.write(`\n→ ${name}\n`);
    try {
      const details = (await operation()) ?? {};
      const durationMs = Math.round(performance.now() - started);
      stages.push({ name, status: "passed", durationMs, details });
      process.stdout.write(`✓ ${name} (${duration(durationMs)})\n`);
      return details;
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      stages.push({
        name,
        status: "failed",
        durationMs,
        error: errorMessage(error),
        ...(error instanceof CommandError
          ? { command: error.command, exitCode: error.exitCode }
          : {}),
      });
      process.stdout.write(`✗ ${name} (${duration(durationMs)})\n`);
      throw error;
    }
  };

  const writeReport = async ({
    artifact,
    plannedStages,
    teardown,
    failure,
    previousArtifact,
  }: ReportInput) => {
    const completedNames = new Set(stages.map(({ name }) => name));
    for (const name of plannedStages) {
      if (!completedNames.has(name)) {
        stages.push({ name, status: "skipped", durationMs: 0 });
      }
    }
    const completedAt = new Date();
    const passed =
      !failure &&
      teardown.every(({ status }) => status === "passed") &&
      stages.length === plannedStages.length &&
      stages.every(({ status }) => status === "passed");
    const report = {
      schemaVersion: 1,
      status: passed ? "passed" : "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.valueOf() - startedAt.valueOf(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      measurements: {
        runnerPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        scope:
          "Acceptance runner process only; excludes child processes and Docker runtimes.",
      },
      artifact: { path: artifactPath, ...artifact },
      ...(previousArtifact ? { previousArtifact } : {}),
      stages,
      teardown,
      failure: failure ? errorMessage(failure) : null,
    };

    await mkdir(reportDirectory, { recursive: true });
    const jsonPath = resolve(reportDirectory, "acceptance.json");
    const markdownPath = resolve(reportDirectory, "acceptance.md");
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    const rows = stages
      .map(
        (stage) =>
          `| ${stage.status === "passed" ? "PASS" : stage.status.toUpperCase()} | ${stage.name} | ${duration(stage.durationMs)} |`,
      )
      .join("\n");
    const teardownRows = teardown
      .map(
        ({ name, status }) =>
          `- ${status === "passed" ? "PASS" : "FAIL"}: ${name}`,
      )
      .join("\n");
    const migrationRows = stages
      .filter(({ details }) => details?.candidateCount)
      .map(
        ({ name, details }) =>
          `- ${name.replace("Exercise ", "").replace(" target and application", "")}: \`${details?.candidate}\` (digest \`${details?.candidateSha256}\`)`,
      );
    await writeFile(
      markdownPath,
      [
        "# Rehearsal candidate acceptance",
        "",
        `**Verdict:** ${report.status.toUpperCase()}`,
        `**Package:** ${artifact.name ?? "unknown"}@${artifact.version ?? "unknown"}`,
        `**SHA-256:** \`${artifact.sha256 ?? "unavailable"}\``,
        ...(previousArtifact
          ? [
              `**Upgrade from:** ${previousArtifact.version} (SHA-256 \`${previousArtifact.sha256}\`)`,
            ]
          : []),
        `**Completed:** ${report.completedAt}`,
        "",
        "| Result | Stage | Duration |",
        "| --- | --- | ---: |",
        rows,
        ...(migrationRows.length
          ? ["", "## Migration candidates", "", ...migrationRows]
          : []),
        "",
        "## Teardown",
        "",
        teardownRows || "- No temporary resources were created.",
        ...(failure ? ["", "## Failure", "", errorMessage(failure)] : []),
        "",
      ].join("\n"),
    );
    return { report, jsonPath, markdownPath };
  };

  return { runStage, writeReport };
}
