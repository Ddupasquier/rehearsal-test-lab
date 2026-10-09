import assert from "node:assert/strict";
import { localSupabaseEnvironment } from "./local-supabase.mts";

const environment = localSupabaseEnvironment();
const email = "lab-owner@rehearsal.test";
const password = "Rehearsal-local-only-2026!";
const headers = {
  apikey: environment.SERVICE_ROLE_KEY,
  authorization: `Bearer ${environment.SERVICE_ROLE_KEY}`,
  "content-type": "application/json",
};
const listed = await fetch(`${environment.API_URL}/auth/v1/admin/users`, {
  headers,
  signal: AbortSignal.timeout(10_000),
});
assert.equal(listed.status, 200);
const users = (await listed.json()) as {
  users?: Array<{ id?: unknown; email?: unknown }>;
};
const existing = users.users?.find((user) => user.email === email);
if (existing?.id) {
  const removed = await fetch(
    `${environment.API_URL}/auth/v1/admin/users/${existing.id}`,
    { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) },
  );
  assert.ok(
    removed.ok,
    `Existing local user removal returned ${removed.status}.`,
  );
}
const created = await fetch(`${environment.API_URL}/auth/v1/admin/users`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email, password, email_confirm: true }),
  signal: AbortSignal.timeout(10_000),
});
assert.equal(created.status, 200);
console.log(`Synthetic local Auth user ready: ${email}`);
console.log(`Synthetic local-only password: ${password}`);
console.log("These credentials work only in the disposable Test Lab runtime.");
