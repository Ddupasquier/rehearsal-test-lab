import { requireApplicationSummary } from "../../../scripts/shared/validation.mts";

const port = Number(process.env.PORT ?? 5176);
const response = await fetch(`http://127.0.0.1:${port}/summary`);
if (!response.ok)
  throw new Error(`Lab application returned HTTP ${response.status}.`);

const summary = requireApplicationSummary(await response.json());

console.log(
  `PostgreSQL application proof passed: ${summary.accounts} accounts, ${summary.entries} entries, ${summary.documents} documents.`,
);
