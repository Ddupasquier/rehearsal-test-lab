import assert from "node:assert/strict";
import { inspectArtifact } from "./candidate/artifact.mts";
import {
  assertUpgradeVersions,
  snapshotUpgradeState,
  assertUpgradeState,
  assertSupportedPreviousRelease,
} from "./candidate/upgrade.mts";
import { acquireHeavyLease } from "./candidate/isolation.mts";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createCandidateConfiguration } from "./candidate/application-config.mts";
import { createDockerSentinel } from "./candidate/docker-sentinel.mts";
import {
  compareInstalledPackage,
  parseJsonOutput,
  requireRegularFile,
  runCommand,
  sha256File,
} from "./candidate/process.mts";
import { createReporter } from "./candidate/report.mts";
import { exerciseShapedBaseline } from "./candidate/shape.mts";
import {
  exerciseForegroundIdle,
  supportsForegroundIdle,
} from "./candidate/idle.mts";
import type { Artifact, TeardownResult } from "./candidate/report.mts";
import type { CommandResult } from "./candidate/process.mts";
import {
  errorMessage,
  requireArray,
  requireNumber,
  requireObject,
  requireString,
} from "./shared/validation.mts";

type Target = "postgresql" | "supabase";
type CandidateConfiguration = Awaited<
  ReturnType<typeof createCandidateConfiguration>
>;

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
const reportDirectory =
  process.env.LAB_REPORT_DIRECTORY ??
  resolve(root, "test-results/candidate-acceptance", runId);
const { runStage, writeReport } = createReporter({
  artifactPath: tarball,
  reportDirectory,
});

const projects = {
  postgresql: resolve(root, "projects/postgresql"),
  supabase: resolve(root, "projects/supabase"),
};
const candidateConfigurations = new Map<string, CandidateConfiguration>();
const temporaryMigrationPaths = new Set<string>();
const temporaryIdlePaths = new Set<string>();
const previousPath = process.env.LAB_PREVIOUS_ARTIFACT || undefined;
let previous: Awaited<ReturnType<typeof inspectArtifact>> | undefined;
const baseStages = [
  "Inspect exact artifact",
  "Verify independent new-user adoption and onboarding",
  "Install exact artifact in both consumers",
  "Prepare PostgreSQL source",
  "Refresh PostgreSQL baseline",
  "Create unrelated Docker sentinel",
  "Exercise PostgreSQL target and application",
  "Clean PostgreSQL runtime safely",
  "Prepare Supabase source",
  "Refresh Supabase baseline",
  "Connect a copied account through the guided flow",
  "Exercise Supabase target and application",
  "Clean Supabase runtime safely",
  "Prove unrelated Docker resources survived",
  "Verify numeric identity correspondence",
] as const;
const plannedStages: string[] = baseStages.flatMap((name, index) =>
  previousPath && [6, 11].includes(index)
    ? [
        name,
        `Upgrade ${index === 6 ? "PostgreSQL" : "Supabase"} consumer and verify preserved state`,
      ]
    : [name],
);
const shapeStages = {
  postgresql: "Verify bounded PostgreSQL source shape and rollback",
  supabase: "Verify bounded Supabase source shape and rollback",
} as const;
let supportsShape = false;
let supportsConfigurationReview = false;
const idleStage =
  "Verify real foreground idle shutdown and preserved PostgreSQL sandbox";

let artifact: Artifact = {
  sha256: artifactSha256,
  bytes: (await stat(tarball)).size,
};
let sentinel: ReturnType<typeof createDockerSentinel> | undefined;
let extractedDirectory: string | undefined;
let failure: unknown;
const teardown: TeardownResult[] = [];
let releaseHeavyLease: (() => Promise<void>) | undefined;

const configureCandidate = async (project: string) => {
  const requestedPort =
    process.env[
      project === projects.postgresql
        ? "LAB_POSTGRESQL_APP_PORT"
        : "LAB_SUPABASE_APP_PORT"
    ];
  const configuration = await createCandidateConfiguration(
    project,
    requestedPort ? Number(requestedPort) : undefined,
  );
  candidateConfigurations.set(project, configuration);
  return configuration;
};

const cli = (
  project: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) => {
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

const sourceCli = (target: Target, args: string[]) => {
  const project = projects[target];
  const configuration = candidateConfigurations.get(project);
  return runCommand(
    "node",
    [
      "--import",
      "tsx",
      "scripts/with-local-source.mts",
      ...args,
      ...(configuration ? [`--config=${configuration.relativePath}`] : []),
      "--json",
    ],
    { cwd: project },
  );
};

const json = (result: CommandResult, label: string) => {
  const envelope = parseJsonOutput(result.stdout, label);
  return {
    status: requireString(envelope.status, `${label} status`),
    data: requireObject(envelope.data, `${label} data`),
  };
};

const planDigest = (data: Record<string, unknown>) =>
  requireString(
    requireObject(data.plan, "Confirmation plan").digest,
    "Confirmation digest",
  );

const installCandidate = async (
  project: string,
  extractedPackage: string,
  installPath = tarball,
  expectedVersion = artifact.version,
  runInstallHook = false,
) => {
  await rm(resolve(project, "node_modules/@rehearsal-db/core"), {
    recursive: true,
    force: true,
  });
  runCommand(
    "npm",
    [
      "install",
      ...(runInstallHook ? [] : ["--ignore-scripts"]),
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      installPath,
    ],
    { cwd: project },
  );
  const installed = resolve(project, "node_modules/@rehearsal-db/core");
  const fileCount = await compareInstalledPackage(extractedPackage, installed);
  const metadata = requireObject(
    JSON.parse(await readFile(resolve(installed, "package.json"), "utf8")),
    "Installed package metadata",
  );
  assert.equal(metadata.name, "@rehearsal-db/core");
  assert.equal(metadata.version, expectedVersion);
  return { project, fileCount, version: metadata.version };
};

const ensurePrivacyKey = async (project: string) => {
  const key = resolve(project, ".rehearsal/secrets/privacy.key");
  try {
    await access(key);
    return;
  } catch {
    cli(project, ["privacy", "key", "--write"]);
  }
};

const retireExistingSourceAccess = async (target: Target) => {
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
    `--confirm-source-retirement=${planDigest(preview.data)}`,
  ]);
};

const refreshBaseline = async (target: Target) => {
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
    `--confirm-source-access=${requireString(accessPlan.data.digest, "Source access digest")}`,
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
      `--confirm-source-retirement=${planDigest(retirement.data)}`,
    ]);
    const manifest = requireObject(
      refreshed.data.manifest,
      "Baseline manifest",
    );
    return {
      generationId: requireString(
        refreshed.data.generationId,
        "Baseline generation",
      ),
      rows: requireNumber(manifest.rowCount, "Baseline row count"),
      tables: Object.keys(
        requireObject(manifest.tableCounts, "Baseline table counts"),
      ).length,
    };
  } catch (error) {
    await retireExistingSourceAccess(target).catch(() => undefined);
    throw error;
  }
};

const createCandidateMigration = async (target: Target) => {
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

const exerciseTarget = (
  target: Target,
  independentVerification: { command: string; args: string[]; cwd: string },
) => {
  const project = projects[target];
  const doctor = json(cli(project, ["doctor"]), `${target} doctor`);
  assert.equal(doctor.data.state, "READY");
  cli(project, ["reset"]);
  const candidates = json(cli(project, ["candidates"]), `${target} candidates`);
  assert.equal(candidates.data.candidateCount, 1);
  const candidateList = requireArray(
    candidates.data.candidates,
    "Migration candidates",
  );
  assert.equal(candidateList.length, 1);
  const candidate = requireObject(candidateList[0], "Migration candidate");
  assert.equal(
    candidate.filename,
    "20261005000100_rehearsal_candidate_probe.sql",
  );
  runCommand(independentVerification.command, independentVerification.args, {
    cwd: independentVerification.cwd,
  });
  const run = json(
    cli(project, [
      "run",
      `--confirm-candidates=${requireString(candidates.data.candidateSha256, "Candidate digest")}`,
    ]),
    `${target} run`,
  );
  const verified = json(cli(project, ["verify"]), `${target} verify`);
  assert.equal(run.status, "success");
  assert.equal(verified.status, "success");
  return {
    doctorChecks: requireArray(doctor.data.checks, "Doctor checks").length,
    candidateCount: candidates.data.candidateCount,
    candidateSha256: candidates.data.candidateSha256,
    candidate: requireString(candidate.filename, "Candidate filename"),
    runStatus: run.status,
    verifyStatus: verified.status,
  };
};

const upgradeConsumer = async (
  target: Target,
  verification: { command: string; args: string[]; cwd: string },
) => {
  if (previous) {
    await runStage(
      `Upgrade ${target === "postgresql" ? "PostgreSQL" : "Supabase"} consumer and verify preserved state`,
      async () => {
        const project = projects[target];
        const before = await snapshotUpgradeState(project);
        const installed = await installCandidate(
          project,
          resolve(
            requireString(extractedDirectory, "Candidate package"),
            "package",
          ),
          tarball,
          artifact.version,
          true,
        );
        assertUpgradeState(before, await snapshotUpgradeState(project));
        const existing = json(
          cli(project, ["verify"]),
          `${target} existing runtime after upgrade`,
        );
        assert.equal(existing.status, "success");
        runCommand(verification.command, verification.args, {
          cwd: verification.cwd,
        });
        const after = exerciseTarget(target, verification);
        assertUpgradeState(before, await snapshotUpgradeState(project));
        return {
          fromVersion: previous!.artifact.version!,
          toVersion: artifact.version!,
          preservedFiles: Object.keys(before).length,
          installHookExercised: true,
          existingRuntimeVerified: true,
          installed,
          ...after,
        };
      },
    );
  }
};

const cleanupTarget = (target: Target, requireRuntimeRemoval = true) => {
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
      `--confirm-cleanup=${planDigest(preview.data)}`,
    ]),
    `${target} cleanup`,
  );
  const runtimeRemoved = requireObject(
    applied.data.applied,
    "Cleanup result",
  ).runtimeRemoved;
  assert.equal(typeof runtimeRemoved, "boolean");
  if (requireRuntimeRemoval) assert.equal(runtimeRemoved, true);
  sentinel?.verify();
  return {
    digest: planDigest(preview.data),
    runtimeRemoved,
    unrelatedDockerResourcesPreserved: true,
  };
};

const verifyNumericIdentityCorrespondence = async () => {
  const project = projects.postgresql;
  const probe = resolve(project, ".rehearsal-numeric-identity-probe.mjs");
  const source = `
import assert from "node:assert/strict";
import { createPrivacyEngine } from "@rehearsal-db/core/privacy";

const column = (name, action, recipe) => ({
  name,
  action,
  recipe,
  generated: "NEVER",
  identity: "NO",
  foreignKey: null,
});
const numberValue = {
  action: "DERIVE",
  recipe: {
    kind: "json-union",
    maximumItems: 1,
    maximumDepth: 2,
    maximumBytes: 64,
    variants: { number: { action: "KEEP" } },
  },
};
const dictionary = (namespace = "external:food-id") => ({
  action: "DERIVE",
  recipe: {
    kind: "json-dictionary",
    maximumItems: 4,
    maximumDepth: 2,
    maximumBytes: 256,
    keys: {
      format: "integer",
      action: "PSEUDONYMIZE",
      minimum: -9007199254740991,
      maximum: 9007199254740991,
      recipe: { format: "integer", namespace },
    },
    values: numberValue,
  },
});
const policy = {
  policyVersion: 2,
  migrationCutoff: "20261004000100",
  tables: [{
    name: "foods",
    sourceRows: "STREAM AND SANITIZE",
    columns: [
      column("food_id", "PSEUDONYMIZE", { format: "integer", namespace: "external:food-id" }),
      column("state", "DERIVE", {
        kind: "json-object",
        fields: {
          selectedFoodId: { action: "PSEUDONYMIZE", recipe: { format: "integer", namespace: "external:food-id" } },
          servingGrams: dictionary(),
          servingQuantities: dictionary(),
          unrelatedIds: dictionary("external:other-id"),
        },
      }),
    ],
  }],
};
const sanitize = (source, key = Buffer.alloc(32, 7)) => createPrivacyEngine({ policy, key }).sanitize({
  table: "foods",
  row: {
    food_id: source,
    state: {
      selectedFoodId: source,
      servingGrams: { [String(source)]: 100 },
      servingQuantities: { [String(source)]: 2 },
      unrelatedIds: { [String(source)]: 1 },
    },
  },
}).row;

for (const source of [203, -1700000000123, 0]) {
  const first = sanitize(source);
  const repeated = sanitize(source);
  const destination = String(first.food_id);
  assert.deepEqual(first, repeated);
  assert.equal(first.state.selectedFoodId, first.food_id);
  assert.equal(Object.hasOwn(first.state.servingGrams, destination), true);
  assert.equal(Object.hasOwn(first.state.servingQuantities, destination), true);
  assert.equal(Object.keys(first.state.unrelatedIds).includes(destination), false);
  assert.notEqual(sanitize(source, Buffer.alloc(32, 8)).food_id, first.food_id);
}

for (const invalid of ["+203", "0203", "203.0", "2e3", "-0"]) {
  assert.throws(() => createPrivacyEngine({ policy, key: Buffer.alloc(32, 7) }).sanitize({
    table: "foods",
    row: {
      food_id: 203,
      state: {
        selectedFoodId: 203,
        servingGrams: { [invalid]: 100 },
        servingQuantities: { 203: 2 },
        unrelatedIds: { 203: 1 },
      },
    },
  }), /invalid integer key|outside the reviewed range/u);
}

console.log(JSON.stringify({ status: "passed", identities: 3, invalidKeysRefused: 5 }));
`;
  try {
    await writeFile(probe, source);
    const result = runCommand(process.execPath, [probe], { cwd: project });
    const parsed = parseJsonOutput(
      result.stdout,
      "Numeric identity correspondence",
    );
    assert.equal(parsed.status, "passed");
    return parsed;
  } finally {
    await rm(probe, { force: true });
  }
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
      failures.push(errorMessage(error));
      if (attempt === 2) throw error;
      runCommand("npm", ["run", "supabase:stop"], { cwd: root });
    }
  }
  throw new Error("Supabase startup ended without a result.");
};

try {
  await runStage(baseStages[0], async () => {
    const inspected = await inspectArtifact(tarball);
    extractedDirectory = inspected.directory;
    artifact = inspected.artifact;
    const manifest = requireObject(
      JSON.parse(
        await readFile(
          resolve(inspected.directory, "package/package.json"),
          "utf8",
        ),
      ),
      "Candidate manifest",
    );
    const contracts = manifest.rehearsalContracts
      ? requireObject(manifest.rehearsalContracts, "Candidate contracts")
      : {};
    supportsShape = !previousPath && contracts?.baselineShape === 1;
    supportsConfigurationReview = contracts.configurationReview === 1;
    if (supportsShape)
      plannedStages.push(shapeStages.postgresql, shapeStages.supabase);
    if (previousPath) {
      previous = await inspectArtifact(previousPath);
      assertSupportedPreviousRelease(previous.artifact.version);
      assertUpgradeVersions(previous.artifact.version!, artifact.version!);
    }
    return {
      ...artifact,
      ...(previous
        ? { previousArtifact: { path: previousPath!, ...previous.artifact } }
        : {}),
    };
  });

  await runStage(baseStages[1], async () => {
    const adoptionResult = runCommand(
      "node",
      ["--import", "tsx", "scripts/verify-adoption-worker.mts", tarball],
      {
        cwd: root,
        env: {
          LAB_ADOPTION_REPORT_DIRECTORY: resolve(reportDirectory, "adoption"),
        },
      },
    );
    const adoption = parseJsonOutput(
      adoptionResult.stdout,
      "Independent new-user adoption",
    );
    assert.equal(adoption.status, "passed");
    assert.equal(adoption.artifactSha256, artifactSha256);
    const result = runCommand(
      "node",
      ["--import", "tsx", "scripts/verify-onboarding.mts", tarball],
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
    return { adoption, onboarding };
  });

  await runStage(baseStages[2], async () => {
    const extractedPackage = resolve(
      requireString(extractedDirectory, "Extracted package directory"),
      "package",
    );
    const installed = {
      postgresql: await installCandidate(
        projects.postgresql,
        previous ? resolve(previous.directory, "package") : extractedPackage,
        previousPath ?? tarball,
        previous?.artifact.version ?? artifact.version,
      ),
      supabase: await installCandidate(
        projects.supabase,
        previous ? resolve(previous.directory, "package") : extractedPackage,
        previousPath ?? tarball,
        previous?.artifact.version ?? artifact.version,
      ),
    };
    const applicationPorts = {
      postgresql: (await configureCandidate(projects.postgresql)).port,
      supabase: (await configureCandidate(projects.supabase)).port,
    };
    return { ...installed, applicationPorts };
  });

  await runStage(baseStages[3], async () => {
    runCommand("npm", ["run", "postgresql:start"], { cwd: root });
    const verification = runCommand("npm", ["run", "postgresql:verify"], {
      cwd: root,
    });
    return { verification: verification.stdout.trim() };
  });

  await runStage(baseStages[4], async () => {
    const baseline = await refreshBaseline("postgresql");
    await createCandidateMigration("postgresql");
    return { ...baseline, candidateMigrationCreated: true };
  });
  if (supportsShape)
    await runStage(shapeStages.postgresql, async () =>
      exerciseShapedBaseline({
        target: "postgresql",
        project: projects.postgresql,
        configuration: candidateConfigurations.get(projects.postgresql)!
          .relativePath,
        startSource: () =>
          runCommand("npm", ["run", "postgresql:start"], { cwd: root }),
        stopSource: () =>
          runCommand("npm", ["run", "postgresql:stop"], { cwd: root }),
      }),
    );

  await runStage(baseStages[5], () => {
    sentinel = createDockerSentinel(process.env.LAB_RUN_ID);
    return { resources: sentinel.names };
  });

  await runStage(baseStages[6], async () => {
    runCommand("npm", ["run", "postgresql:stop"], { cwd: root });
    return exerciseTarget("postgresql", {
      command: "npm",
      args: ["run", "verify:target"],
      cwd: projects.postgresql,
    });
  });

  await upgradeConsumer("postgresql", {
    command: "npm",
    args: ["run", "verify:target"],
    cwd: projects.postgresql,
  });

  if (supportsConfigurationReview) {
    const project = projects.postgresql;
    const metadata = json(
      cli(project, ["configuration"]),
      "Foreground idle configuration capability",
    ).data;
    if (supportsForegroundIdle(metadata)) {
      plannedStages.push(idleStage);
      const configuration = candidateConfigurations.get(project)!;
      await runStage(idleStage, () =>
        exerciseForegroundIdle({
          project,
          configuration: configuration.relativePath,
          port: configuration.port,
          runId: requireString(
            process.env.LAB_RUN_ID,
            "Isolated idle run identity",
          ),
          cli: (args) => cli(project, args),
          trackTemporaryFile: (path) => temporaryIdlePaths.add(path),
          recordDiagnostics: async (diagnostic) => {
            const names = {
              "before-owned-stop": "foreground-idle-before-owned-stop.json",
              "after-owned-stop": "foreground-idle-after-owned-stop.json",
            } as const;
            await writeFile(
              resolve(reportDirectory, names[diagnostic.capture]),
              `${JSON.stringify(diagnostic, null, 2)}\n`,
              { mode: 0o600, flag: "wx" },
            );
          },
        }),
      );
    }
  }

  await runStage(baseStages[7], () => cleanupTarget("postgresql"));

  await runStage(baseStages[8], async () => {
    releaseHeavyLease = await acquireHeavyLease();
    const startup = startSupabaseSource();
    runCommand("npm", ["run", "supabase:reset"], { cwd: root });
    runCommand("npm", ["run", "supabase:assets"], { cwd: root });
    const verification = runCommand("npm", ["run", "supabase:verify"], {
      cwd: root,
    });
    return { startup, verification: verification.stdout.trim() };
  });

  await runStage(baseStages[9], async () => {
    const baseline = await refreshBaseline("supabase");
    await createCandidateMigration("supabase");
    return { ...baseline, candidateMigrationCreated: true };
  });
  if (supportsShape)
    await runStage(shapeStages.supabase, async () =>
      exerciseShapedBaseline({
        target: "supabase",
        project: projects.supabase,
        configuration: candidateConfigurations.get(projects.supabase)!
          .relativePath,
        startSource: startSupabaseSource,
        stopSource: () =>
          runCommand("npm", ["run", "supabase:stop"], { cwd: root }),
      }),
    );

  await runStage(baseStages[10], async () => {
    const { exerciseGuidedIdentityConnection } =
      await import("./candidate/guided-identity.mts");
    const configuration = candidateConfigurations.get(projects.supabase);
    if (!configuration)
      throw new Error("Supabase candidate configuration is unavailable.");
    return exerciseGuidedIdentityConnection({
      project: projects.supabase,
      config: configuration.relativePath,
      applicationUrl: `http://127.0.0.1:${configuration.port}`,
    });
  });

  await runStage(baseStages[11], async () => {
    runCommand("npm", ["run", "supabase:stop"], { cwd: root });
    return exerciseTarget("supabase", {
      command: "npm",
      args: ["run", "rehearsal:verify-target"],
      cwd: root,
    });
  });

  await upgradeConsumer("supabase", {
    command: "npm",
    args: ["run", "rehearsal:verify-target"],
    cwd: root,
  });

  await runStage(baseStages[12], () => cleanupTarget("supabase"));
  await runStage(baseStages[13], () => {
    if (!sentinel) throw new Error("Docker sentinel was not created.");
    return sentinel.verify();
  });
  await runStage(baseStages[14], verifyNumericIdentityCorrespondence);
} catch (error) {
  failure = error;
} finally {
  const teardownOperations: [string, () => unknown | Promise<unknown>][] = [
    ...(failure
      ? ([
          [
            "Clean PostgreSQL target after failure",
            () =>
              candidateConfigurations.has(projects.postgresql)
                ? cleanupTarget("postgresql", false)
                : undefined,
          ],
          [
            "Clean Supabase target after failure",
            () =>
              candidateConfigurations.has(projects.supabase)
                ? cleanupTarget("supabase", false)
                : undefined,
          ],
        ] satisfies [string, () => unknown | Promise<unknown>][])
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
    ["Release Supabase resource slot", async () => releaseHeavyLease?.()],
    ["Remove Docker sentinel", () => sentinel?.remove()],
    [
      "Remove temporary foreground idle fixture",
      async () => {
        await Promise.all(
          [...temporaryIdlePaths].map((path) => rm(path, { force: true })),
        );
      },
    ],
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
      "Remove extracted previous artifact",
      () =>
        previous && rm(previous.directory, { recursive: true, force: true }),
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
        error: errorMessage(error),
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
  ...(previous
    ? { previousArtifact: { path: previousPath!, ...previous.artifact } }
    : {}),
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
