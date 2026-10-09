import { createServer } from "node:http";
import pg from "pg";
import { renderAuthPage } from "./auth-page.mts";

const { Client } = pg;
const port = Number(process.env.PORT ?? 5175);
const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const server = createServer(async (request, response) => {
  const pathname = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  ).pathname;
  if (pathname === "/" || pathname === "/auth") {
    if (!supabaseUrl || !supabaseAnonKey) {
      response.writeHead(503).end("Local authentication is not configured.");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(renderAuthPage({ supabaseUrl, anonKey: supabaseAnonKey }));
    return;
  }
  if (pathname !== "/health" && pathname !== "/summary") {
    response.writeHead(404).end("Not found");
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query<{
      accounts: number;
      entries: number;
      documents: number;
    }>(`
      select
        (select count(*)::integer from lab_api.accounts) as accounts,
        (select count(*)::integer from lab_api.entries) as entries,
        (select count(*)::integer from publication.documents) as documents
    `);
    response.setHeader("content-type", "application/json");
    const summary = result.rows[0];
    if (!summary) throw new Error("Lab summary query returned no rows.");
    response.end(JSON.stringify({ ok: true, ...summary }));
  } catch (error) {
    response.writeHead(503).end(JSON.stringify({ ok: false }));
    console.error(error instanceof Error ? error.message : error);
  } finally {
    await client.end().catch(() => {});
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Synthetic lab application ready on http://127.0.0.1:${port}`);
});
