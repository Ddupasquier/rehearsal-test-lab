import { spawnSync } from "node:child_process";

const result = spawnSync(
  "docker",
  [
    "volume",
    "create",
    "--label",
    "com.rehearsal-test-lab.resource=postgresql",
    "rehearsal_lab_postgresql",
  ],
  { encoding: "utf8" },
);
if (result.status !== 0) {
  throw new Error(
    result.stderr || "Could not prepare the PostgreSQL lab volume.",
  );
}

const inspection = spawnSync(
  "docker",
  [
    "volume",
    "inspect",
    "--format",
    '{{ index .Labels "com.rehearsal-test-lab.resource" }}',
    "rehearsal_lab_postgresql",
  ],
  { encoding: "utf8" },
);
if (inspection.status !== 0 || inspection.stdout.trim() !== "postgresql") {
  throw new Error(
    "Refusing to reuse rehearsal_lab_postgresql without the expected lab ownership label.",
  );
}
