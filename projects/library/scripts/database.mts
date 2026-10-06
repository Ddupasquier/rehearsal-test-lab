import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL to your local library database.");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (process.argv[2] === "migrate") {
    await client.query(
      "create schema if not exists app_migrations; create table if not exists app_migrations.schema_migrations (version text primary key, name text not null, statements text[] not null)",
    );
    const directory = resolve(import.meta.dirname, "../database/migrations");
    for (const file of (await readdir(directory)).sort()) {
      const match = /^(\d{14})_(.+)\.sql$/u.exec(file);
      if (!match) continue;
      const version = match[1]!,
        name = match[2]!;
      if (
        (
          await client.query(
            "select 1 from app_migrations.schema_migrations where version=$1",
            [version],
          )
        ).rowCount
      )
        continue;
      const sql = await readFile(resolve(directory, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into app_migrations.schema_migrations values ($1,$2,$3)",
          [version, name, [sql]],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } else if (process.argv[2] === "seed") {
    await client.query(
      await readFile(
        resolve(import.meta.dirname, "../database/seed.sql"),
        "utf8",
      ),
    );
  } else throw new Error("Use migrate or seed.");
} finally {
  await client.end();
}
