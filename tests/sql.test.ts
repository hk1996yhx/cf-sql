import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { classifySql, executeSql, validateSql } from "../src/sql";

describe("SQL policy", () => {
  it("separates read, CRUD, and admin statements", async () => {
    expect(classifySql("/* comment */ SELECT * FROM users;")).toBe("read");
    expect(classifySql("WITH active AS (SELECT * FROM users) SELECT * FROM active")).toBe("read");
    expect(classifySql("WITH changed AS (SELECT 1) UPDATE users SET active = 1")).toBe("crud");
    expect(classifySql("CREATE TABLE notes (id INTEGER PRIMARY KEY)")).toBe("create-table");
    expect(classifySql("PRAGMA table_info('users')")).toBe("read");
    expect(classifySql("PRAGMA foreign_keys = ON")).toBe("admin");
    expect(classifySql("UPDATE users SET name = 'semi;colon'")).toBe("crud");
    expect(classifySql("DROP TABLE users")).toBe("drop-table");

    const run = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 8 } });
    const bind = vi.fn().mockReturnValue({ run });
    const database = { prepare: vi.fn().mockReturnValue({ bind, run }) } as unknown as D1Database;
    await expect(executeSql(database, { sql: "DELETE FROM users WHERE id = ?", params: [8] }, "normal"))
      .resolves.toMatchObject({ type: "command", rowCount: 1 });
   await expect(executeSql(database, { sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY)" }, "normal"))
     .resolves.toMatchObject({ type: "command" });
   await expect(executeSql(database, { sql: "DROP TABLE users" }, "normal")).rejects.toThrow("admin");
    await expect(executeSql(database, { sql: "ALTER TABLE users ADD COLUMN age INTEGER" }, "normal")).rejects.toThrow("admin");
   await expect(executeSql(database, { sql: "DROP TABLE users" }, "admin")).resolves.toMatchObject({ type: "command" });
   await expect(executeSql(database, { sql: "ALTER TABLE users ADD COLUMN age INTEGER" }, "admin"))
      .resolves.toMatchObject({ type: "command" });
 });

  it("allows one trailing semicolon but blocks stacked statements", () => {
    expect(validateSql("SELECT 1; -- trailing comment")).toBe("SELECT 1; -- trailing comment");
    expect(() => validateSql("SELECT 1; DELETE FROM users")).toThrow("一条 SQL");
    expect(() => validateSql("SELECT 1; /* second */ UPDATE users SET id = 1")).toThrow("一条 SQL");
  });

  it("uses prepared bindings and normalizes JSON parameter types", async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ id: 7, active: 1 }] });
    const bind = vi.fn().mockReturnValue({ all });
    const prepare = vi.fn().mockReturnValue({ bind, all });
    const database = { prepare } as unknown as D1Database;

    const result = await executeSql(database, { sql: "SELECT id, active FROM users WHERE name = ?", params: ["Ada"] }, "normal");
    expect(result).toMatchObject({ type: "rows", columns: ["id", "active"], rowCount: 1 });
    expect(bind).toHaveBeenCalledWith("Ada");
    expect(prepare).toHaveBeenCalledWith("SELECT id, active FROM users WHERE name = ?");
  });
});
