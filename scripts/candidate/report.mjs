import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const duration = (milliseconds) => `${(milliseconds / 1000).toFixed(1)}s`;

export function createReporter({ artifactPath, reportDirectory }) {
  const startedAt = new Date();
  const stages = [];

  const runStage = async (name, operation) => {
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
        error: String(error?.message ?? error),
        command: error?.command,
        exitCode: error?.exitCode,
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
  }) => {
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
      artifact: { path: artifactPath, ...artifact },
      stages,
      teardown,
      failure: failure ? String(failure?.message ?? failure) : null,
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
          `- ${name.replace("Exercise ", "").replace(" target and application", "")}: \`${details.candidate}\` (digest \`${details.candidateSha256}\`)`,
      );
    await writeFile(
      markdownPath,
      [
        "# Rehearsal candidate acceptance",
        "",
        `**Verdict:** ${report.status.toUpperCase()}`,
        `**Package:** ${artifact.name ?? "unknown"}@${artifact.version ?? "unknown"}`,
        `**SHA-256:** \`${artifact.sha256 ?? "unavailable"}\``,
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
        ...(failure
          ? ["", "## Failure", "", String(failure?.message ?? failure)]
          : []),
        "",
      ].join("\n"),
    );
    return { report, jsonPath, markdownPath };
  };

  return { runStage, writeReport };
}
