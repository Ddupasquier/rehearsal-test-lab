import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createCandidateConfiguration } from "./candidate/application-config.mjs";
import { createDockerSentinel } from "./candidate/docker-sentinel.mjs";
import {
  compareInstalledPackage,
  parseJsonOutput,
  requireRegularFile,
  runCommand,
  sha256File,
} from "./candidate/process.mjs";
import { createReporter } from "./candidate/report.mjs";

const root = resolve(import.meta.dirname, "..");
const requestedTarball = process.argv[2];

if (requestedTarball === "--help" || requestedTarball === "-h") {
  console.log(`Usage: npm run candidate:verify -- /absolute/path/to/rehearsal-db-core-*.tgz

Runs exact-artifact onboarding, PostgreSQL, Supabase, application-proof, cleanup,
and unrelated-Docker-resource preservation checks. Reports are written below
test-results/candidate-acceptance/.`);
  process.exit(0);
}
if (!requestedTarball || process.argv.length > 3) {
  throw new Error(
    "Pass one exact candidate tarball: npm run candidate:verify -- /absolute/path/to/rehearsal-db-core-*.tgz",
  );
}

const tarball = isAbsolute(requestedTarball)
  ? requestedTarball
  : resolve(process.cwd(), requestedTarball);
await requireRegularFile(tarball, "Candidate artifact");
const artifactSha256 = await sha256File(tarball);
const runId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${artifactSha256.slice(0, 12)}`;
const reportDirectory = resolve(
  root,
  "test-results/candidate-acceptance",
  runId,
);
const { runStage, writeReport } = createReporter({
  artifactPath: tarball,
  reportDirectory,
});

const projects = {
  postgresql: resolve(root, "projects/postgresql"),
  supabase: resolve(root, "projects/supabase"),
};
const candidateConfigurations = new Map();
const temporaryMigrationPaths = new Set();
const plannedStages = [
  "Inspect exact artifact",
  "Verify fresh onboarding",
  "Install exact artifact in both consumers",
  "Prepare PostgreSQL source",
  "Refresh PostgreSQL baseline",
  "Create unrelated Docker sentinel",
  "Exercise PostgreSQL target and application",
  "Clean PostgreSQL runtime safely",
  "Prepare Supabase source",
  "Refresh Supabase baseline",
  "Exercise Supabase target and application",
  "Clean Supabase runtime safely",
  "Prove unrelated Docker resources survived",
];

let artifact = { sha256: artifactSha256 };
let sentinel;
let extractedDirectory;
let failure;
const teardown = [];

const cli = (project, args, environment = {}) => {
  const command = resolve(project, "node_modules/.bin/rehearsal");
  const configuration = candidateConfigurations.get(project);
  return runCommand(
    command,
    [
      ...args,
      ...(configuration ? [`--config=${configuration.relativePath}`] : []),
      "--json",
    ],
    {
      cwd: project,
      env: environment,
    },
  );
};

const sourceCli = (target, args) => {
  const project = projects[target];
  const configuration = candidateConfigurations.get(project);
  return runCommand(
    "node",
    [
      "scripts/with-local-source.mjs",
      ...args,
      ...(configuration ? [`--config=${configuration.relativePath}`] : []),
      "--json",
    ],
    { cwd: project },
  );
};

const json = (result, label) => parseJsonOutput(result.stdout, label);

const installCandidate = async (project, extractedPackage) => {
  await rm(resolve(project, "node_modules/@rehearsal-db/core"), {
    recursive: true,
    force: true,
  });
  runCommand(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: project },
  );
  const installed = resolve(project, "node_modules/@rehearsal-db/core");
  const fileCount = await compareInstalledPackage(extractedPackage, installed);
  const metadata = JSON.parse(
    await readFile(resolve(installed, "package.json"), "utf8"),
  );
  assert.equal(metadata.name, "@rehearsal-db/core");
  assert.equal(metadata.version, artifact.version);
  return { project, fileCount, version: metadata.version };
};

const ensurePrivacyKey = async (project) => {
  const key = resolve(project, ".rehearsal/secrets/privacy.key");
  try {
    await access(key);
    return;
  } catch {
    cli(project, ["privacy", "key", "--write"]);
  }
};

const retireExistingSourceAccess = async (target) => {
  const receipt = resolve(
    projects[target],
    ".rehearsal/source-access-receipt.json",
  );
  try {
    await access(receipt);
  } catch {
    return;
  }
  const preview = json(
    sourceCli(target, ["source", "retire"]),
    `${target} retirement preview`,
  );
  sourceCli(target, [
    "source",
    "retire",
    `--confirm-source-retirement=${preview.data.plan.digest}`,
  ]);
};

const refreshBaseline = async (target) => {
  const project = projects[target];
  await ensurePrivacyKey(project);
  await retireExistingSourceAccess(target);
  const accessPlan = json(
    sourceCli(target, ["source", "plan"]),
    `${target} source plan`,
  );
  sourceCli(target, [
    "source",
    "apply",
    `--confirm-source-access=${accessPlan.data.digest}`,
  ]);
  try {
    const refreshed = json(
      sourceCli(target, ["baseline", "refresh"]),
      `${target} baseline refresh`,
    );
    const retirement = json(
      sourceCli(target, ["source", "retire"]),
      `${target} retirement preview`,
    );
    sourceCli(target, [
      "source",
      "retire",
      `--confirm-source-retirement=${retirement.data.plan.digest}`,
    ]);
    return {
      generationId: refreshed.data.generationId,
      rows: refreshed.data.manifest.rowCount,
      tables: Object.keys(refreshed.data.manifest.tableCounts).length,
    };
  } catch (error) {
    await retireExistingSourceAccess(target).catch(() => undefined);
    throw error;
  }
};

const createCandidateMigration = async (target) => {
  const directory =
    target === "supabase"
      ? resolve(projects[target], "supabase/migrations")
      : resolve(projects[target], "database/migrations");
  const path = resolve(
    directory,
    "20261005000100_rehearsal_candidate_probe.sql",
  );
  await writeFile(
    path,
    `create table lab_api.rehearsal_candidate_probe (\n  id integer primary key,\n  checked_at timestamptz not null default now()\n);\n\ninsert into lab_api.rehearsal_candidate_probe (id) values (1);\n`,
  );
  temporaryMigrationPaths.add(path);
  return path;
};

const exerciseTarget = (target, independentVerification) => {
  const project = projects[target];
  const doctor = json(cli(project, ["doctor"]), `${target} doctor`);
  assert.equal(doctor.data.state, "READY");
  const candidates = json(cli(project, ["candidates"]), `${target} candidates`);
  assert.equal(candidates.data.candidateCount, 1);
  assert.equal(candidates.data.candidates.length, 1);
  assert.equal(
    candidates.data.candidates[0].filename,
    "20261005000100_rehearsal_candidate_probe.sql",
  );
  cli(project, ["reset"]);
  runCommand(independentVerification.command, independentVerification.args, {
    cwd: independentVerification.cwd,
  });
  const run = json(
    cli(project, [
      "run",
      `--confirm-candidates=${candidates.data.candidateSha256}`,
    ]),
    `${target} run`,
  );
  const verified = json(cli(project, ["verify"]), `${target} verify`);
  return {
    doctorChecks: doctor.data.checks.length,
    candidateCount: candidates.data.candidateCount,
    candidateSha256: candidates.data.candidateSha256,
    candidate: candidates.data.candidates[0].filename,
    runStatus: run.status,
    verifyStatus: verified.status,
  };
};

const cleanupTarget = (target) => {
  const project = projects[target];
  const preview = json(
    cli(project, ["cleanup", "--include-runtime"]),
    `${target} cleanup preview`,
  );
  const applied = json(
    cli(project, [
      "cleanup",
      "--include-runtime",
      "--write",
      `--confirm-cleanup=${preview.data.plan.digest}`,
    ]),
    `${target} cleanup`,
  );
  assert.equal(applied.data.applied.runtimeRemoved, true);
  sentinel?.verify();
  return {
    digest: preview.data.plan.digest,
    runtimeRemoved: applied.data.applied.runtimeRemoved,
    unrelatedDockerResourcesPreserved: true,
  };
};

const startSupabaseSource = () => {
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      runCommand("npm", ["run", "supabase:start"], { cwd: root });
      return {
        attempts: attempt,
        recoveredAfterHealthTimeout: attempt > 1,
        previousFailures: failures,
      };
    } catch (error) {
      failures.push(String(error.message));
      if (attempt === 2) throw error;
      runCommand("npm", ["run", "supabase:stop"], { cwd: root });
    }
  }
  throw new Error("Supabase startup ended without a result.");
};

try {
  await runStage(plannedStages[0], async () => {
    extractedDirectory = await mkdtemp(
      resolve(tmpdir(), "rehearsal-candidate-"),
    );
    const entries = runCommand("tar", ["-tzf", tarball])
      .stdout.split("\n")
      .filter(Boolean);
    const verboseEntries = runCommand("tar", ["-tvzf", tarball])
      .stdout.split("\n")
      .filter(Boolean);
    if (
      entries.length === 0 ||
      verboseEntries.length !== entries.length ||
      verboseEntries.some((entry) => !["-", "d"].includes(entry[0])) ||
      entries.some(
        (entry) =>
          !entry.startsWith("package/") ||
          entry.includes("\\") ||
          entry.split("/").includes(".."),
      )
    ) {
      throw new Error("Candidate artifact contains an unsafe archive path.");
    }
    runCommand("tar", ["-xzf", tarball, "-C", extractedDirectory]);
    const extractedPackage = resolve(extractedDirectory, "package");
    const metadata = JSON.parse(
      await readFile(resolve(extractedPackage, "package.json"), "utf8"),
    );
    assert.equal(metadata.name, "@rehearsal-db/core");
    assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    artifact = {
      sha256: artifactSha256,
      name: metadata.name,
      version: metadata.version,
    };
    return artifact;
  });

  await runStage(plannedStages[1], async () => {
    const result = runCommand(
      "node",
      ["scripts/verify-onboarding.mjs", tarball],
      {
        cwd: root,
      },
    );
    const onboarding = parseJsonOutput(
      result.stdout,
      "onboarding verification",
    );
    assert.equal(onboarding.status, "passed");
    assert.equal(onboarding.artifactSha256, artifactSha256);
    return onboarding;
  });

  await runStage(plannedStages[2], async () => {
    const extractedPackage = resolve(extractedDirectory, "package");
    const installed = {
      postgresql: await installCandidate(projects.postgresql, extractedPackage),
      supabase: await installCandidate(projects.supabase, extractedPackage),
    };
    const applicationPorts = {
      postgresql: (await createCandidateConfiguration(projects.postgresql))
        .port,
      supabase: (await createCandidateConfiguration(projects.supabase)).port,
    };
    return { ...installed, applicationPorts };
  });

  await runStage(plannedStages[3], async () => {
    runCommand("npm", ["run", "postgresql:start"], { cwd: root });
    const verification = runCommand("npm", ["run", "postgresql:verify"], {
      cwd: root,
    });
    return { verification: verification.stdout.trim() };
  });

  await runStage(plannedStages[4], async () => {
    const baseline = await refreshBaseline("postgresql");
    await createCandidateMigration("postgresql");
    return { ...baseline, candidateMigrationCreated: true };
  });

  await runStage(plannedStages[5], () => {
    sentinel = createDockerSentinel();
    return { resources: sentinel.names };
  });

  await runStage(plannedStages[6], async () => {
    runCommand("npm", ["run", "postgresql:stop"], { cwd: root });
    return exerciseTarget("postgresql", {
      command: "npm",
      args: ["run", "verify:target"],
      cwd: projects.postgresql,
    });
  });

  await runStage(plannedStages[7], () => cleanupTarget("postgresql"));

  await runStage(plannedStages[8], async () => {
    const startup = startSupabaseSource();
    runCommand("npm", ["run", "supabase:reset"], { cwd: root });
    runCommand("npm", ["run", "supabase:assets"], { cwd: root });
    const verification = runCommand("npm", ["run", "supabase:verify"], {
      cwd: root,
    });
    return { startup, verification: verification.stdout.trim() };
  });

  await runStage(plannedStages[9], async () => {
    const baseline = await refreshBaseline("supabase");
    await createCandidateMigration("supabase");
    return { ...baseline, candidateMigrationCreated: true };
  });

  await runStage(plannedStages[10], async () => {
    runCommand("npm", ["run", "supabase:stop"], { cwd: root });
    return exerciseTarget("supabase", {
      command: "npm",
      args: ["run", "rehearsal:verify-target"],
      cwd: root,
    });
  });

  await runStage(plannedStages[11], () => cleanupTarget("supabase"));
  await runStage(plannedStages[12], () => sentinel.verify());
} catch (error) {
  failure = error;
} finally {
  const teardownOperations = [
    ...(failure
      ? [
          [
            "Clean PostgreSQL target after failure",
            () =>
              candidateConfigurations.has(projects.postgresql)
                ? cleanupTarget("postgresql")
                : undefined,
          ],
          [
            "Clean Supabase target after failure",
            () =>
              candidateConfigurations.has(projects.supabase)
                ? cleanupTarget("supabase")
                : undefined,
          ],
        ]
      : []),
    [
      "Retire PostgreSQL source access",
      () => retireExistingSourceAccess("postgresql"),
    ],
    [
      "Retire Supabase source access",
      () => retireExistingSourceAccess("supabase"),
    ],
    [
      "Stop PostgreSQL source",
      () => runCommand("npm", ["run", "postgresql:stop"], { cwd: root }),
    ],
    [
      "Stop Supabase source",
      () => runCommand("npm", ["run", "supabase:stop"], { cwd: root }),
    ],
    ["Remove Docker sentinel", () => sentinel?.remove()],
    [
      "Remove temporary application configs",
      async () => {
        for (const [project, configuration] of candidateConfigurations) {
          await Promise.all([
            rm(resolve(project, configuration.relativePath), { force: true }),
            rm(configuration.serverPath, { force: true }),
            rm(configuration.proofPath, { force: true }),
          ]);
        }
      },
    ],
    [
      "Remove temporary candidate migrations",
      async () => {
        await Promise.all(
          [...temporaryMigrationPaths].map((path) => rm(path, { force: true })),
        );
      },
    ],
    [
      "Remove extracted artifact",
      () =>
        extractedDirectory &&
        rm(extractedDirectory, { recursive: true, force: true }),
    ],
  ];
  for (const [name, operation] of teardownOperations) {
    try {
      await operation();
      teardown.push({ name, status: "passed" });
    } catch (error) {
      teardown.push({
        name,
        status: "failed",
        error: String(error?.message ?? error),
      });
      failure ??= error;
    }
  }
}

const written = await writeReport({
  artifact,
  plannedStages,
  teardown,
  failure,
});
console.log(`\nAcceptance report: ${written.markdownPath}`);
console.log(`Machine report: ${written.jsonPath}`);
if (written.report.status !== "passed") {
  console.error(`\nCandidate acceptance failed: ${written.report.failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `\nCandidate acceptance passed for ${artifact.name}@${artifact.version}.`,
  );
  console.log(`SHA-256: ${artifact.sha256}`);
}
