import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";

const findFreePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port)
          reject(new Error("Could not allocate a local application port."));
        else resolvePort(port);
      });
    });
  });

export async function createCandidateConfiguration(project) {
  const port = await findFreePort();
  const relativePath = ".rehearsal/candidate.config.mjs";
  const serverPath = resolve(project, ".rehearsal/candidate-server.mjs");
  const proofPath = resolve(project, ".rehearsal/candidate-proof.mjs");
  await mkdir(resolve(project, ".rehearsal"), { recursive: true });
  await writeFile(
    serverPath,
    `process.env.PORT = ${JSON.stringify(String(port))};\nawait import("../app/server.mjs");\n`,
    { mode: 0o600 },
  );
  await writeFile(
    proofPath,
    `const response = await fetch("http://127.0.0.1:${port}/summary");\nif (!response.ok) throw new Error(\`Candidate application returned HTTP \${response.status}.\`);\nconst summary = await response.json();\nif (!summary.ok || summary.accounts < 1 || summary.entries < 1 || summary.documents < 1) {\n  throw new Error(\`Unexpected candidate summary: \${JSON.stringify(summary)}\`);\n}\nconsole.log(\`Candidate application proof passed: \${summary.accounts} accounts, \${summary.entries} entries, \${summary.documents} documents.\`);\n`,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(project, relativePath),
    `import base from "../rehearsal.config.mjs";\n\nexport default {\n  ...base,\n  application: {\n    ...base.application,\n    startCommand: "node .rehearsal/candidate-server.mjs",\n    proofCommand: "node .rehearsal/candidate-proof.mjs",\n    readiness: {\n      ...base.application.readiness,\n      url: "http://127.0.0.1:${port}/health",\n    },\n  },\n  runtime: {\n    ...base.runtime,\n    applicationUrl: "http://127.0.0.1:${port}",\n  },\n};\n`,
    { mode: 0o600 },
  );
  return { relativePath, port, serverPath, proofPath };
}
