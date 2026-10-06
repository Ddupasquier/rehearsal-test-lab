import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runTerminal } from "../scripts/adoption/interactive.mts";

test("terminal driver gives the CLI genuine TTY input/output and selects an observed menu label", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "lab-terminal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const script = resolve(directory, "cli.mjs");
  await writeFile(
    script,
    `import { createInterface } from "node:readline/promises";
console.log(JSON.stringify({stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY,columns:process.stdout.columns,rows:process.stdout.rows}));
console.log("  1. Continue\\n  2. Exit");
const prompt = createInterface({input:process.stdin,output:process.stdout});
const answer = await prompt.question("Choose [1]: ");
if (answer !== "1") process.exitCode=1;
console.log("Selection accepted"); prompt.close();
`,
  );
  const result = await runTerminal(
    {
      command: process.execPath,
      args: [script],
      cwd: directory,
      steps: [{ expect: "Choose [1]:", select: "Continue" }],
    },
    resolve(directory, "transcript.json"),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.transcript, /"stdinTTY":true,"stdoutTTY":true/u);
  assert.match(result.transcript, /Selection accepted/u);
  assert.match(result.transcript, /"columns":120,"rows":40/u);
});

test("terminal timeout retains evidence and terminates an unanswered CLI", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "lab-terminal-timeout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const report = resolve(directory, "transcript.json");
  await assert.rejects(
    runTerminal(
      {
        command: process.execPath,
        args: ["-e", "console.log('Waiting'); setInterval(()=>{},1000)"],
        cwd: directory,
        timeoutSeconds: 30,
        steps: [
          { expect: "Waiting", send: "" },
          { expect: "Never printed", send: "yes\r", timeoutSeconds: 0.3 },
        ],
      },
      report,
    ),
    /timed out/u,
  );
  const saved = JSON.parse(await readFile(report, "utf8"));
  assert.match(saved.transcript, /Waiting/u);
  assert.notEqual(saved.exitCode, 0);
  assert.match(saved.failure, /timed out/u);
});
