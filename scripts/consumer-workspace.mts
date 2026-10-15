import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage, requireObject } from "./shared/validation.mts";

const maximumMetadataBytes = 1024 * 1024;
const configurationFilename = "rehearsal.config.mjs";

async function regularMetadata(path: string, read: boolean) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(
      "Project metadata must be regular files, not symbolic links.",
    );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximumMetadataBytes)
      throw new Error(
        "Project metadata must be regular files of at most 1 MiB.",
      );
    if (!read) return undefined;
    const buffer = Buffer.alloc(maximumMetadataBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximumMetadataBytes)
      throw new Error("Project metadata grew beyond its 1 MiB limit.");
    try {
      return requireObject(
        JSON.parse(buffer.subarray(0, length).toString("utf8")),
        "Package metadata",
      );
    } catch {
      throw new Error("The project's package.json must contain a JSON object.");
    }
  } finally {
    await file.close();
  }
}

async function projectIdentity(path: string, expectedName?: string) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error(
      "Choose an existing project directory, not a symbolic link.",
    );
  const root = await realpath(path);
  const metadata = await regularMetadata(resolve(root, "package.json"), true);
  const name = metadata?.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 214 ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    (expectedName !== undefined && name !== expectedName)
  )
    throw new Error("The project has missing or unexpected package identity.");
  await regularMetadata(resolve(root, configurationFilename), false);
  return { root, name };
}

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

async function ownedOutputDirectory(labRoot: string) {
  let directory = labRoot;
  for (const child of ["test-results", "consumer-workspaces"]) {
    directory = resolve(directory, child);
    await mkdir(directory).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "Workspace output must remain in regular Lab-owned directories.",
      );
  }
  return directory;
}

/** Generates editor navigation only. Never imports configs or launches a subprocess. */
export async function createConsumerWorkspace({
  labRoot,
  consumerRoot,
}: {
  labRoot: string;
  consumerRoot: string;
}) {
  if (!isAbsolute(labRoot) || !isAbsolute(consumerRoot))
    throw new Error("Pass absolute Lab and consumer project directories.");
  const labEntry = await lstat(labRoot);
  if (!labEntry.isDirectory() || labEntry.isSymbolicLink())
    throw new Error("The Lab root must be a regular directory.");
  const actualLabRoot = await realpath(labRoot);
  const labPackage = await regularMetadata(
    resolve(actualLabRoot, "package.json"),
    true,
  );
  if (labPackage?.name !== "rehearsal-test-lab")
    throw new Error("The Lab root has an unexpected package identity.");
  const postgresql = await projectIdentity(
    resolve(actualLabRoot, "projects/postgresql"),
    "@rehearsal-test-lab/postgresql",
  );
  const supabase = await projectIdentity(
    resolve(actualLabRoot, "projects/supabase"),
    "@rehearsal-test-lab/supabase",
  );
  const consumer = await projectIdentity(consumerRoot);
  if (
    contains(actualLabRoot, consumer.root) ||
    contains(consumer.root, actualLabRoot)
  )
    throw new Error("Choose a separate consumer project outside Test Lab.");

  const directory = await ownedOutputDirectory(actualLabRoot);
  const slug =
    consumer.name
      .replaceAll(/[^a-zA-Z0-9_-]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 64) || "consumer";
  const path = resolve(directory, `${slug}.code-workspace`);
  const workspace = {
    folders: [
      { name: "Test Lab · PostgreSQL", path: postgresql.root },
      { name: "Test Lab · Supabase", path: supabase.root },
      { name: `Consumer · ${consumer.name}`, path: consumer.root },
    ],
    settings: {
      // All three validated roots have this file; never invent per-folder settings.
      "rehearsal.configPath": configurationFilename,
      "rehearsal.openDashboardAutomatically": false,
    },
  };
  await writeFile(path, `${JSON.stringify(workspace, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { path, workspace };
}

const usage = `Usage: npm run consumer:workspace -- /absolute/path/to/existing-project

Creates a private, non-overwriting VS Code workspace under test-results/consumer-workspaces/.
The existing consumer must have package.json and rehearsal.config.mjs at its root.
No configuration, environment, baseline, dependency or runtime is copied or changed.
Open the generated workspace in VS Code, then choose a project with Rehearsal: Open Dashboard.
Each dashboard uses that project's installed CLI, approved data and existing runtime.`;

export async function consumerWorkspaceMain(args: readonly string[]) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(usage);
    return;
  }
  if (args.length !== 1 || !args[0] || args[0].startsWith("-"))
    throw new Error(usage);
  const result = await createConsumerWorkspace({
    labRoot: resolve(import.meta.dirname, ".."),
    consumerRoot: args[0],
  });
  console.log(
    `Workspace created: ${result.path}\n\nOpen this .code-workspace file in VS Code.\nChoose Rehearsal: Open Dashboard, then the intended project.\nThe consumer uses its existing sandbox; it is not a new Test Lab copy.`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await consumerWorkspaceMain(process.argv.slice(2)).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
