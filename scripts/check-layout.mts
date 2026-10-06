import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requiredFiles = [
  "README.md",
  ".github/workflows/check.yml",
  "tsconfig.json",
  "package-lock.json",
  "docs/architecture.md",
  "docs/runbook.md",
  "docs/safety.md",
  "scripts/verify-onboarding.mts",
  "scripts/verify-adoption.mts",
  "scripts/verify-adoption-worker.mts",
  "scripts/adoption/review.mts",
  "scripts/adoption/interactive.mts",
  "scripts/adoption/terminal-driver.py",
  "scripts/adoption/source-review.mts",
  "docs/source-privacy-onboarding.md",
  "docs/new-user-adoption.md",
  "projects/library/package.json",
  "projects/library/package-lock.json",
  "projects/library/app/server.mts",
  "projects/library/app/proof.mts",
  "scripts/verify-candidate.mts",
  "scripts/candidate/application-config.mts",
  "scripts/candidate/docker-sentinel.mts",
  "scripts/candidate/process.mts",
  "scripts/candidate/report.mts",
  "scripts/shared/validation.mts",
  "projects/supabase/package.json",
  "projects/supabase/supabase/config.toml",
  "projects/supabase/supabase/seed.sql",
  "projects/postgresql/compose.yaml",
  "projects/postgresql/database/migrations/20261004000100_create_lab_model.sql",
  "projects/postgresql/database/seed.sql",
  "projects/postgresql/rehearsal.config.mjs",
  "projects/postgresql/infrastructure/rehearsal/source-access-policy.json",
  "projects/postgresql/infrastructure/rehearsal/sanitization-policy.json",
  "projects/postgresql/scripts/verify-rehearsal-target.mts",
];

await Promise.all(requiredFiles.map((file) => access(resolve(root, file))));

const library = JSON.parse(
  await readFile(resolve(root, "projects/library/package.json"), "utf8"),
);
if (
  library.dependencies?.["@rehearsal-db/core"] ||
  library.devDependencies?.["@rehearsal-db/core"]
)
  throw new Error(
    "The ordinary library app must start without Rehearsal installed.",
  );
for (const path of [
  "rehearsal.config.mjs",
  "infrastructure/rehearsal",
  ".rehearsal",
]) {
  await access(resolve(root, "projects/library", path)).then(
    () => {
      throw new Error(
        `The clean adoption template contains prepared Rehearsal state: ${path}`,
      );
    },
    () => undefined,
  );
}

await access(
  resolve(root, "projects/supabase/supabase/.temp/linked-project.json"),
).then(
  () => {
    throw new Error(
      "The local Supabase fixture must not be linked to a cloud project.",
    );
  },
  () => undefined,
);

const trackedCandidates = [
  "README.md",
  "docs/safety.md",
  "projects/supabase/.env.example",
];
const forbidden =
  /(postgres(?:ql)?:\/\/[^\s<]+:[^\s@]+@|service_role|eyJ[a-zA-Z0-9_-]{20,})/;

for (const file of trackedCandidates) {
  const contents = await readFile(resolve(root, file), "utf8");
  if (forbidden.test(contents)) {
    throw new Error(`${file} appears to contain a credential.`);
  }
}

console.log("Lab layout and tracked credential checks passed.");
