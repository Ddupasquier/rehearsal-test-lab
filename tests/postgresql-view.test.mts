import assert from "node:assert/strict";
import { test } from "node:test";
import { renderLabHome } from "../projects/postgresql/app/view.mts";

test("PostgreSQL home exposes useful aggregate counts and ordinary app navigation", () => {
  const html = renderLabHome({ accounts: 1, entries: 10000, documents: 2 });
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Your database sandbox is running/u);
  assert.match(html, />10,000<\/strong>/u);
  assert.match(html, /href="\/summary"/u);
  assert.match(html, /href="\/health"/u);
  assert.doesNotMatch(html, /<script|DATABASE_URL|postgresql:\/\//u);
});

test("PostgreSQL home refuses unknown or unsafe count values", () => {
  for (const entries of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => renderLabHome({ accounts: 1, entries, documents: 2 }));
  assert.match(
    renderLabHome({ accounts: 0, entries: 0, documents: 0 }),
    />0<\/strong>/u,
  );
});
