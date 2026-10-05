import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { errorMessage, requireObject } from "../shared/validation.mts";

export interface CommandOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  output: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly output: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

const printable = (value: string) =>
  /\s/u.test(value) ? JSON.stringify(value) : value;

export const displayCommand = (command: string, args: readonly string[]) =>
  [command, ...args].map(printable).join(" ");

export function runCommand(
  command: string,
  args: readonly string[] = [],
  options: CommandOptions = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("");
  if (result.error || result.status !== 0) {
    const error = new CommandError(
      output.trim() ||
        result.error?.message ||
        `${displayCommand(command, args)} exited with ${result.status}.`,
      displayCommand(command, args),
      output,
      result.status,
    );
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr, output };
}

export function parseJsonOutput(output: string, label: string) {
  const start = output.indexOf("{");
  if (start === -1) throw new Error(`${label} did not return JSON.`);
  try {
    return requireObject(JSON.parse(output.slice(start)), label);
  } catch (error) {
    throw new Error(`${label} returned malformed JSON: ${errorMessage(error)}`);
  }
}

export const sha256File = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const listFiles = async (root: string, directory = root): Promise<string[]> => {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await listFiles(root, path)));
    else if (entry.isFile())
      paths.push(relative(root, path).split(sep).join("/"));
    else
      throw new Error(`Candidate package contains unsupported entry ${path}.`);
  }
  return paths.sort();
};

export async function compareInstalledPackage(
  extractedRoot: string,
  installedRoot: string,
) {
  const [expected, actual] = await Promise.all([
    listFiles(extractedRoot),
    listFiles(installedRoot),
  ]);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      "Installed package file inventory differs from the artifact.",
    );
  }
  for (const path of expected) {
    const [expectedHash, actualHash] = await Promise.all([
      sha256File(resolve(extractedRoot, path)),
      sha256File(resolve(installedRoot, path)),
    ]);
    if (expectedHash !== actualHash) {
      throw new Error(`Installed package bytes differ for ${path}.`);
    }
  }
  return expected.length;
}

export async function requireRegularFile(path: string, label: string) {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`${label} is not a regular file.`);
}
