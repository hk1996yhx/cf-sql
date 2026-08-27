import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createRecord, createTable, deleteRecord, dropTable, exportRecords, importRecords, readSchema, updateRecord } from "../src/sql";

function usersDatabase() {
  const schema = vi.fn().mockResolvedValue({
    results: [
      { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
  });
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 9 } });
   const batch = vi.fn().mockResolvedValue([]);
   const bind = vi.fn().mockReturnValue({ run, all: schema });
   const prepare = vi.fn((_sql: string) => ({ bind, run, all: schema }));
   return { database: { prepare, batch } as unknown as D1Database, prepare, bind, run, batch };
}

describe("visual CRUD API primitives", () => {
  it("hides and protects Cloudflare's internal metadata table", async () => {
    const all = vi.fn().mockResolvedValue({ results: [] });
    const prepare = vi.fn().mockReturnValue({ all });
    const database = { prepare } as unknown as D1Database;

    await expect(readSchema(database)).resolves.toEqual({ tables: [] });
    expect(prepare).toHaveBeenCalledWith("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY type, name");
    await expect(readSchema(database, "_cf_METADATA")).rejects.toThrow("内部系统表");
    await expect(dropTable(database, "_cf_METADATA", "admin")).rejects.toThrow("内部系统表");
  });

  it("reads table columns through D1's supported pragma table-valued function", async () => {
    const runtime = usersDatabase();
    const result = await readSchema(runtime.database, "users");
    expect(result).toMatchObject({ table: "users", columns: [{ name: "id" }, { name: "name" }] });
    expect(runtime.prepare).toHaveBeenCalledWith("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('users')");
    expect(runtime.bind).not.toHaveBeenCalled();
  });

  it("creates a record using quoted columns and bound values", async () => {
    const runtime = usersDatabase();
    const result = await createRecord(runtime.database, "users", { name: "Ada" }, "normal");
    expect(result.type).toBe("command");
    expect(runtime.prepare).toHaveBeenCalledWith('INSERT INTO "users" ("name") VALUES (?)');
    expect(runtime.bind).toHaveBeenCalledWith("Ada");
  });

  it("deletes a normal record by its primary key", async () => {
    const runtime = usersDatabase();
    await deleteRecord(runtime.database, "users", "id", 9, "normal");
    expect(runtime.prepare).toHaveBeenCalledWith('DELETE FROM "users" WHERE "id" = ?');
    expect(runtime.bind).toHaveBeenCalledWith(9);
  });

  it("supports updating and deleting records whose primary key is null", async () => {
    const runtime = usersDatabase();
    await updateRecord(runtime.database, "users", "id", null, { name: "Bob" }, "normal");
    expect(runtime.prepare).toHaveBeenCalledWith('UPDATE "users" SET "name" = ? WHERE "id" IS NULL');
    expect(runtime.bind).toHaveBeenCalledWith("Bob");

    await deleteRecord(runtime.database, "users", "id", null, "normal");
    expect(runtime.prepare).toHaveBeenCalledWith('DELETE FROM "users" WHERE "id" IS NULL');
  });

  it("exports all records and batch imports records into a table", async () => {
    const runtime = usersDatabase();
    await exportRecords(runtime.database, "users");
    expect(runtime.prepare).toHaveBeenCalledWith('SELECT * FROM "users"');

    const importResult = await importRecords(runtime.database, "users", [{ name: "Alice" }, { name: "Charlie" }], "normal");
    expect(importResult.count).toBe(2);
    expect(runtime.batch).toHaveBeenCalled();
  });

  it("allows both roles to create tables but keeps deletion behind admin", async () => {
    const runtime = usersDatabase();
    await createTable(runtime.database, { name: "users", columns: [{ name: "id", type: "INTEGER", primaryKey: true }] }, "normal");
    await createTable(runtime.database, { name: "users", columns: [{ name: "id", type: "INTEGER", primaryKey: true }] }, "admin");
    expect(runtime.prepare).toHaveBeenCalledWith('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY NOT NULL)');
    await expect(dropTable(runtime.database, "users", "normal")).rejects.toThrow("admin");
    await dropTable(runtime.database, "users", "admin");
    expect(runtime.prepare).toHaveBeenCalledWith('DROP TABLE "users"');
  });
});
