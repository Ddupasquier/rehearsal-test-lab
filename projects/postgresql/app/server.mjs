import { createServer } from "node:http";
import pg from "pg";

const { Client } = pg;
const port = Number(process.env.PORT ?? 5176);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const server = createServer(async (request, response) => {
  if (request.url !== "/health" && request.url !== "/summary") {
    response.writeHead(404).end("Not found");
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query(`
      select
        (select count(*)::integer from lab_api.accounts) as accounts,
        (select count(*)::integer from lab_api.entries) as entries,
        (select count(*)::integer from publication.documents) as documents
    `);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, ...result.rows[0] }));
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
