import assert from "node:assert/strict";
import { lstat, readdir, readlink } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { sha256File } from "./process.mts";

export function assertSupportedPreviousRelease(version: string) {
  try {
    assertUpgradeVersions("0.1.0-beta.12", version);
  } catch {
    throw new Error(
      "This lab's scoped UUID upgrade fixture requires a previous release of 0.1.0-beta.13 or newer.",
    );
  }
}

export function assertUpgradeVersions(previous: string, candidate: string) {
  const parse = (version: string) => {
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
        version,
      );
    if (
      !match ||
      match[4]
        ?.split(".")
        .some(
          (part) =>
            !part ||
            (/^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")),
        )
    )
      throw new Error(`Invalid release version: ${version}`);
    return {
      core: [match[1]!, match[2]!, match[3]!].map(BigInt),
      pre: match[4]?.split("."),
    };
  };
  const from = parse(previous),
    to = parse(candidate);
  let order = 0;
  for (let index = 0; index < 3 && order === 0; index++)
    order =
      from.core[index]! < to.core[index]!
        ? -1
        : from.core[index]! > to.core[index]!
          ? 1
          : 0;
  if (order === 0) {
    if (!from.pre && to.pre) order = 1;
    else if (from.pre && !to.pre) order = -1;
    else if (from.pre && to.pre) {
      for (
        let index = 0;
        index < Math.max(from.pre.length, to.pre.length) && order === 0;
        index++
      ) {
        const a = from.pre[index],
          b = to.pre[index];
        if (a === undefined) order = -1;
        else if (b === undefined) order = 1;
        else if (a !== b) {
          const numericA = /^\d+$/u.test(a),
            numericB = /^\d+$/u.test(b);
          order =
            numericA && numericB
              ? BigInt(a) < BigInt(b)
                ? -1
                : 1
              : numericA !== numericB
                ? numericA
                  ? -1
                  : 1
                : a < b
                  ? -1
                  : 1;
        }
      }
    }
  }
  assert.equal(
    order,
    -1,
    `Upgrade requires a newer candidate: ${previous} → ${candidate}`,
  );
}

export async function snapshotUpgradeState(project: string) {
  const entries: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    const entry = await lstat(path);
    const key = relative(project, path);
    if (entry.isSymbolicLink()) entries[key] = `link:${await readlink(path)}`;
    else if (entry.isDirectory()) {
      entries[key] = `directory:${entry.mode & 0o777}`;
      for (const child of (await readdir(path)).sort())
        await walk(resolve(path, child));
    } else if (entry.isFile())
      entries[key] = `file:${entry.mode & 0o777}:${await sha256File(path)}`;
    else throw new Error(`Unsupported consumer state: ${path}`);
  };
  for (const path of [
    "rehearsal.config.mjs",
    "package.json",
    "infrastructure/rehearsal",
    ".rehearsal/candidate.config.mjs",
    ".rehearsal/secrets/privacy.key",
    ".rehearsal/current",
    ".rehearsal/generations",
  ])
    await walk(resolve(project, path));
  assert.ok(
    Object.keys(entries).some((path) =>
      path.endsWith("baseline-manifest.json"),
    ),
    "Previous release must create an actual baseline.",
  );
  return entries;
}

export function assertUpgradeState(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  assert.deepEqual(
    after,
    before,
    "Upgrade changed existing configuration, privacy key, or immutable baseline state.",
  );
}
