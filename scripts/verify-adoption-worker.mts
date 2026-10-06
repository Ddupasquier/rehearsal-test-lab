import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { acquirePortLease, removeWorkspace } from "./candidate/isolation.mts";
import { inspectArtifact } from "./candidate/artifact.mts";
import {
  sha256File,
  runCommand,
  parseJsonOutput,
  CommandError,
} from "./candidate/process.mts";
import { createReporter } from "./candidate/report.mts";
import type { Artifact, TeardownResult } from "./candidate/report.mts";
import {
  requireArray,
  requireObject,
  requireString,
  errorMessage,
} from "./shared/validation.mts";
import { reviewGeneratedSetup } from "./adoption/review.mts";
import {
  exerciseInteractiveSetup,
  exerciseGuidedRun,
  exerciseGuidedRefusal,
} from "./adoption/interactive.mts";
import { rm } from "node:fs/promises";
import {
  verifyReviewedSchema,
  assessSourceHandoff,
  assertCanaryAbsent,
  assessReviewDiagnostics,
} from "./adoption/source-review.mts";
import type {
  SchemaColumn,
  SchemaForeignKey,
} from "./adoption/source-review.mts";

const requested = process.argv[2];
if (requested === "--help" || requested === "-h") {
  console.log(
    "Usage: npm run adoption:verify -- /absolute/path/to/candidate.tgz\nProves a clean library app works before installation, then adopts Rehearsal through public CLI setup and a reviewed rehearsal.",
  );
  process.exit(0);
}
if (!requested || process.argv.length !== 3)
  throw new Error("Pass one exact candidate artifact.");
const tarball = resolve(process.cwd(), requested);
const root = resolve(import.meta.dirname, "..");
const parentRun = process.env.LAB_ADOPTION_BASE_PORT
  ? process.env.LAB_RUN_ID
  : undefined;
const runId = parentRun
  ? `${parentRun}-library`
  : `library-${randomUUID().slice(0, 8)}`;
const directory =
  process.env.LAB_ADOPTION_REPORT_DIRECTORY ||
  resolve(root, "test-results/adoption", `${Date.now()}-${runId}`);
const project = resolve(directory, "application");
const sourceName = `${runId}-source`,
  targetId = `${runId}-target`;
const artifactSha256 = await sha256File(tarball);
const lease = process.env.LAB_ADOPTION_BASE_PORT
  ? {
      base: Number(process.env.LAB_ADOPTION_BASE_PORT),
      path: requireString(
        process.env.LAB_ADOPTION_PARENT_PORT_LEASE,
        "Parent port lease",
      ),
      release: async () => {},
    }
  : await acquirePortLease();
const base = lease.base;
assert.ok(
  Number.isSafeInteger(base) && base >= 1024 && base <= 65533,
  "Invalid adoption port block",
);
const sourceUrl = `postgresql://library:local-synthetic-only@127.0.0.1:${base}/library`;
const appUrl = `http://127.0.0.1:${base + 2}`;
const stages = [
  "Inspect exact package",
  "Prove an ordinary app before adoption",
  "Install and inspect public setup guidance",
  "Exercise real-terminal onboarding, mistakes, and cancellation",
  "Review generated declarations",
  "Prepare and retire scoped source access",
  "Restore and rehearse the ordinary app",
  "Verify privacy and actual migration results",
];
const reporter = createReporter({
  artifactPath: tarball,
  reportDirectory: directory,
});
let artifact: Artifact = { sha256: artifactSha256 };
let inspected: Awaited<ReturnType<typeof inspectArtifact>> | undefined;
let app: ReturnType<typeof spawn> | undefined;
let sourceAttempted = false,
  installed = false,
  configured = false,
  retirementPending = false;
let failure: unknown;
const teardown: TeardownResult[] = [];
const cli = (args: string[], source = false) =>
  runCommand(
    resolve(project, "node_modules/.bin/rehearsal"),
    [...args, "--json"],
    {
      cwd: project,
      env: source ? { REHEARSAL_SOURCE_ADMIN_URL: sourceUrl } : {},
    },
  );
const data = (result: { stdout: string }, label: string) =>
  requireObject(parseJsonOutput(result.stdout, label).data, label);
const digest = (value: Record<string, unknown>) =>
  requireString(
    requireObject(value.plan, "Plan").digest,
    "Confirmation digest",
  );
const sql = async <T extends import("pg").QueryResultRow>(
  url: string,
  query: string,
  values: unknown[] = [],
) => {
  const pg = createRequire(resolve(project, "package.json"))(
    "pg",
  ) as typeof import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(query, values)).rows;
  } finally {
    await client.end();
  }
};
const expectRefusal = (
  operation: () => unknown,
  expected: RegExp,
  label: string,
) => {
  let rejected: unknown;
  try {
    operation();
  } catch (error) {
    rejected = error;
  }
  assert.ok(
    rejected instanceof CommandError,
    `${label} must be refused by the public CLI`,
  );
  const response = parseJsonOutput(rejected.output, label);
  assert.equal(response.status, "error");
  const detail = requireObject(response.error, `${label} diagnostic`);
  assert.match(requireString(detail.message, `${label} message`), expected);
  return {
    code: requireString(detail.code, `${label} code`),
    message: detail.message,
    suggestions: detail.suggestions ?? [],
  };
};
const sourceAccessObjects = async () =>
  (
    await sql<{ roles: number; schemas: number }>(
      sourceUrl,
      `select
  (select count(*)::integer from pg_roles where rolname in ('library_reader','library_reader_owner')) as roles,
  (select count(*)::integer from pg_namespace where nspname='library_export') as schemas`,
    )
  )[0]!;
const stopApp = async () => {
  if (!app || app.exitCode !== null) return;
  const closed = new Promise<void>((done) => app!.once("close", () => done()));
  app.kill("SIGTERM");
  await Promise.race([closed, delay(3000)]);
  if (app.exitCode === null) {
    app.kill("SIGKILL");
    await closed;
  }
};
try {
  await reporter.runStage(stages[0]!, async () => {
    inspected = await inspectArtifact(tarball);
    artifact = inspected.artifact;
    assert.equal(
      artifact.sha256,
      artifactSha256,
      "Candidate changed during inspection",
    );
    await mkdir(directory, { recursive: true });
    await copyFile(tarball, resolve(directory, "candidate.tgz"));
    assert.equal(
      await sha256File(resolve(directory, "candidate.tgz")),
      artifact.sha256,
    );
    return { ...artifact };
  });
  await reporter.runStage(stages[1]!, async () => {
    await cp(resolve(root, "projects/library"), project, {
      recursive: true,
      filter: (path) =>
        !path
          .split(/[\\/]/u)
          .some(
            (part) =>
              ["node_modules", ".rehearsal", ".git"].includes(part) ||
              (part.startsWith(".env") && part !== ".env.example"),
          ),
    });
    const manifest = requireObject(
      JSON.parse(await readFile(resolve(project, "package.json"), "utf8")),
      "Ordinary app manifest",
    );
    assert.equal(
      requireObject(manifest.dependencies, "App dependencies")[
        "@rehearsal-db/core"
      ],
      undefined,
    );
    if (manifest.devDependencies)
      assert.equal(
        requireObject(manifest.devDependencies, "App development dependencies")[
          "@rehearsal-db/core"
        ],
        undefined,
      );
    await assert.rejects(readFile(resolve(project, "rehearsal.config.mjs")), {
      code: "ENOENT",
    });
    runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: project,
    });
    sourceAttempted = true;
    runCommand("docker", [
      "run",
      "--detach",
      "--name",
      sourceName,
      "--label",
      `com.rehearsal-test-lab.adoption=${runId}`,
      ...(parentRun
        ? ["--label", `com.rehearsal-test-lab.parent-run=${parentRun}`]
        : []),
      "--publish",
      `127.0.0.1:${base}:5432`,
      "--env",
      "POSTGRES_DB=library",
      "--env",
      "POSTGRES_USER=library",
      "--env",
      "POSTGRES_PASSWORD=local-synthetic-only",
      "--health-cmd",
      "pg_isready -h 127.0.0.1 -U library -d library",
      "--health-interval",
      "1s",
      "postgres:17-alpine",
    ]);
    const deadline = Date.now() + 30_000;
    while (
      runCommand("docker", [
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        sourceName,
      ]).stdout.trim() !== "healthy"
    ) {
      assert.ok(Date.now() < deadline, "Ordinary database startup timed out");
      await delay(100);
    }
    for (const command of ["migrate", "migrate", "seed"])
      runCommand("npm", ["run", command], {
        cwd: project,
        env: { DATABASE_URL: sourceUrl },
      });
    app = spawn(
      process.execPath,
      ["--import", "tsx", "app/server.mts", `--port=${base + 2}`],
      {
        cwd: project,
        env: { ...process.env, DATABASE_URL: sourceUrl },
        stdio: "ignore",
      },
    );
    const appDeadline = Date.now() + 30_000;
    while (true) {
      assert.equal(app.exitCode, null, "Ordinary app exited before readiness");
      try {
        if ((await fetch(`${appUrl}/health`)).status === 200) break;
      } catch {
        /* wait for listener */
      }
      assert.ok(Date.now() < appDeadline, "Ordinary app readiness timed out");
      await delay(100);
    }
    runCommand("npm", ["test", "--", `--url=${appUrl}`], { cwd: project });
    const checkout = await fetch(`${appUrl}/loans`, {
      method: "POST",
      body: JSON.stringify({
        bookId: 1,
        readerLabel: "Synthetic checkout test",
      }),
    });
    assert.equal(checkout.status, 201);
    const loan = requireObject(await checkout.json(), "New loan");
    assert.ok(Number.isSafeInteger(loan.id));
    assert.equal(
      (
        await sql<{ count: number }>(
          sourceUrl,
          "select count(*)::integer as count from loans where book_id=1 and returned_at is null",
        )
      )[0]?.count,
      1,
    );
    await sql(sourceUrl, `delete from loans where id=${Number(loan.id)}`);
    await stopApp();
    assert.equal(
      (
        await sql<{ count: number }>(
          sourceUrl,
          "select count(*)::integer as count from app_migrations.schema_migrations",
        )
      )[0]?.count,
      1,
    );
    return {
      application: "neighbourhood-library",
      rehearsalInstalled: false,
      ordinaryScripts: ["dev", "test", "migrate", "seed"],
      migrationIdempotent: true,
      successfulCheckout: true,
      publicProofsPassed: true,
    };
  });
  await reporter.runStage(stages[2]!, async () => {
    const beforeScripts = requireObject(
      JSON.parse(await readFile(resolve(project, "package.json"), "utf8")),
      "App manifest",
    ).scripts;
    const ordinaryFiles = [
      "app/server.mts",
      "app/proof.mts",
      "scripts/database.mts",
      "database/seed.sql",
      "database/migrations/20260101000100_create_library.sql",
    ];
    const appHashes = await Promise.all(
      ordinaryFiles.map((file) => sha256File(resolve(project, file))),
    );
    runCommand(
      "npm",
      [
        "install",
        "--save-dev",
        "--no-audit",
        "--no-fund",
        resolve(directory, "candidate.tgz"),
      ],
      { cwd: project },
    );
    installed = true;
    for (const [index, file] of ordinaryFiles.entries())
      assert.equal(
        await sha256File(resolve(project, file)),
        appHashes[index],
        `Installation modified ordinary application source: ${file}`,
      );
    assert.deepEqual(
      requireObject(
        JSON.parse(await readFile(resolve(project, "package.json"), "utf8")),
        "Installed manifest",
      ).scripts,
      beforeScripts,
    );
    const init = data(cli(["init"]), "Init");
    assert.equal(init.mode, "current-template");
    const before = await readFile(
      resolve(project, "rehearsal.config.mjs"),
      "utf8",
    );
    const preview = data(cli(["setup"]), "Setup preview");
    assert.ok(requireArray(preview.files, "Setup review files").length > 0);
    assert.equal(
      await readFile(resolve(project, "rehearsal.config.mjs"), "utf8"),
      before,
    );
    cli(["setup", "--write"]);
    let doctor;
    try {
      doctor = data(cli(["doctor"]), "Doctor");
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      doctor = requireObject(
        parseJsonOutput(error.output, "Doctor guidance").data,
        "Doctor guidance",
      );
    }
    assert.notEqual(
      doctor.state,
      "READY",
      "An unprepared new app must receive setup guidance",
    );
    const guidance = requireArray(doctor.checks, "Doctor guidance checks").map(
      (check) => requireObject(check, "Guidance check"),
    );
    assert.ok(
      guidance.some(
        (check) =>
          check.status === "fail" &&
          typeof check.remediation === "string" &&
          check.remediation.trim().length > 0,
      ),
      "Incomplete setup must explain a next action",
    );
    await writeFile(
      resolve(directory, "initial-guidance.json"),
      `${JSON.stringify({ init, preview, doctor }, null, 2)}\n`,
    );
    return {
      normalInstallation: true,
      appSourceAndScriptsPreserved: true,
      setupPreviewPreservedConfig: true,
      incompleteSetupRecognized: true,
    };
  });
  await reporter.runStage(stages[3]!, () =>
    exerciseInteractiveSetup(project, directory),
  );
  await reporter.runStage(stages[4]!, async () => {
    const columns = await sql<SchemaColumn>(
      sourceUrl,
      `select table_schema as schema_name, table_name, column_name, data_type,
      is_identity as identity, is_generated as generated from information_schema.columns
      where table_schema='public' order by table_name, ordinal_position`,
    );
    const foreignKeys = await sql<SchemaForeignKey>(
      sourceUrl,
      `select ns.nspname as schema_name, t.relname as table_name, a.attname as column_name,
      rn.nspname as referenced_schema, rt.relname as referenced_table, ra.attname as referenced_column
      from pg_constraint fk join pg_class t on t.oid=fk.conrelid join pg_namespace ns on ns.oid=t.relnamespace
      join pg_class rt on rt.oid=fk.confrelid join pg_namespace rn on rn.oid=rt.relnamespace
      cross join lateral unnest(fk.conkey,fk.confkey) as pair(source_id,target_id)
      join pg_attribute a on a.attrelid=t.oid and a.attnum=pair.source_id
      join pg_attribute ra on ra.attrelid=rt.oid and ra.attnum=pair.target_id
      where fk.contype='f' and ns.nspname='public' order by t.relname,a.attname`,
    );
    const review = await reviewGeneratedSetup(project, base, targetId);
    configured = true;
    const source = JSON.parse(
      await readFile(
        resolve(project, "infrastructure/rehearsal/source-access-policy.json"),
        "utf8",
      ),
    );
    const privacy = JSON.parse(
      await readFile(
        resolve(project, "infrastructure/rehearsal/sanitization-policy.json"),
        "utf8",
      ),
    );
    const schemaReview = verifyReviewedSchema(
      columns,
      foreignKeys,
      source,
      privacy,
    );
    const terminal = requireObject(
      JSON.parse(
        await readFile(
          resolve(directory, "terminal-invalid-inputs.json"),
          "utf8",
        ),
      ),
      "Observed wizard",
    );
    const handoff = assessSourceHandoff(
      requireString(terminal.transcript, "Observed transcript"),
    );
    await writeFile(
      resolve(directory, "schema-review-evidence.json"),
      `${JSON.stringify({ columns, foreignKeys, ...schemaReview, containsRowValues: false }, null, 2)}\n`,
    );
    await writeFile(
      resolve(directory, "source-onboarding-assessment.json"),
      `${JSON.stringify(handoff, null, 2)}\n`,
    );
    await writeFile(
      resolve(directory, "developer-review.json"),
      `${JSON.stringify(review, null, 2)}\n`,
    );
    return {
      reviewed: true,
      ...review,
      schemaReview,
      sourceWizardHandoff: handoff.status,
    };
  });
  await reporter.runStage(stages[5]!, async () => {
    cli(["privacy", "key", "--write"]);
    const canary = `LIBRARY_PRIVATE_REVIEW_CANARY_${runId}`;
    await sql(sourceUrl, "update public.loans set reader_label=$1 where id=1", [
      canary,
    ]);
    assert.deepEqual(await sourceAccessObjects(), { roles: 0, schemas: 0 });
    const plan = data(cli(["source", "plan"], true), "Source review");
    const invalidApproval = expectRefusal(
      () =>
        cli(
          ["source", "apply", `--confirm-source-access=${"0".repeat(64)}`],
          true,
        ),
      /confirm|digest/iu,
      "Incorrect source approval",
    );
    assert.deepEqual(await sourceAccessObjects(), { roles: 0, schemas: 0 });
    const sourcePath = resolve(
      project,
      "infrastructure/rehearsal/source-access-policy.json",
    );
    const sourceBytes = await readFile(sourcePath, "utf8");
    const changed = requireObject(JSON.parse(sourceBytes), "Source policy");
    requireObject(changed.reader, "Reader review").validForMinutes = 31;
    let staleApproval;
    try {
      await writeFile(sourcePath, `${JSON.stringify(changed, null, 2)}\n`);
      staleApproval = expectRefusal(
        () =>
          cli(
            [
              "source",
              "apply",
              `--confirm-source-access=${requireString(plan.digest, "Original source digest")}`,
            ],
            true,
          ),
        /confirm|digest/iu,
        "Stale source approval",
      );
      assert.deepEqual(await sourceAccessObjects(), { roles: 0, schemas: 0 });
    } finally {
      await writeFile(sourcePath, sourceBytes);
    }
    const freshPlan = data(
      cli(["source", "plan"], true),
      "Fresh source review",
    );
    retirementPending = true;
    cli(
      [
        "source",
        "apply",
        `--confirm-source-access=${requireString(freshPlan.digest, "Source digest")}`,
      ],
      true,
    );
    const readerPrivileges = (
      await sql<{
        superuser: boolean;
        create_database: boolean;
        create_role: boolean;
        create_public_objects: boolean;
        read_raw_loans: boolean;
        write_books: boolean;
        read_approved_view: boolean;
      }>(
        sourceUrl,
        `select rolsuper as superuser, rolcreatedb as create_database, rolcreaterole as create_role,
      has_schema_privilege(rolname,'public','CREATE') as create_public_objects,
      has_any_column_privilege(rolname,'public.loans','SELECT') as read_raw_loans,
      (has_table_privilege(rolname,'public.books','INSERT') or has_table_privilege(rolname,'public.books','UPDATE')
       or has_table_privilege(rolname,'public.books','DELETE') or has_table_privilege(rolname,'public.books','TRUNCATE')) as write_books,
      has_table_privilege(rolname,'library_export.books','SELECT') as read_approved_view
      from pg_roles where rolname='library_reader'`,
      )
    )[0];
    assert.deepEqual(
      readerPrivileges,
      {
        superuser: false,
        create_database: false,
        create_role: false,
        create_public_objects: false,
        read_raw_loans: false,
        write_books: false,
        read_approved_view: true,
      },
      "Temporary reader privileges must be limited to the reviewed export views",
    );
    const privacyPath = resolve(
      project,
      "infrastructure/rehearsal/sanitization-policy.json",
    );
    const privacyBytes = await readFile(privacyPath, "utf8");
    const draft = requireObject(JSON.parse(privacyBytes), "Privacy decisions");
    draft.draft = true;
    let unreviewedPrivacy;
    try {
      await writeFile(privacyPath, `${JSON.stringify(draft, null, 2)}\n`);
      unreviewedPrivacy = expectRefusal(
        () => cli(["baseline", "refresh"], true),
        /draft|review/iu,
        "Unreviewed privacy export",
      );
      await assert.rejects(
        readFile(resolve(project, ".rehearsal/current/baseline-manifest.json")),
        { code: "ENOENT" },
      );
      await assertCanaryAbsent(resolve(project, ".rehearsal"), canary);
    } finally {
      await writeFile(privacyPath, privacyBytes);
    }
    const baseline = data(cli(["baseline", "refresh"], true), "Baseline");
    assert.equal(
      requireObject(baseline.manifest, "Baseline manifest").rowCount,
      3,
    );
    const checkedArtifactFiles = await assertCanaryAbsent(
      resolve(project, ".rehearsal"),
      canary,
    );
    assert.equal(
      (
        await sql<{ reader_label: string }>(
          sourceUrl,
          "select reader_label from public.loans where id=1",
        )
      )[0]?.reader_label,
      canary,
      "Sanitization must preserve the original source value",
    );
    cli(
      [
        "source",
        "retire",
        `--confirm-source-retirement=${digest(data(cli(["source", "retire"], true), "Retirement review"))}`,
      ],
      true,
    );
    retirementPending = false;
    assert.deepEqual(
      await sourceAccessObjects(),
      { roles: 0, schemas: 0 },
      "Retirement must remove temporary source roles and views",
    );
    await assert.rejects(
      readFile(resolve(project, ".rehearsal/secrets/source-reader.env")),
      { code: "ENOENT" },
    );
    await writeFile(
      resolve(directory, "source-privacy-guardrails.json"),
      `${JSON.stringify({ invalidApproval, staleApproval, unreviewedPrivacy, readerPrivileges, diagnosticAssessment: assessReviewDiagnostics([invalidApproval, staleApproval!, unreviewedPrivacy!]), checkedArtifactFiles, sourceValuePreserved: true, sensitiveMarkerAbsent: true, sourceAccessRetired: true }, null, 2)}\n`,
    );
    runCommand("docker", ["stop", sourceName]);
    return {
      baselineRows: 3,
      sourceAccessRetired: true,
      readerPrivileges,
      diagnosticAssessment: assessReviewDiagnostics([
        invalidApproval,
        staleApproval!,
        unreviewedPrivacy!,
      ]),
      sourceStoppedBeforeTarget: true,
      invalidAndStaleApprovalsRefused: true,
      unreviewedPrivacyExportRefused: true,
      sensitiveMarkerAbsent: true,
      sourceValuePreserved: true,
      temporaryRolesAndCredentialRemoved: true,
    };
  });
  await reporter.runStage(stages[6]!, async () => {
    await writeFile(
      resolve(
        project,
        "database/migrations/20260102000100_index_available_loans.sql",
      ),
      "create index library_active_loans on public.loans(book_id) where returned_at is null;\n",
    );
    assert.equal(data(cli(["doctor"]), "Prepared doctor").state, "READY");
    cli(["reset"]);
    const candidates = data(cli(["candidates"]), "Candidate review");
    assert.equal(candidates.candidateCount, 1);
    const refused = await exerciseGuidedRefusal(project, directory);
    assert.equal(
      data(cli(["candidates"]), "Candidates after refusal").candidateCount,
      1,
    );
    const runtimeEnvironment = await readFile(
      resolve(project, ".rehearsal/runtime.env"),
      "utf8",
    );
    const runtimeUrl = /^DATABASE_URL=(.+)$/mu
      .exec(runtimeEnvironment)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/gu, "");
    assert.ok(runtimeUrl);
    assert.equal(
      (
        await sql<{ count: number }>(
          runtimeUrl,
          "select count(*)::integer as count from pg_indexes where schemaname='public' and indexname='library_active_loans'",
        )
      )[0]?.count,
      0,
      "Declining the wizard must not apply the migration",
    );
    const guidedRun = await exerciseGuidedRun(project, directory);
    assert.equal(
      parseJsonOutput(cli(["verify"]).stdout, "Verification").status,
      "success",
    );
    return {
      ordinaryApplicationReused: true,
      applicationProofsPassed: true,
      confirmedCandidateMigrations: 1,
      ...guidedRun,
      ...refused,
    };
  });
  await reporter.runStage(stages[7]!, async () => {
    // Read the generated environment rather than assuming a runtime password.
    const environment = await readFile(
      resolve(project, ".rehearsal/runtime.env"),
      "utf8",
    );
    const value = /^DATABASE_URL=(.+)$/mu
      .exec(environment)?.[1]
      ?.trim()
      .replace(/^['"]|['"]$/gu, "");
    assert.ok(value, "Generated database URL is missing");
    assert.equal(new URL(value).port, String(base + 1));
    assert.equal(
      (
        await sql<{ reader_label: string }>(
          value,
          "select reader_label from public.loans where id=1",
        )
      )[0]?.reader_label,
      "Anonymous reader",
    );
    assert.equal(
      (
        await sql<{ count: number }>(
          value,
          "select count(*)::integer as count from pg_indexes where schemaname='public' and indexname='library_active_loans'",
        )
      )[0]?.count,
      1,
    );
    return {
      readerLabelReplaced: true,
      candidateIndexActuallyExists: true,
      generatedRuntimeConnectionUsed: true,
    };
  });
} catch (error) {
  failure = error;
} finally {
  const cleanup: [string, () => Promise<unknown> | unknown][] = [
    ["Stop ordinary app", stopApp],
    [
      "Retire pending source access",
      () => {
        if (installed && retirementPending)
          cli(
            [
              "source",
              "retire",
              `--confirm-source-retirement=${digest(data(cli(["source", "retire"], true), "Retirement"))}`,
            ],
            true,
          );
      },
    ],
    [
      "Review and clean disposable target",
      () => {
        if (configured)
          cli([
            "cleanup",
            "--include-runtime",
            "--write",
            `--confirm-cleanup=${digest(data(cli(["cleanup", "--include-runtime"]), "Cleanup review"))}`,
          ]);
      },
    ],
    [
      "Remove only owned adoption resources",
      () => {
        if (!sourceAttempted && !configured) return;
        for (const type of ["container", "volume"] as const) {
          const ids = runCommand("docker", [
            type,
            "ls",
            ...(type === "container" ? ["--all"] : []),
            "--quiet",
            "--filter",
            `label=com.rehearsal-db.project=${targetId}`,
          ])
            .stdout.trim()
            .split(/\s+/u)
            .filter(Boolean);
          for (const id of ids)
            runCommand("docker", [
              type,
              "rm",
              ...(type === "container" ? ["--force"] : []),
              id,
            ]);
        }
        const sources = runCommand("docker", [
          "container",
          "ls",
          "--all",
          "--quiet",
          "--filter",
          `label=com.rehearsal-test-lab.adoption=${runId}`,
        ])
          .stdout.trim()
          .split(/\s+/u)
          .filter(Boolean);
        for (const source of sources)
          runCommand("docker", ["rm", "--force", "--volumes", source]);
      },
    ],
    [
      "Remove inspected package",
      () =>
        inspected && rm(inspected.directory, { recursive: true, force: true }),
    ],
  ];
  for (const [name, operation] of cleanup) {
    try {
      await operation();
      teardown.push({ name, status: "passed" });
    } catch (error) {
      failure ??= error;
      teardown.push({ name, status: "failed", error: errorMessage(error) });
    }
  }
  if (teardown.every((step) => step.status === "passed")) await lease.release();
  if (!failure) {
    try {
      await removeWorkspace(project);
    } catch (error) {
      failure = error;
      teardown.push({
        name: "Remove successful adoption workspace",
        status: "failed",
        error: errorMessage(error),
      });
    }
  }
}
const written = await reporter.writeReport({
  artifact,
  plannedStages: stages,
  teardown,
  failure,
});
console.log(
  JSON.stringify(
    {
      status: written.report.status,
      artifactSha256: artifact.sha256,
      report: written.jsonPath,
      workspaceRetained: Boolean(failure),
      portLease: lease.path,
    },
    null,
    2,
  ),
);
if (failure) process.exitCode = 1;
