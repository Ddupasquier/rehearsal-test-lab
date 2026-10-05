import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requiredFiles = [
  "README.md",
  ".github/workflows/check.yml",
  "docs/architecture.md",
  "docs/runbook.md",
  "docs/safety.md",
  "scripts/verify-onboarding.mjs",
  "scripts/verify-candidate.mjs",
  "scripts/candidate/application-config.mjs",
  "scripts/candidate/docker-sentinel.mjs",
  "scripts/candidate/process.mjs",
  "scripts/candidate/report.mjs",
  "projects/supabase/package.json",
  "projects/supabase/supabase/config.toml",
  "projects/supabase/supabase/seed.sql",
  "projects/postgresql/compose.yaml",
  "projects/postgresql/database/migrations/20261004000100_create_lab_model.sql",
  "projects/postgresql/database/seed.sql",
  "projects/postgresql/rehearsal.config.mjs",
  "projects/postgresql/infrastructure/rehearsal/source-access-policy.json",
  "projects/postgresql/infrastructure/rehearsal/sanitization-policy.json",
  "projects/postgresql/scripts/verify-rehearsal-target.mjs",
];

await Promise.all(requiredFiles.map((file) => access(resolve(root, file))));

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
