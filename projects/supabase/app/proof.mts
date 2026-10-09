import { requireApplicationSummary } from "../../../scripts/shared/validation.mts";

const port = Number(process.env.PORT ?? 5175);
const response = await fetch(`http://127.0.0.1:${port}/summary`);
if (!response.ok)
  throw new Error(`Lab application returned HTTP ${response.status}.`);

const summary = requireApplicationSummary(await response.json());

const auth = await fetch(`http://127.0.0.1:${port}/auth`);
if (!auth.ok) throw new Error(`Auth page returned HTTP ${auth.status}.`);
const authPage = await auth.text();
for (const expected of [
  "Continue with Google",
  "Continue with GitHub",
  "Sign in with email",
  "Send local magic link",
]) {
  if (!authPage.includes(expected)) {
    throw new Error(`Auth page is missing ${expected}.`);
  }
}
if (/service.?role|SUPABASE_SERVICE_ROLE_KEY|sb_secret_/i.test(authPage)) {
  throw new Error("Auth page exposed a service credential marker.");
}

console.log(
  `Application proof passed: ${summary.accounts} accounts, ${summary.entries} entries, ${summary.documents} documents, and four local sign-in choices.`,
);
