const response = await fetch("http://127.0.0.1:5175/summary");
if (!response.ok)
  throw new Error(`Lab application returned HTTP ${response.status}.`);

const summary = await response.json();
if (
  !summary.ok ||
  summary.accounts < 1 ||
  summary.entries < 1 ||
  summary.documents < 1
) {
  throw new Error(`Unexpected lab summary: ${JSON.stringify(summary)}`);
}

console.log(
  `Application proof passed: ${summary.accounts} accounts, ${summary.entries} entries, ${summary.documents} documents.`,
);
