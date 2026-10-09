import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Script } from "node:vm";
import { createCandidateConfiguration } from "../scripts/candidate/application-config.mts";
import { requireObject } from "../scripts/shared/validation.mts";
import { renderAuthPage } from "../projects/supabase/app/auth-page.mts";

const root = resolve(import.meta.dirname, "..");

test("Supabase auth page emits parseable browser JavaScript without exposing server credentials", () => {
  const html = renderAuthPage({
    supabaseUrl: "http://127.0.0.1:58421",
    anonKey: "synthetic-publishable-key",
  });
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(html, /synthetic-publishable-key/u);
  assert.match(html, /localStorage/u);
  assert.match(html, /otp\?redirect_to=/u);
  assert.match(html, /token_hash/u);
  assert.match(html, /request\("\/verify"/u);
  assert.doesNotMatch(html, /service.role|service_role|secret.key/iu);
});

function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; output: string }>(
    (resolveResult, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", ...args], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code, output }));
    },
  );
}

for (const target of ["postgresql", "supabase"] as const) {
  test(
    `${target} HTTP routes fail closed when the database is unavailable`,
    { timeout: 30000 },
    async (context) => {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      await new Promise<void>((resolveClose, reject) =>
        reservation.close((error) => (error ? reject(error) : resolveClose())),
      );
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "app/server.mts"],
        {
          cwd: resolve(root, "projects", target),
          env: {
            ...process.env,
            PORT: String(port),
            DATABASE_URL:
              "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      const closed = new Promise<void>((resolveClose, reject) => {
        child.once("error", reject);
        child.once("close", () => resolveClose());
      });
      context.after(async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        await closed;
      });
      const deadline = Date.now() + 30_000;
      for (
        let attempt = 0;
        !output.includes("ready on") && Date.now() < deadline;
        attempt += 1
      ) {
        if (child.exitCode !== null) assert.fail(output);
        await delay(50);
      }
      assert.match(output, /ready on/u);
      const base = `http://127.0.0.1:${port}`;
      const missing = await fetch(`${base}/missing`);
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), "Not found");
      if (target === "supabase") {
        const auth = await fetch(`${base}/auth`);
        assert.equal(auth.status, 503);
        assert.equal(
          await auth.text(),
          "Local authentication is not configured.",
        );
      }
      for (const route of ["/health", "/summary"]) {
        const response = await fetch(`${base}${route}`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false });
      }
    },
  );

  test(
    `${target} candidate wrappers execute the TypeScript proof on an allocated port`,
    { timeout: 30000 },
    async (context) => {
      const temporary = resolve(root, "test-results");
      await mkdir(temporary, { recursive: true });
      const project = await mkdtemp(
        resolve(temporary, `typescript-${target}-`),
      );
      context.after(() => rm(project, { recursive: true, force: true }));
      await symlink(
        resolve(root, "projects", target, "app"),
        resolve(project, "app"),
        "dir",
      );
      await writeFile(
        resolve(project, "rehearsal.config.mjs"),
        "export default { application: { readiness: {} }, runtime: {} };\n",
      );
      const candidate = await createCandidateConfiguration(project);
      const imported: unknown = (
        await import(
          pathToFileURL(resolve(project, candidate.relativePath)).href
        )
      ).default;
      const application = requireObject(
        requireObject(imported, "Candidate config").application,
        "Candidate application",
      );
      assert.equal(
        application.startCommand,
        "node --import tsx .rehearsal/candidate-server.mjs",
      );
      assert.equal(
        application.proofCommand,
        "node --import tsx .rehearsal/candidate-proof.mjs",
      );
      assert.equal(
        requireObject(application.readiness, "Readiness").url,
        `http://127.0.0.1:${candidate.port}/health`,
      );

      let summary: unknown = {
        ok: true,
        accounts: 1,
        entries: 10000,
        documents: 2,
      };
      let authPage =
        "Continue with Google Continue with GitHub Sign in with email Send local magic link MFA secrets remain private";
      const server = createServer((request, response) => {
        if (target === "supabase" && request.url === "/auth") {
          response.end(authPage);
          return;
        }
        response.end(JSON.stringify(summary));
      });
      context.after(
        () =>
          new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          ),
      );
      server.listen(candidate.port, "127.0.0.1");
      await once(server, "listening");
      const valid = await runNode([candidate.proofPath], project);
      assert.equal(valid.code, 0, valid.output);
      assert.match(valid.output, /application proof passed/iu);
      if (target === "supabase") {
        authPage += " sb_secret_exposed";
        const leaked = await runNode([candidate.proofPath], project);
        assert.notEqual(leaked.code, 0);
        assert.match(leaked.output, /service credential marker/u);
        authPage = authPage.replace(" sb_secret_exposed", "");
      }
      summary = { ok: true, accounts: 1, entries: "10000", documents: 2 };
      const invalid = await runNode([candidate.proofPath], project);
      assert.notEqual(invalid.code, 0);
      assert.match(invalid.output, /entries must be a finite number/u);

      const missingDatabase = await runNode([candidate.serverPath], project, {
        DATABASE_URL: "",
      });
      assert.notEqual(missingDatabase.code, 0);
      assert.match(missingDatabase.output, /DATABASE_URL is required/u);
      assert.doesNotMatch(missingDatabase.output, /ERR_MODULE_NOT_FOUND/u);
    },
  );
}
