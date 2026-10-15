import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { API } from "typescript/unstable/sync";
import {
  createScanner,
  isCallExpression,
  isExportAssignment,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  SyntaxKind,
  type Node,
  type ObjectLiteralExpression,
  type PropertyAssignment,
} from "typescript/unstable/ast";
import { inspectArtifact } from "./candidate/artifact.mts";
import {
  acquirePortLease,
  createWorkspace,
  isolationBindings,
} from "./candidate/isolation.mts";
import {
  compareInstalledPackage,
  runCommand,
  sha256File,
} from "./candidate/process.mts";
import { requireObject } from "./shared/validation.mts";

const labRoot = resolve(import.meta.dirname, "..");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function canonicalDirectory(path: string, label: string) {
  const directory = resolve(path);
  const entry = await lstat(directory);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new Error(
      `${label} must be a regular canonical directory, not a symbolic link.`,
    );
  return directory;
}

async function ensureCanonicalDirectory(path: string, label: string) {
  const destination = resolve(path);
  const parsed = parse(destination);
  let directory = parsed.root;
  for (const component of destination
    .slice(parsed.root.length)
    .split(sep)
    .filter(Boolean)) {
    directory = resolve(directory, component);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    });
    await canonicalDirectory(directory, label);
  }
  return directory;
}

/** Parses the copied fixture only; never imports or evaluates project configuration. */
export function manualConfiguration(source: string) {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024)
    throw new Error("Manual fixture configuration exceeds its 1 MiB limit.");
  const file = "/manual-rehearsal/rehearsal.config.mjs";
  const config = "/manual-rehearsal/tsconfig.json";
  const files = new Map([
    [file, source],
    [
      config,
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          noEmit: true,
          noLib: true,
          noResolve: true,
          types: [],
        },
        files: ["rehearsal.config.mjs"],
      }),
    ],
  ]);
  // The locked TS7 compiler exposes parsing through an owned native API process.
  // Every FS callback is explicit: unknown paths never fall back to the host FS.
  const api = new API({
    fs: {
      readFile: (path) => files.get(path) ?? null,
      fileExists: (path) => files.has(path),
      directoryExists: (path) => path === "/" || path === "/manual-rehearsal",
      getAccessibleEntries: (path) => ({
        files:
          path === "/manual-rehearsal"
            ? ["rehearsal.config.mjs", "tsconfig.json"]
            : [],
        directories: path === "/" ? ["manual-rehearsal"] : [],
      }),
      realpath: (path) => path,
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)?.program;
      const parsed = program?.getSourceFile(file);
      if (!parsed || program?.getSyntacticDiagnostics(file).length)
        throw new Error(
          "Manual fixture configuration must be valid JavaScript.",
        );
      const defaults = parsed.statements.filter(isExportAssignment);
      if (defaults.length !== 1 || defaults[0]!.isExportEquals)
        throw new Error(
          "Manual fixture must have exactly one default configuration object.",
        );
      let expression = defaults[0]!.expression;
      if (isCallExpression(expression)) {
        if (
          !isIdentifier(expression.expression) ||
          expression.expression.text !== "defineRehearsalConfig" ||
          expression.arguments.length !== 1
        )
          throw new Error(
            "Manual fixture supports only a literal or defineRehearsalConfig(literal).",
          );
        expression = expression.arguments[0]!;
      }
      if (!isObjectLiteralExpression(expression))
        throw new Error(
          "Manual fixture configuration must be a literal object.",
        );
      const properties = (object: ObjectLiteralExpression) => {
        const result = new Map<string, PropertyAssignment>();
        for (const property of object.properties) {
          if (
            !isPropertyAssignment(property) ||
            !(
              isIdentifier(property.name) ||
              isStringLiteral(property.name) ||
              isNumericLiteral(property.name)
            )
          )
            throw new Error(
              "Manual fixture objects cannot contain spreads, computed keys or methods.",
            );
          const key = property.name.text;
          if (result.has(key) || key === "__proto__")
            throw new Error(
              "Manual fixture objects must have unambiguous unique keys.",
            );
          result.set(key, property);
        }
        return result;
      };
      const validate = (node: Node, depth = 0): void => {
        if (depth > 64)
          throw new Error("Manual fixture configuration is too deeply nested.");
        if (isObjectLiteralExpression(node)) properties(node);
        node.forEachChild((child) => {
          validate(child, depth + 1);
        });
      };
      validate(expression);
      const edits: { start: number; end: number; text: string }[] = [];
      const newline = source.includes("\r\n") ? "\r\n" : "\n";
      const insert = (
        object: ObjectLiteralExpression,
        additions: readonly string[],
      ) => {
        const close = object.getEnd() - 1;
        const lineStart = source.lastIndexOf("\n", close - 1) + 1;
        const indent = source.slice(lineStart, close);
        const last = object.properties.at(-1);
        // TS7 remote NodeArrays do not consistently expose hasTrailingComma.
        // Scan actual separator tokens, ignoring commas inside comments/trivia.
        let trailingComma = false;
        if (last) {
          const scanner = createScanner(true);
          scanner.setText(source.slice(last.getEnd(), close));
          const token = scanner.scan();
          trailingComma = token === SyntaxKind.CommaToken;
          if (
            (token !== SyntaxKind.EndOfFile && !trailingComma) ||
            (trailingComma && scanner.scan() !== SyntaxKind.EndOfFile)
          )
            throw new Error(
              "Manual fixture has an ambiguous object separator.",
            );
        }
        const comma = last && !trailingComma ? "," : "";
        if (/^[ \t]*$/u.test(indent)) {
          if (comma && last)
            edits.push({
              start: last.getEnd(),
              end: last.getEnd(),
              text: comma,
            });
          edits.push({
            start: lineStart,
            end: lineStart,
            text:
              additions.map((value) => `${indent}  ${value},`).join(newline) +
              newline,
          });
        } else {
          edits.push({
            start: close,
            end: close,
            text: `${comma} ${additions.join(", ")} `,
          });
        }
      };
      const container = properties(expression).get("containerRuntime");
      if (!container) {
        insert(expression, [
          "containerRuntime: { autoStartColima: false, stopOwnedColimaWhenIdle: false }",
        ]);
      } else {
        if (!isObjectLiteralExpression(container.initializer))
          throw new Error(
            "Manual fixture containerRuntime must be a literal object.",
          );
        const engine = properties(container.initializer);
        const missing: string[] = [];
        for (const key of ["autoStartColima", "stopOwnedColimaWhenIdle"]) {
          const field = engine.get(key);
          if (!field) missing.push(`${key}: false`);
          else if (field.initializer.kind === SyntaxKind.TrueKeyword)
            edits.push({
              start: field.initializer.getStart(parsed),
              end: field.initializer.getEnd(),
              text: "false",
            });
          else if (field.initializer.kind !== SyntaxKind.FalseKeyword)
            throw new Error(
              "Manual fixture engine policies must be literal booleans.",
            );
        }
        if (missing.length) insert(container.initializer, missing);
      }
      const transformed = edits
        .sort((left, right) => right.start - left.start)
        .reduce(
          (text, edit) =>
            text.slice(0, edit.start) + edit.text + text.slice(edit.end),
          source,
        );
      if (transformed !== source) {
        files.set(file, transformed);
        const checked = api.updateSnapshot({
          fileChanges: { changed: [file] },
        });
        try {
          const checkedProgram = checked.getProject(config)?.program;
          if (
            !checkedProgram ||
            checkedProgram.getSyntacticDiagnostics(file).length
          )
            throw new Error(
              "Manual fixture transformation produced invalid JavaScript; no configuration was written.",
            );
        } finally {
          checked.dispose();
        }
      }
      return transformed;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

export function manualInstructions(workspace: string, applicationPort: number) {
  return `# Your isolated PostgreSQL session

This copy starts without a baseline, privacy key, dependencies or database. The synthetic
application, schema and reviewed example policies are already supplied by Test Lab.
It does not use BlendCalc, Supabase, Google or production data.
For the complete extension feature checklist, also use [the manual testing guide](docs/manual-postgresql.md).

## 1. Install this copy's tools and the exact candidate

Start your Docker-compatible engine yourself if needed. Rehearsal will not start it.
Then run:

\`\`\`bash
cd ${shellQuote(workspace)}
nvm use 24
npm ci --ignore-scripts --no-audit --no-fund
cd projects/postgresql
npm install --ignore-scripts --no-save --package-lock=false --no-audit --no-fund ../../../candidate.tgz
cd ../..
node --import tsx scripts/manual-postgresql.mts check-install
\`\`\`

The last command must report an exact package match. This local candidate can carry the
same version number as an older published package; its SHA-256 identifies the tested bytes.
These installs intentionally skip install hooks because this fixture already contains its
reviewed config. The separate onboarding gate tests normal installation and config creation.

## 2. Start and check the invented source database

\`\`\`bash
npm run postgresql:start
npm run postgresql:verify
cd projects/postgresql
npx --no-install rehearsal privacy key --write --plain
npm run source:local -- source plan --plain
\`\`\`

Review the source plan. It is restricted to this session's synthetic local database.
Copy its complete confirmation digest into the next command; do not type the placeholder.

\`\`\`bash
npm run source:local -- source apply --confirm-source-access=PASTE_FULL_DIGEST --plain
npm run source:local -- baseline refresh --plain
npm run source:local -- source retire --plain
\`\`\`

The baseline should contain **10,003 rows across three tables**: one account, 10,000
entries and two publication documents. The source has extra control rows on purpose.
Copy the retirement digest from the last preview:

\`\`\`bash
npm run source:local -- source retire --confirm-source-retirement=PASTE_FULL_DIGEST --plain
cd ../..
npm run postgresql:stop
\`\`\`

Retirement removes the temporary reader, not source data. Stopping the source before
restoring the target keeps only one PostgreSQL container running at a time.

## 3. Create the sandbox and run the application proof

\`\`\`bash
cd projects/postgresql
npx --no-install rehearsal doctor --plain
npx --no-install rehearsal run --plain
npx --no-install rehearsal verify --plain
\`\`\`

Require READY and successful application/verification results. No new migration is present
in this clean fixture, so this does not prove applying a new migration.

## 4. Open your persistent manual application

\`\`\`bash
npx --no-install rehearsal open --plain
\`\`\`

Leave that terminal open. Visit **http://127.0.0.1:${applicationPort}/** in your browser.
The read-only lab page shows one account, 10,000 entries and two documents; the same
counts are available as JSON at **http://127.0.0.1:${applicationPort}/summary**. This small
PostgreSQL fixture is an API demonstration, not the BlendCalc UI. The extension can also
open this project: use \"Open Folder\" on this session's \"projects/postgresql\" directory.

Press **Ctrl+C once** to close the app. The database and sandbox changes remain.
Run \"rehearsal open\" again to check ordinary restart. Use \"rehearsal reset\" only when
you deliberately want to replace edits in **this disposable session** with its baseline.

## 5. Try one migration (optional)

With the app closed, create \"database/migrations/20261014000100_manual_title_index.sql\"
in this session's PostgreSQL project. Put this SQL in it:

\`\`\`sql
create index manual_lab_entries_title_idx on lab_api.entries (title);
\`\`\`

Then inspect the exact candidate set:

\`\`\`bash
npx --no-install rehearsal candidates --plain
npx --no-install rehearsal explain --plain
\`\`\`

Expect exactly that one filename. Review the plan and copy the complete candidate digest:

\`\`\`bash
npx --no-install rehearsal run --confirm-candidates=PASTE_FULL_DIGEST --plain
npx --no-install rehearsal verify --plain
\`\`\`

This restores this session's baseline before applying the index, so existing sandbox
edits are replaced. Require one applied candidate and successful proof/verification.
The source database is not migrated. Keep the candidate file with this workspace.

## 6. Finish without deleting data

\`\`\`bash
npx --no-install rehearsal verify --plain
npx --no-install rehearsal stop --plain
cd ../..
npm run postgresql:stop
\`\`\`

This stops both session databases and leaves all data for a later visit. No global engine
stop, prune or volume deletion is needed. Keep this directory and its port lease together;
the lease is intentionally retained while these persistent resources can be restarted.
The owning session paths, artifact hash and resource names are in ../manual-session.json.
For a fully automatic disposable acceptance with cleanup, use the root lab's
\"npm run candidate:verify -- /absolute/path/to/candidate.tgz\" instead.

## If something fails

- Engine unavailable: start your existing engine explicitly, then retry the same step.
- Source counts differ: stop here; do not point this workflow at another database.
- Stale confirmation: preview again and review the new digest; never bypass it.
- Doctor not ready: follow the named failed check before running or opening the sandbox.
- Address already occupied: do not stop an unknown process; prepare a new isolated session.
- App exits or the terminal closes: run \"rehearsal open\" again; do not reset to reopen it.

Do not delete a port lease or this workspace while its resources or application are in use.
No command in this guide alters the original lab's configuration, databases, keys or baselines.
`;
}

export async function prepareManualPostgresql(
  options: {
    root: string;
    artifact: string;
    expectedSha256: string;
    reportRoot?: string;
    leaseRoot?: string;
  },
  copyArtifact: (
    source: string,
    destination: string,
  ) => Promise<void> = copyFile,
) {
  if (!/^[a-f0-9]{64}$/u.test(options.expectedSha256))
    throw new Error(
      "Pass the complete lowercase SHA-256 of the approved candidate.",
    );
  const root = await canonicalDirectory(options.root, "Lab root");
  const artifactPath = resolve(options.artifact);
  if (!(await lstat(artifactPath)).isFile())
    throw new Error("Candidate must be a regular file, not a symlink.");
  if ((await sha256File(artifactPath)) !== options.expectedSha256)
    throw new Error(
      "Candidate SHA-256 does not match; no session was created.",
    );
  const reportRoot = await ensureCanonicalDirectory(
    options.reportRoot ?? resolve(root, "test-results/manual-postgresql"),
    "Manual session output",
  );
  const directory = await mkdtemp(resolve(reportRoot, "session-"));
  const destination = resolve(directory, "candidate.tgz");
  // Only the private copied bytes are inspected. The caller's mutable archive is never extracted.
  await copyArtifact(artifactPath, destination);
  if (!(await lstat(destination)).isFile())
    throw new Error("Private candidate copy must be a regular file.");
  if ((await sha256File(destination)) !== options.expectedSha256)
    throw new Error(
      "Candidate changed during preparation; no ports were leased.",
    );
  await chmod(destination, 0o400);
  const inspected = await inspectArtifact(destination);
  try {
    if (inspected.artifact.sha256 !== options.expectedSha256)
      throw new Error("Private candidate bytes changed during inspection.");
    const workspace = resolve(directory, "workspace");
    const leaseRoot = await ensureCanonicalDirectory(
      options.leaseRoot ??
        resolve(await realpath(tmpdir()), "rehearsal-test-lab-leases"),
      "Port lease output",
    );
    const lease = await acquirePortLease(leaseRoot);
    try {
      const bindings = isolationBindings(lease.base);
      const snapshot = await createWorkspace(root, workspace, bindings);
      // Bound editor package lookup here instead of borrowing the parent Lab install.
      // No template/hooks, staging, commit or remote is created by this empty repository.
      const gitEnvironment = Object.fromEntries(
        Object.keys(process.env)
          .filter((key) => key.startsWith("GIT_"))
          .map((key) => [key, undefined]),
      );
      runCommand(
        "git",
        ["-c", "init.templateDir=", "init", "--quiet", "--template="],
        { cwd: workspace, env: gitEnvironment },
      );
      if (
        runCommand("git", ["rev-parse", "--show-toplevel"], {
          cwd: workspace,
          env: gitEnvironment,
        }).stdout.trim() !== workspace
      )
        throw new Error(
          "Manual workspace could not establish an independent repository boundary.",
        );
      // Existing snapshot rebasing owns all resource names, policy fingerprints and ports.
      // Patch only engine policy in the copied literal so editor review remains editable.
      const project = resolve(workspace, "projects/postgresql");
      const configuration = manualConfiguration(
        await readFile(resolve(project, "rehearsal.config.mjs"), "utf8"),
      );
      await rename(
        resolve(project, "rehearsal.config.mjs"),
        // Preserve provenance without advertising a competing discoverable config.
        resolve(project, "fixture-original.mjs"),
      );
      await writeFile(resolve(project, "rehearsal.config.mjs"), configuration, {
        mode: 0o600,
      });
      await writeFile(
        resolve(workspace, "MANUAL-POSTGRESQL.md"),
        manualInstructions(workspace, bindings.base + 28),
        { mode: 0o600 },
      );
      const session = {
        schemaVersion: 1,
        kind: "manual-postgresql",
        state: "prepared-not-executed",
        createdAt: new Date().toISOString(),
        workspace,
        artifact: { ...inspected.artifact, sha256: options.expectedSha256 },
        fixtureSnapshotSha256: snapshot.sha256,
        snapshotScope: "public-fixture-before-generated-manual-overrides",
        bindings,
        portLease: lease.path,
        persistentPortLease: true,
        instructions: resolve(workspace, "MANUAL-POSTGRESQL.md"),
      };
      await writeFile(
        resolve(lease.path, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            base: lease.base,
            createdAt: session.createdAt,
            purpose: "manual-postgresql",
            workspace,
            persistent: true,
            receipt: resolve(directory, "manual-session.json"),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        resolve(directory, "manual-session.json"),
        `${JSON.stringify(session, null, 2)}\n`,
        { mode: 0o600 },
      );
      return { directory, ...session };
    } catch (error) {
      // Preparation never starts resources; releasing only this newly acquired lease is safe.
      // Keep a partial workspace for diagnosis rather than deleting arbitrary copied content.
      await lease.release();
      throw error;
    }
  } finally {
    await rm(inspected.directory, { recursive: true, force: true });
  }
}

export async function checkManualInstallation(root: string) {
  await canonicalDirectory(root, "Manual workspace");
  for (const path of [
    resolve(root, "../manual-session.json"),
    resolve(root, "../candidate.tgz"),
  ])
    if (!(await lstat(path)).isFile())
      throw new Error(
        "Manual receipt and candidate must be regular files, not symbolic links.",
      );
  await canonicalDirectory(
    resolve(root, "projects/postgresql/node_modules/@rehearsal-db/core"),
    "Installed package root",
  );
  const receipt = requireObject(
    JSON.parse(await readFile(resolve(root, "../manual-session.json"), "utf8")),
    "Manual session",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "manual-postgresql" ||
    receipt.workspace !== resolve(root)
  )
    throw new Error("Run this check from the exact prepared manual workspace.");
  const artifact = requireObject(receipt.artifact, "Manual candidate");
  const path = resolve(root, "../candidate.tgz");
  if (
    typeof artifact.sha256 !== "string" ||
    (await sha256File(path)) !== artifact.sha256
  )
    throw new Error("Manual candidate bytes no longer match the receipt.");
  const inspected = await inspectArtifact(path);
  try {
    if (inspected.artifact.version !== artifact.version)
      throw new Error("Manual candidate version differs from the receipt.");
    const files = await compareInstalledPackage(
      resolve(inspected.directory, "package"),
      resolve(root, "projects/postgresql/node_modules/@rehearsal-db/core"),
    );
    return {
      version: inspected.artifact.version,
      sha256: inspected.artifact.sha256,
      files,
    };
  } finally {
    await rm(inspected.directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, artifact, expectedSha256, ...extra] = process.argv.slice(2);
  if (command === "check-install" && !artifact) {
    const result = await checkManualInstallation(labRoot);
    console.log(
      `Exact installed package match: ${result.version}; ${result.files} files; SHA-256 ${result.sha256}`,
    );
  } else if (
    command === "prepare" &&
    artifact &&
    expectedSha256 &&
    !extra.length
  ) {
    const result = await prepareManualPostgresql({
      root: labRoot,
      artifact,
      expectedSha256,
    });
    console.log(
      `Manual PostgreSQL session prepared. No service was started or dependency installed.\nWorkspace: ${result.workspace}\nInstructions: ${result.instructions}\nSHA-256: ${result.artifact.sha256}\nOpen this guide before running any commands.\nPort lease retained: ${result.portLease}`,
    );
  } else {
    console.log(
      "Usage: node --import tsx scripts/manual-postgresql.mts prepare /absolute/path/to/candidate.tgz COMPLETE_SHA256\n       node --import tsx scripts/manual-postgresql.mts check-install (inside the prepared workspace)",
    );
    if (command && command !== "--help" && command !== "-h")
      process.exitCode = 1;
  }
}
