/** Ordinary read-only application UI. No Rehearsal internals or credentials enter HTML. */
export interface LabSummary {
  readonly accounts: number;
  readonly entries: number;
  readonly documents: number;
}

export function renderLabHome(summary: LabSummary): string {
  const count = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("The application summary contains an invalid count.");
    return value.toLocaleString("en-US");
  };
  const cards = [
    ["Accounts", count(summary.accounts)],
    ["Entries", count(summary.entries)],
    ["Publication documents", count(summary.documents)],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PostgreSQL · Test Lab</title>
<style>
:root{color-scheme:dark light;--bg:#0b1319;--panel:#142129;--line:#2c424c;--text:#e9f2f5;--muted:#abbcc5;--accent:#7be0bc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}
main{width:min(960px,100%);margin:auto;padding:clamp(24px,7vw,80px) clamp(20px,5vw,48px)}
.eyebrow{color:var(--accent);font:700 12px/1.5 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}
h1{font-size:clamp(32px,6vw,58px);line-height:1.12;letter-spacing:-.04em;max-width:15ch;margin:20px 0}p{color:var(--muted);max-width:65ch}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:16px;margin:32px 0}
article{background:var(--panel);border:1px solid var(--line);padding:24px;border-radius:14px;min-width:0}
article h2{margin:0;font-size:13px;color:var(--muted)}article strong{display:block;font-size:38px;letter-spacing:-.04em;margin-top:12px;overflow-wrap:anywhere}
nav{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0}a{color:var(--accent)}nav a{display:inline-block;border:1px solid var(--line);padding:10px 16px;border-radius:8px;text-decoration:none}nav a:first-child{background:var(--accent);color:#092219;font-weight:700}
a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}small{color:var(--muted)}
@media(prefers-color-scheme:light){:root{--bg:#f3f8f7;--panel:#fff;--line:#c5d9d3;--text:#102c25;--muted:#45655c;--accent:#08764f}nav a:first-child{color:#fff}}
</style></head><body><main>
<p class="eyebrow">Local PostgreSQL · Test Lab</p>
<h1>Your database sandbox is running.</h1>
<p>This ordinary application reads the database selected by its launcher. In the isolated manual walkthrough, that is your disposable Rehearsal target—not the source or a hosted database.</p>
<section class="cards" aria-label="Current database counts">${cards.map(([label, value]) => `<article><h2>${label}</h2><strong>${value}</strong></article>`).join("")}</section>
<nav aria-label="Application checks"><a href="/">Refresh counts</a><a href="/summary">View JSON summary</a><a href="/health">Check health</a></nav>
<p>Keep the terminal running while you explore. Press Ctrl+C once to close the application. Use Rehearsal’s Stop action to stop the database without deleting its data.</p>
<small>Counts are aggregate synthetic fixture data. No credentials or private records are displayed.</small>
</main></body></html>`;
}
