import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runCommand, sha256File, requireRegularFile } from "./process.mts";
import { requireObject, requireString } from "../shared/validation.mts";

export async function inspectArtifact(path: string) {
  await requireRegularFile(path, "Package artifact");
  const directory = await mkdtemp(resolve(tmpdir(), "rehearsal-candidate-"));
  try {
    const entries = runCommand("tar", ["-tzf", path])
      .stdout.split("\n")
      .filter(Boolean);
    const verbose = runCommand("tar", ["-tvzf", path])
      .stdout.split("\n")
      .filter(Boolean);
    if (
      !entries.length ||
      verbose.length !== entries.length ||
      verbose.some((entry) => !["-", "d"].includes(entry.charAt(0))) ||
      entries.some(
        (entry) =>
          !entry.startsWith("package/") ||
          entry.includes("\\") ||
          entry.split("/").includes(".."),
      )
    )
      throw new Error("Candidate artifact contains an unsafe archive path.");
    runCommand("tar", ["-xzf", path, "-C", directory]);
    const metadata = requireObject(
      JSON.parse(
        await readFile(resolve(directory, "package/package.json"), "utf8"),
      ),
      "Package metadata",
    );
    assert.equal(metadata.name, "@rehearsal-db/core");
    const version = requireString(metadata.version, "Package version");
    assert.match(
      version,
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    );
    return {
      directory,
      artifact: {
        name: "@rehearsal-db/core",
        version,
        sha256: await sha256File(path),
        bytes: (await stat(path)).size,
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
