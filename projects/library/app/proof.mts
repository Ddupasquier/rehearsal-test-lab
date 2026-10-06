import assert from "node:assert/strict";

const base =
  process.argv.find((arg) => arg.startsWith("--url="))?.slice(6) ??
  "http://127.0.0.1:5180";
const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
const booksResponse = await fetch(`${base}/books`);
assert.equal(booksResponse.status, 200);
const books: unknown = await booksResponse.json();
assert.ok(Array.isArray(books));
assert.deepEqual(
  books.map(
    (book: { id: number; title: string; copies: number; available: number }) =>
      book,
  ),
  [
    { id: 1, title: "The Clockwork Garden", copies: 2, available: 2 },
    { id: 2, title: "A Map of Quiet Places", copies: 1, available: 0 },
  ],
);
const loansResponse = await fetch(`${base}/loans`);
assert.equal(loansResponse.status, 200);
const loans: unknown = await loansResponse.json();
assert.ok(Array.isArray(loans));
assert.equal(loans.length, 1);
assert.equal(loans[0].book_id, 2);
assert.ok(
  typeof loans[0].reader_label === "string" && loans[0].reader_label.length > 0,
);
assert.equal((await fetch(`${base}/missing`)).status, 404);
assert.equal(
  (await fetch(`${base}/loans`, { method: "POST", body: "not JSON" })).status,
  400,
);
assert.equal(
  (
    await fetch(`${base}/loans`, {
      method: "POST",
      body: JSON.stringify({
        bookId: 2,
        readerLabel: "Another synthetic reader",
      }),
    })
  ).status,
  409,
);
console.log(
  "Library catalog, active loan, unavailable-copy refusal, and HTTP errors verified.",
);
