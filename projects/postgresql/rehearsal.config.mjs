// @ts-check
/**
 * Rehearsal configuration for rehearsal-test-lab-postgresql.
 * Generated from this project by `npx rehearsal` and safe to commit.
 * Review the CHECK comments. Keep passwords, tokens, and production URLs out of this file.
 * Docs: https://github.com/Ddupasquier/rehearsal-db/blob/main/docs/configuration.md
 */
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
  // Configuration format. Rehearsal will explain if an upgrade is ever needed.
  schemaVersion: 1,
  // Stable local name used in Rehearsal labels and reports.
  project: { name: "rehearsal-test-lab-postgresql" },

  // Disposable PostgreSQL settings. The image must already exist locally.
  postgresql: {
    migrationDirectory: "database/migrations",
    runtimeWorkdir: ".rehearsal/runtime",
    image: "postgres:17-alpine",
    database: "postgres",
    user: "postgres",
  },

  // Immutable local baseline files. Rehearsal never reads production on your behalf.
  baseline: {
    artifactDirectory: ".rehearsal",
    sanitizationPolicy: "infrastructure/rehearsal/sanitization-policy.json",
  },

  // Source refresh is limited to this local, synthetic fixture.
  // Credentials come from scripts/with-local-source.mts and stay untracked.
  preparation: {
    sourcePolicy: "infrastructure/rehearsal/source-access-policy.json",
    privacyKey: ".rehearsal/secrets/privacy.key",
    batchRows: 500,
    maximumRows: 20000,
    maximumBytes: 268435456,
    diskHeadroomBytes: 67108864,
  },
  // Optional reviewed schemas/extensions/triggers/local-only rows.
  // runtimePolicy: "infrastructure/rehearsal/runtime-policy.json",
  // Optional copied-account association. The JSON stores only reviewed matcher hashes;
  // raw emails/subjects and provider credentials stay in ignored environment files.
  // identityPolicy: "infrastructure/rehearsal/identity-policy.json",

  // Reuse any running Docker-compatible engine; start Colima only when needed.
  containerRuntime: {
    autoStartColima: true,
  },

  // Keep this many baseline generations, always including the active one.
  cleanup: {
    retainBaselineGenerations: 2,
  },

  // Optional: manage another isolated database as part of the same rehearsal.
  // Give that database its own complete config, ports, project ID, and .rehearsal folder.
  // dependentTargets: [
  //   {
  //     name: "publication-api",
  //     configPath: "rehearsal.publication.config.mjs",
  //     prepareCommand: "npm run rehearsal:prepare-publication",
  //   },
  // ],

  application: {
    // CHECK: commands detected from package.json. Change them if they are not correct.
    startCommand: "npm run dev:rehearsal",
    proofCommand: "npm run test:rehearsal",
    environmentFile: ".rehearsal/runtime.env",
    // Map generated local runtime values directly into the normal app command.
    environmentVariables: { DATABASE_URL: "primary:DATABASE_URL" },
    // Required by `rehearsal open`; use a route that responds only when the app is ready.
    readiness: {
      url: "http://localhost:5176/health",
      expectedStatus: 200,
      timeoutSeconds: 30,
    },
    // Add at least one real positive and one negative before enabling HTTP proofs.
    // httpProofs: [],
    // Optional project-specific restore hook:
    // runtimeAdapter: "infrastructure/rehearsal/runtime-adapter.mjs",
  },

  // Disposable local runtime identity, URL, and dedicated database port.
  runtime: {
    target: "postgresql",
    applicationUrl: "http://localhost:5176",
    projectId: "rehearsal-test-lab-postgresql-rehearsal",
    databasePort: 58642,
  },

  // Only local runtime URLs are accepted; common hosted credentials are quarantined.
  safety: {
    allowedHosts: ["127.0.0.1", "::1", "localhost"],
    blockedEnvironmentVariables: [
      "DATABASE_URL",
      "PGHOST",
      "PGPASSWORD",
      "PGPORT",
      "PGUSER",
    ],
    hostedAccess: "disabled",
    outboundNetwork: "deny",
  },
});
