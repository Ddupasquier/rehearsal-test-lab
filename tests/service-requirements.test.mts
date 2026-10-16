import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import test from "node:test";
import {
  assertServiceRequirementResult,
  executeServiceRequirement,
  exerciseServiceRequirements,
  readProfileConfiguration,
  serviceRequirementControls,
  serviceRequirementToolSource,
  type ServiceControlRequest,
  type ServiceRequirementControl,
} from "../scripts/candidate/service-requirements.mts";
import type { ResourceProfile } from "../scripts/candidate/resource-profiles.mts";

const runId = "rtl-0123456789";
const version = "0.1.0-rc.7";
const template =
  "[api]\nenabled = true\n\n[realtime]\nenabled = true\n\n[storage]\nenabled = true\n";
const serialize = (value: unknown) =>
  `export default ${JSON.stringify(value, null, 2)};\n`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const config = (profile: ResourceProfile) => ({
  schemaVersion: 1,
  runtime: {
    target: profile === "postgresql" ? "postgresql" : "supabase",
    projectId: `${runId}-${profile === "postgresql" ? "postgresql" : "supabase"}-rehearsal`,
  },
  application: { requiredServices: ["database"] },
  ...(profile === "postgresql"
    ? {}
    : {
        supabase: {
          serviceProfile: profile,
          rehearsalConfig: "benchmark/config.toml",
        },
      }),
});
function metadata(source: string, path: string) {
  return {
    schemaVersion: 1,
    rehearsalVersion: version,
    command: "configuration",
    status: "success",
    data: {
      schemaVersion: 1,
      path,
      sourceSha256: sha(source),
      patchContract: {
        writesConfiguration: false,
        executesProposedCommands: false,
      },
    },
  };
}
function refusal(control: ServiceRequirementControl) {
  return {
    schemaVersion: 1,
    rehearsalVersion: version,
    status: "error",
    error: control.syntheticContext
      ? {
          category: "configuration_invalid",
          code: "MANAGER_START_FAILED",
          message: "Rehearsal start failed.",
          actual: control.expectedRefusal,
        }
      : {
          category: "runtime_dependency_failure",
          code: "RUNTIME_DEPENDENCY_FAILURE",
          message: `The ${control.configuration.runtime && "PostgreSQL/Supabase"} target ${control.expectedRefusal}.`,
        },
  };
}

async function project(
  profile: ResourceProfile,
  action: (path: string, source: string) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(resolve(tmpdir(), "rehearsal-service-unit-")),
  );
  const source = serialize(config(profile));
  try {
    await mkdir(resolve(root, ".rehearsal"));
    await mkdir(resolve(root, "benchmark"));
    await writeFile(resolve(root, "rehearsal.config.mjs"), source);
    await writeFile(resolve(root, "benchmark/config.toml"), template);
    await action(root, source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("service controls parse only the generated JSON declaration without evaluating project code", () => {
  const source = serialize(config("postgresql"));
  assert.deepEqual(readProfileConfiguration(source), config("postgresql"));
  for (const invalid of [
    `import fs from 'node:fs';\n${source}`,
    source.trim(),
    "export default {schemaVersion:1};\n",
    serialize({ schemaVersion: 2 }),
    serialize({ schemaVersion: 1, oversized: "x".repeat(65536) }),
  ])
    assert.throws(() => readProfileConfiguration(invalid));
});

test("service controls cover positive metadata and exact early refusals without changing reviewed inputs", () => {
  for (const profile of ["postgresql", "application", "full"] as const) {
    const original = config(profile);
    const before = serialize(original);
    const controls = serviceRequirementControls({
      configuration: original,
      profile,
      template: profile === "postgresql" ? null : template,
    });
    assert.equal(controls.length, profile === "postgresql" ? 2 : 5);
    assert.equal(controls[0]!.command, "configuration");
    assert.equal(controls[1]!.syntheticContext, false);
    assert.match(
      controls[1]!.expectedRefusal!,
      profile === "postgresql" ? /auth/u : /realtime/u,
    );
    assert.equal(serialize(original), before);
    if (profile !== "postgresql") {
      assert.equal(controls[2]!.name, "full-realtime-metadata-accepted");
      assert.deepEqual(
        (controls[2]!.configuration.application as Record<string, unknown>)
          .requiredServices,
        ["database", "realtime"],
      );
      for (const control of controls.slice(3)) {
        assert.equal(control.syntheticContext, true);
        assert.ok(control.template!.startsWith("[api]\nenabled = true\n\n"));
        assert.ok(control.template!.endsWith("[storage]\nenabled = true\n"));
      }
      assert.match(controls[3]!.template!, /\[realtime\]\nenabled = false\n/u);
      assert.match(
        controls[4]!.template!,
        /\[realtime\]\nenabled = true\nenabled = true\n/u,
      );
    }
  }
  for (const invalid of [
    "[api]\nenabled = true\n",
    `${template}\n[realtime]\nenabled = true\n`,
  ])
    assert.throws(() =>
      serviceRequirementControls({
        configuration: config("application"),
        profile: "application",
        template: invalid,
      }),
    );
});

test("service result assertions require the intended public refusal, not a generic Docker failure", () => {
  const controls = serviceRequirementControls({
    configuration: config("application"),
    profile: "application",
    template,
  });
  const source = serialize(config("application"));
  const configPath = ".rehearsal/private/config.mjs";
  for (const control of controls) {
    const envelope = control.expectedRefusal
      ? refusal(control)
      : metadata(source, configPath);
    const status = control.expectedRefusal
      ? control.syntheticContext
        ? 2
        : 9
      : 0;
    const check = (value: unknown, exit = status) =>
      assertServiceRequirementResult({
        control,
        result: { status: exit, stdout: JSON.stringify(value), stderr: "" },
        source,
        configPath,
        version,
      });
    check(envelope);
    assert.throws(() => check({ ...envelope, rehearsalVersion: "0.0.0" }));
    assert.throws(() => check(envelope, 10));
    if (control.expectedRefusal) {
      const actual = refusal(control);
      assert.throws(() =>
        check({ ...actual, error: { ...actual.error, code: "UNEXPECTED" } }),
      );
      assert.throws(() =>
        check({
          ...actual,
          error: {
            ...actual.error,
            message: "Docker is unavailable",
            actual: "Docker is unavailable",
          },
        }),
      );
      assert.throws(() =>
        check({
          ...actual,
          error: { ...actual.error, category: "internal_failure" },
        }),
      );
    } else {
      const actual = metadata(source, configPath);
      assert.throws(() =>
        check({
          ...actual,
          data: { ...actual.data, sourceSha256: "0".repeat(64) },
        }),
      );
      assert.throws(() =>
        check({
          ...actual,
          data: {
            ...actual.data,
            patchContract: {
              writesConfiguration: true,
              executesProposedCommands: false,
            },
          },
        }),
      );
    }
  }
});

test("synthetic tools allow only exact context metadata and audit no raw arguments", async () => {
  await project("application", async (root) => {
    const audit = resolve(root, "infrastructure.ndjson");
    const endpoint = `unix://${root}/never-running.sock`;
    await writeFile(audit, "");
    const source = serviceRequirementToolSource({
      logPath: audit,
      endpoint,
      syntheticContext: true,
    });
    const allowed = [
      ["context", "show"],
      [
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
        "rehearsal-lab-service-proof",
      ],
    ];
    for (const tool of ["docker", "colima", "supabase"]) {
      const path = resolve(root, tool);
      await writeFile(path, source);
      for (const args of [
        ...allowed,
        ["info"],
        ["start"],
        ["context", "inspect", "secret-not-recorded"],
      ]) {
        const result = spawnSync(process.execPath, [path, ...args], {
          encoding: "utf8",
          timeout: 2000,
          env: { PATH: "", HOME: root },
        });
        assert.equal(
          result.status,
          tool === "docker" && allowed.includes(args) ? 0 : 91,
        );
      }
    }
    const calls = (await readFile(audit, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(calls.length, 15);
    assert.ok(
      calls.every(
        (call) => Object.keys(call).sort().join(",") === "operation,tool",
      ),
    );
    assert.ok(!(await readFile(audit, "utf8")).includes("secret-not-recorded"));
    assert.throws(() =>
      serviceRequirementToolSource({
        logPath: audit,
        endpoint,
        syntheticContext: true,
        nodeExecutable: "node",
      }),
    );
    assert.throws(() =>
      serviceRequirementToolSource({
        logPath: audit,
        endpoint,
        syntheticContext: true,
        nodeExecutable: "/path with space/node",
      }),
    );
  });
});

function simulatedPublicResult(request: ServiceControlRequest) {
  const path = request.arguments
    .find((arg) => arg.startsWith("--config="))!
    .slice("--config=".length);
  const source = readFileSync(path, "utf8");
  const name = basename(dirname(path));
  const synthetic = name.includes("disabled") || name.includes("ambiguous");
  if (synthetic)
    appendFileSync(
      resolve(dirname(path), "infrastructure.ndjson"),
      '{"tool":"docker","operation":"context-show"}\n{"tool":"docker","operation":"context-inspect"}\n',
    );
  const control = serviceRequirementControls({
    configuration: config("application"),
    profile: "application",
    template,
  }).find((entry) => entry.name === name)!;
  const envelope = control.expectedRefusal
    ? refusal(control)
    : metadata(source, relative(request.project, path));
  return {
    status: control.expectedRefusal ? (synthetic ? 2 : 9) : 0,
    stdout: JSON.stringify(envelope),
    stderr: "",
  };
}

test("service exercise keeps original bytes and removes only its private fixtures on success and refusal mismatch", async () => {
  await project("application", async (root, source) => {
    const calls: ServiceControlRequest[] = [];
    const result = await exerciseServiceRequirements({
      project: root,
      profile: "application",
      configurationSource: source,
      runId,
      version,
      runner: (request) => {
        calls.push(request);
        assert.deepEqual(Object.keys(request.environment).sort(), [
          "CI",
          "HOME",
          "LANG",
          "LC_ALL",
          "NO_COLOR",
          "PATH",
          "TEMP",
          "TMP",
          "TMPDIR",
        ]);
        assert.ok(
          request.arguments.some((arg) =>
            arg.startsWith(`--config=${root}/.rehearsal/service-requirements-`),
          ),
        );
        assert.ok(
          request.environment.PATH!.startsWith(
            `${root}/.rehearsal/service-requirements-`,
          ),
        );
        return simulatedPublicResult(request);
      },
    });
    assert.equal(calls.length, 5);
    assert.equal(result.realInfrastructureCommands, 0);
    assert.equal(result.reviewedFilesPreserved, true);
    assert.match(result.scope, /not engine/u);
    assert.equal(
      result.cases.filter((entry) => entry.syntheticContextReads === 2).length,
      2,
    );
    assert.equal(
      await readFile(resolve(root, "rehearsal.config.mjs"), "utf8"),
      source,
    );
    assert.equal(
      await readFile(resolve(root, "benchmark/config.toml"), "utf8"),
      template,
    );
    assert.deepEqual(await readdir(resolve(root, ".rehearsal")), []);
    await assert.rejects(
      exerciseServiceRequirements({
        project: root,
        profile: "application",
        configurationSource: source,
        runId,
        version,
        runner: () => {
          throw new Error("primary synthetic failure");
        },
      }),
      /primary synthetic failure/u,
    );
    assert.equal(
      await readFile(resolve(root, "rehearsal.config.mjs"), "utf8"),
      source,
    );
    assert.equal(
      await readFile(resolve(root, "benchmark/config.toml"), "utf8"),
      template,
    );
    assert.deepEqual(await readdir(resolve(root, ".rehearsal")), []);
  });
});

test(
  "a timed-out synthetic CLI and its separately detached manager are retired by exact private config ownership",
  { skip: process.platform === "win32" },
  async () => {
    await project("application", async (root, source) => {
      await mkdir(resolve(root, "node_modules/.bin"), { recursive: true });
      await writeFile(
        resolve(root, "node_modules/.bin/rehearsal"),
        `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const config=process.argv.find(arg=>arg.startsWith('--config=')).slice(9);
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',config],{detached:true,stdio:'ignore'});
writeFileSync(resolve(dirname(config),'detached.pid'),String(child.pid));
child.unref();setInterval(()=>{},1000);
`,
      );
      let detachedPid = 0;
      try {
        await assert.rejects(
          exerciseServiceRequirements({
            project: root,
            profile: "application",
            configurationSource: source,
            runId,
            version,
            runner: async (request) => {
              try {
                return await executeServiceRequirement(request, {
                  timeoutMs: 500,
                });
              } finally {
                const path = request.arguments
                  .find((arg) => arg.startsWith("--config="))!
                  .slice(9);
                detachedPid = Number(
                  readFileSync(resolve(dirname(path), "detached.pid"), "utf8"),
                );
              }
            },
          }),
          /exceeded its bound/u,
        );
        assert.ok(Number.isSafeInteger(detachedPid) && detachedPid > 1);
        assert.throws(() => process.kill(detachedPid, 0), { code: "ESRCH" });
        assert.deepEqual(await readdir(resolve(root, ".rehearsal")), []);
      } finally {
        if (detachedPid > 1) {
          try {
            process.kill(detachedPid, "SIGKILL");
          } catch (error) {
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            ))
              throw error;
          }
        }
      }
    });
  },
);
