import { createServer } from "node:http";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL to your library database.");
const port = Number(
  process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? 5180,
);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid port.");
const pool = new pg.Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2000,
});
const catalog = `select b.id::integer, b.title, b.copies,
  (b.copies - count(l.id) filter (where l.returned_at is null))::integer as available
  from books b left join loans l on l.book_id=b.id group by b.id order by b.id`;
const server = createServer(async (request, response) => {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  try {
    if (request.method === "GET" && request.url === "/health") {
      await pool.query("select 1");
      send(200, { ok: true });
    } else if (request.method === "GET" && request.url === "/books") {
      send(200, (await pool.query(catalog)).rows);
    } else if (request.method === "GET" && request.url === "/loans") {
      send(
        200,
        (
          await pool.query(
            "select id::integer, book_id::integer, reader_label, returned_at from loans order by id",
          )
        ).rows,
      );
    } else if (request.method === "POST" && request.url === "/loans") {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 8192) {
          send(413, { error: "Request too large" });
          return;
        }
      }
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        send(400, { error: "Invalid JSON" });
        return;
      }
      if (
        !input ||
        typeof input !== "object" ||
        !("bookId" in input) ||
        !("readerLabel" in input) ||
        !Number.isSafeInteger(input.bookId) ||
        typeof input.readerLabel !== "string" ||
        !input.readerLabel.trim() ||
        input.readerLabel.length > 120
      ) {
        send(400, { error: "Provide a bookId and readerLabel" });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const book = await client.query<{ copies: number }>(
          "select copies from books where id=$1 for update",
          [input.bookId],
        );
        if (!book.rows[0]) {
          await client.query("rollback");
          send(404, { error: "Book not found" });
          return;
        }
        const loans = await client.query<{ count: string }>(
          "select count(*) from loans where book_id=$1 and returned_at is null",
          [input.bookId],
        );
        if (Number(loans.rows[0]?.count) >= book.rows[0].copies) {
          await client.query("rollback");
          send(409, { error: "All copies are on loan" });
          return;
        }
        const loan = await client.query<{ id: number }>(
          "insert into loans (book_id,reader_label) values ($1,$2) returning id::integer",
          [input.bookId, input.readerLabel],
        );
        await client.query("commit");
        send(201, loan.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    } else send(404, { error: "Not found" });
  } catch {
    send(503, { error: "Library database unavailable" });
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Library ready on ${port}`));
const stop = () => server.close(() => void pool.end());
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
