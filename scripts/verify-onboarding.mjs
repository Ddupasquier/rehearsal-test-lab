import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const requestedTarball = process.argv[2];
if (!requestedTarball) {
  throw new Error(
    "Pass the exact candidate tarball: npm run onboarding:verify -- /absolute/path/to/rehearsal-db-core-*.tgz",
  );
}

const tarball = isAbsolute(requestedTarball)
  ? requestedTarball
  : resolve(process.cwd(), requestedTarball);
const tarballDetails = await stat(tarball);
assert.equal(tarballDetails.isFile(), true, "Candidate path is not a file");

const run = (command, args, { cwd }) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        result.error?.message ||
        `${command} failed`,
    );
  }
  return result.stdout;
};

const createConsumer = async (root, target) => {
  const migrationDirectory =
    target === "supabase" ? "supabase/migrations" : "database/migrations";
  await mkdir(join(root, migrationDirectory), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: `lab-onboarding-${target}`,
        private: true,
        scripts: {
          dev: 'node -e "setInterval(() => {}, 1000)"',
          test: "node --test",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, ".gitignore"),
    "node_modules/\nkeep-this-entry/\n",
  );
  if (target === "supabase") {
    await writeFile(
      join(root, "supabase/config.toml"),
      'project_id = "lab-onboarding-supabase"\n\n[db]\nmajor_version = 17\n',
    );
  }
};

const installCandidate = (root) =>
  run(
    "npm",
    [
      "install",
      "--save-dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    { cwd: root },
  );

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "rehearsal-lab-onboarding-"),
);

try {
  const results = {};
  for (const target of ["supabase", "postgresql"]) {
    const root = join(temporaryRoot, target);
    await createConsumer(root, target);
    installCandidate(root);

    const configPath = join(root, "rehearsal.config.mjs");
    const config = await readFile(configPath, "utf8");
    assert.match(config, new RegExp(`target: "${target}"`, "u"));
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(ignore, /keep-this-entry\//u);
    assert.match(ignore, /\.rehearsal\//u);

    const init = JSON.parse(
      run(join(root, "node_modules/.bin/rehearsal"), ["init", "--json"], {
        cwd: root,
      }),
    );
    assert.equal(init.data.mode, "current-template");

    if (target === "supabase") {
      const runtimeConfig = join(
        root,
        "infrastructure/rehearsal/supabase/config.toml",
      );
      await rm(runtimeConfig);
      const recovery = JSON.parse(
        run(
          join(root, "node_modules/.bin/rehearsal"),
          ["setup", "--write", "--json"],
          { cwd: root },
        ),
      );
      assert.equal(
        recovery.data.files.find(({ path }) => path.endsWith("config.toml"))
          ?.action,
        "create",
      );
      assert.equal(await readFile(configPath, "utf8"), config);
    }

    results[target] = {
      configCreated: true,
      existingIgnoreEntryPreserved: true,
      initRecognizedExistingConfig: true,
    };
  }

  const malformedRoot = join(temporaryRoot, "malformed");
  await createConsumer(malformedRoot, "supabase");
  const malformedPath = join(malformedRoot, "rehearsal.config.mjs");
  const malformed = "export default { schemaVersion: 999 };\n";
  await writeFile(malformedPath, malformed);
  installCandidate(malformedRoot);
  assert.equal(await readFile(malformedPath, "utf8"), malformed);

  console.log(
    JSON.stringify(
      {
        status: "passed",
        artifactSha256: createHash("sha256")
          .update(await readFile(tarball))
          .digest("hex"),
        ...results,
        malformedConfigurationPreserved: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
