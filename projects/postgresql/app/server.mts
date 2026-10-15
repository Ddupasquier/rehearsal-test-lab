import { createServer } from "node:http";
import pg from "pg";
import { renderLabHome } from "./view.mts";

const { Client } = pg;
const port = Number(process.env.PORT ?? 5176);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const server = createServer(async (request, response) => {
  if (!["/", "/health", "/summary"].includes(request.url ?? "")) {
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
    const summary = result.rows[0];
    if (!summary) throw new Error("Lab summary query returned no rows.");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      response.end(renderLabHome(summary));
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, ...summary }));
    }
  } catch (error) {
    response.writeHead(503).end(JSON.stringify({ ok: false }));
    console.error(error instanceof Error ? error.message : error);
  } finally {
    await client.end().catch(() => {});
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`PostgreSQL lab application ready on http://127.0.0.1:${port}`);
});
