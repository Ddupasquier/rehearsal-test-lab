import { randomUUID, createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "./process.mts";
import { requireObject } from "../shared/validation.mts";

const leaseRoot = resolve(tmpdir(), "rehearsal-test-lab-leases");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function claim(path: string): Promise<boolean> {
  try {
    await mkdir(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return false;
    throw error;
  }
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

export async function acquirePortLease(directory = leaseRoot) {
  await mkdir(directory, { recursive: true });
  const first = Math.floor(Math.random() * 500);
  for (let attempt = 0; attempt < 500; attempt++) {
    const base = 42000 + ((first + attempt) % 500) * 32;
    const path = resolve(directory, `ports-${base}`);
    if (!(await claim(path))) continue;
    try {
      const ports = Array.from({ length: 32 }, (_, offset) => base + offset);
      if (!(await Promise.all(ports.map(portAvailable))).every(Boolean)) {
        await rm(path, { recursive: true });
        continue;
      }
      await writeFile(
        resolve(path, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          base,
          createdAt: new Date().toISOString(),
        }),
      );
      return {
        base,
        path,
        release: () => rm(path, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error("No isolated lab port block is available.");
}

export async function acquireHeavyLease(directory = leaseRoot) {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "supabase");
  const deadline = Date.now() + 20 * 60 * 1000;
  while (!(await claim(path))) {
    if (Date.now() >= deadline)
      throw new Error(
        `Supabase resource slot is busy; inspect ${path}/owner.json. Stale leases are never deleted automatically.`,
      );
    await delay(1000);
  }
  try {
    await writeFile(
      resolve(path, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        createdAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return () => rm(path, { recursive: true, force: true });
}

export function isolationBindings(
  base: number,
  token = randomUUID().replaceAll("-", "").slice(0, 10),
) {
  const prefix = `rtl-${token}`;
  return {
    prefix,
    base,
    sourcePostgresql: `${prefix}-postgresql`,
    sourceSupabase: prefix,
    targetPostgresql: `${prefix}-postgresql-rehearsal`,
    targetSupabase: `${prefix}-supabase-rehearsal`,
    adoptionTarget: `${prefix}-library-target`,
    sourceVolume: `rtl_${token}_postgresql`,
  };
}
export type IsolationBindings = ReturnType<typeof isolationBindings>;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
};

export function ownedWorkspaceProcessIds(
  workspace: string,
  processList: string,
): number[] {
  const exactWorkspace = resolve(workspace);
  return processList
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter((match) =>
      match[2]!.includes(`${exactWorkspace}/`),
    )
    .map((match) => Number(match[1]))
    .filter(
      (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
    );
}

export async function reapOwnedWorkspaceProcesses(
  workspace: string,
): Promise<readonly number[]> {
  if (process.platform === "win32") return Object.freeze([]);
  const processList = runCommand("ps", ["-axo", "pid=,command="]).stdout;
  const owned = ownedWorkspaceProcessIds(workspace, processList);
  for (const pid of owned) {
    if (processIsAlive(pid)) process.kill(pid, "SIGTERM");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (owned.every((pid) => !processIsAlive(pid))) return Object.freeze(owned);
    await delay(100);
  }
  for (const pid of owned) {
    if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (owned.every((pid) => !processIsAlive(pid))) return Object.freeze(owned);
    await delay(100);
  }
  throw new Error(
    `Failed to stop workspace-owned processes: ${owned.filter(processIsAlive).join(", ")}`,
  );
}

export async function removeWorkspace(workspace: string) {
  const unlock = async (path: string): Promise<void> => {
    const entry = await lstat(path);
    if (!entry.isDirectory())
      throw new Error(
        `Workspace directory is not a regular directory: ${path}`,
      );
    await chmod(path, entry.mode | 0o700);
    for (const child of await readdir(path, { withFileTypes: true })) {
      if (child.isDirectory()) await unlock(resolve(path, child.name));
    }
  };
  await unlock(workspace);
  await rm(workspace, { recursive: true, force: true });
}

export function rewriteFixture(contents: string, bindings: IsolationBindings) {
  const { base, prefix, sourceVolume } = bindings;
  const ports = new Map<number, number>([
    [55432, base + 24],
    [58642, base + 25],
    [8083, base + 26],
    [5175, base + 27],
    [5176, base + 28],
  ]);
  for (let offset = 0; offset < 10; offset++) {
    ports.set(58420 + offset, base + offset);
    ports.set(58340 + offset, base + 12 + offset);
  }
  return contents
    .replace(/(?<!com\.)rehearsal-test-lab/gu, prefix)
    .replaceAll("rehearsal_lab_postgresql", sourceVolume)
    .replace(/\b\d{4,5}\b/gu, (match) =>
      String(ports.get(Number(match)) ?? match),
    );
}

export async function createWorkspace(
  root: string,
  workspace: string,
  bindings: IsolationBindings,
) {
  // Git's inventory excludes ignored credentials, runtime data, dependency trees, and reports.
  const files = runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .stdout.split("\0")
    .filter(Boolean);
  const copiedFiles: string[] = [];
  for (const file of new Set(files)) {
    if (file.endsWith("/20261005000100_rehearsal_candidate_probe.sql"))
      continue;
    let entry;
    try {
      entry = await lstat(resolve(root, file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    if (!entry.isFile())
      throw new Error(`Refusing to snapshot non-regular file ${file}.`);
    const destination = resolve(workspace, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(root, file), destination);
    copiedFiles.push(file);
    if (
      (file.startsWith("projects/") ||
        [
          "scripts/local-supabase.mts",
          "scripts/verify-rehearsal-target.mts",
          "scripts/postgresql-runtime.mts",
          "scripts/ensure-postgresql-volume.mts",
        ].includes(file)) &&
      /\.(?:mts|mjs|json|toml|yaml)$/u.test(file)
    ) {
      await writeFile(
        destination,
        rewriteFixture(await readFile(destination, "utf8"), bindings),
      );
    }
  }
  for (const target of ["postgresql", "supabase"] as const) {
    const path = resolve(
      workspace,
      `projects/${target}/infrastructure/rehearsal/source-access-policy.json`,
    );
    const policy = requireObject(
      JSON.parse(await readFile(path, "utf8")),
      "Source policy",
    );
    policy.targetFingerprint = hash(
      `${JSON.stringify({ protocol: "postgresql", hostname: "127.0.0.1", port: String(bindings.base + (target === "postgresql" ? 24 : 2)), database: target === "postgresql" ? "rehearsal_lab" : "postgres" }, null, "\t")}\n`,
    );
    if (target === "supabase")
      requireObject(policy.assetReader, "Asset reader").endpointFingerprint =
        hash(`http://127.0.0.1:${bindings.base + 1}`);
    await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`);
  }
  const inventory = await Promise.all(
    copiedFiles.sort().map(async (path) => ({
      path,
      sha256: createHash("sha256")
        .update(await readFile(resolve(workspace, path)))
        .digest("hex"),
    })),
  );
  return { inventory, sha256: hash(JSON.stringify(inventory)) };
}

export async function removeOwnedResources(
  workspace: string,
  bindings: IsolationBindings,
  command: typeof runCommand = runCommand,
) {
  const adoptionSources = command("docker", [
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    `label=com.rehearsal-test-lab.parent-run=${bindings.prefix}`,
  ])
    .stdout.trim()
    .split(/\s+/u)
    .filter(Boolean);
  for (const id of adoptionSources)
    command("docker", ["container", "rm", "--force", "--volumes", id]);
  for (const type of ["container", "volume"] as const) {
    const ids = command("docker", [
      type,
      "ls",
      ...(type === "container" ? ["--all"] : []),
      "--quiet",
      "--filter",
      `label=com.rehearsal-db.project=${bindings.adoptionTarget}`,
    ])
      .stdout.trim()
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of ids)
      command("docker", [
        type,
        "rm",
        ...(type === "container" ? ["--force"] : []),
        id,
      ]);
  }
  for (const type of ["container", "network", "volume"] as const) {
    const ids = command("docker", [
      type,
      "ls",
      ...(type === "container" ? ["--all"] : []),
      "--quiet",
      "--filter",
      `label=com.rehearsal-test-lab.sentinel=${bindings.prefix}`,
    ])
      .stdout.trim()
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of ids)
      command("docker", [
        type,
        "rm",
        // The worker's finally may never run after interruption. Remove only
        // this exact run-labelled test sentinel's anonymous image volumes too.
        ...(type === "container" ? ["--force", "--volumes"] : []),
        id,
      ]);
  }
  // Supabase exposes project/workdir ownership; require both before deleting anything.
  for (const type of ["container", "network", "volume"] as const) {
    for (const project of [bindings.sourceSupabase, bindings.targetSupabase]) {
      const ids = command("docker", [
        type,
        "ls",
        ...(type === "container" ? ["--all"] : []),
        "--quiet",
        "--filter",
        `label=com.supabase.cli.project=${project}`,
      ])
        .stdout.trim()
        .split(/\s+/u)
        .filter(Boolean);
      for (const id of ids) {
        const labels = command("docker", [
          type,
          "inspect",
          "--format",
          type === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}",
          id,
        ]).stdout;
        const owned = requireObject(JSON.parse(labels), "Docker labels");
        const workdir = owned["com.supabase.cli.workdir"];
        if (
          owned["com.supabase.cli.project"] !== project ||
          (type === "container" &&
            (typeof workdir !== "string" ||
              !(workdir === workspace || workdir.startsWith(`${workspace}/`))))
        )
          throw new Error(
            `Refusing to remove ${type} ${id}: ownership differs.`,
          );
        command("docker", [
          type,
          "rm",
          ...(type === "container" ? ["--force"] : []),
          id,
        ]);
      }
    }
  }
  // Source PostgreSQL uses Compose labels plus the explicit synthetic lab label.
  command("docker", [
    "compose",
    "-f",
    resolve(workspace, "projects/postgresql/compose.yaml"),
    "down",
  ]);
  const labels = command("docker", [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `name=^${bindings.sourceVolume}$`,
    "--filter",
    "label=com.rehearsal-test-lab.resource=postgresql",
  ]).stdout.trim();
  if (labels === bindings.sourceVolume)
    command("docker", ["volume", "rm", bindings.sourceVolume]);
  for (const type of ["container", "volume"] as const) {
    const ids = command("docker", [
      type,
      "ls",
      ...(type === "container" ? ["--all"] : []),
      "--quiet",
      "--filter",
      `label=com.rehearsal-db.project=${bindings.targetPostgresql}`,
    ])
      .stdout.trim()
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of ids)
      command("docker", [
        type,
        "rm",
        ...(type === "container" ? ["--force"] : []),
        id,
      ]);
  }
  const heavyPath = resolve(leaseRoot, "supabase");
  try {
    const owner = requireObject(
      JSON.parse(await readFile(resolve(heavyPath, "owner.json"), "utf8")),
      "Supabase slot owner",
    );
    if (owner.cwd === workspace) await rm(heavyPath, { recursive: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
