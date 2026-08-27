import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const env = () => {
  const all = vi.fn().mockResolvedValue({ results: [{ id: 1, name: "Ada" }] });
  const run = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 8 } });
  const bind = vi.fn().mockReturnValue({ all, run });
  const prepare = vi.fn().mockReturnValue({ all, bind, run });
  return {
    DB: { prepare } as unknown as Env["DB"],
    ASSETS: { fetch: vi.fn(async () => new Response("console")) } as unknown as Env["ASSETS"],
    SQL_NORMAL_PASSWORD: "normal-password",
    SQL_ADMIN_PASSWORD: "admin-password",
    AUTH_SECRET: "a-secret-that-is-long-enough-for-handler-tests-123456",
    prepare,
  };
};

const fetchWorker = worker.fetch as unknown as (
  request: Request,
  environment: Env,
  context: ExecutionContext,
) => Promise<Response>;

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

describe("HTTP API", () => {
  it("logs in and executes a read query with a bearer token", async () => {
    const runtime = env();
    const login = await fetchWorker(
      new Request("https://cf-sql.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "normal-password" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    expect(login.status).toBe(200);
    const loginBody = await json(login);

    const query = await fetchWorker(
      new Request("https://cf-sql.test/api/sql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${loginBody.token}`,
        },
        body: JSON.stringify({ sql: "SELECT id, name FROM users WHERE id = ?", params: [1] }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    expect(query.status).toBe(200);
    expect(await json(query)).toMatchObject({ ok: true, type: "rows", rowCount: 1 });
    expect(runtime.prepare).toHaveBeenCalledWith("SELECT id, name FROM users WHERE id = ?");
  });

  it("allows CRUD for the normal password but reserves DROP TABLE for admin", async () => {
    const runtime = env();
    const login = await fetchWorker(
      new Request("https://cf-sql.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "normal-password" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    const token = (await json(login)).token;
    const response = await fetchWorker(
      new Request("https://cf-sql.test/api/sql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ sql: "DELETE FROM users WHERE id = ?", params: [1] }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: true, type: "command" });

    const drop = await fetchWorker(
      new Request("https://cf-sql.test/api/sql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ sql: "DROP TABLE users" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    expect(drop.status).toBe(400);
    expect(await json(drop)).toMatchObject({ error: { code: "SQL_VALIDATION_ERROR" } });

    const adminLogin = await fetchWorker(
      new Request("https://cf-sql.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "admin-password" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    const adminToken = (await json(adminLogin)).token;
    const adminDrop = await fetchWorker(
      new Request("https://cf-sql.test/api/sql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ sql: "DROP TABLE users" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
   expect(adminDrop.status).toBe(200);
   expect(await json(adminDrop)).toMatchObject({ ok: true, type: "command" });

    const adminAlter = await fetchWorker(
      new Request("https://cf-sql.test/api/sql", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ sql: "ALTER TABLE users ADD COLUMN age INTEGER" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
   expect(adminAlter.status).toBe(200);
   expect(await json(adminAlter)).toMatchObject({ ok: true, type: "command" });
 });

  it("supports exporting table records via HTTP POST API", async () => {
    const schema = vi.fn().mockResolvedValue({
      results: [
        { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ],
    });
    const rows = vi.fn().mockResolvedValue({
      results: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
    });
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith("SELECT cid, name, type")) {
        return { all: schema };
      }
      return { all: rows };
    });
    const runtime = {
      DB: { prepare } as unknown as Env["DB"],
      ASSETS: { fetch: vi.fn(async () => new Response("console")) } as unknown as Env["ASSETS"],
      SQL_NORMAL_PASSWORD: "normal-password",
      SQL_ADMIN_PASSWORD: "admin-password",
      AUTH_SECRET: "a-secret-that-is-long-enough-for-handler-tests-123456",
    };
    const login = await fetchWorker(
      new Request("https://cf-sql.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "normal-password" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    const token = (await json(login)).token;

    const exportRes = await fetchWorker(
      new Request("https://cf-sql.test/api/records/export", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ table: "users" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    expect(exportRes.status).toBe(200);
    const exportBody = await json(exportRes);
    expect(exportBody).toMatchObject({ ok: true, type: "rows", rowCount: 2 });
    expect(exportBody.rows).toEqual([{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }]);
  });

  it("supports importing records into a table via HTTP POST API", async () => {
    const schema = vi.fn().mockResolvedValue({
      results: [
        { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ],
    });
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 10 } });
    const bind = vi.fn().mockReturnValue({ run });
    const batch = vi.fn().mockResolvedValue([]);
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith("SELECT cid, name, type")) {
        return { all: schema };
      }
      return { bind, run };
    });
    const runtime = {
      DB: { prepare, batch } as unknown as Env["DB"],
      ASSETS: { fetch: vi.fn(async () => new Response("console")) } as unknown as Env["ASSETS"],
      SQL_NORMAL_PASSWORD: "normal-password",
      SQL_ADMIN_PASSWORD: "admin-password",
      AUTH_SECRET: "a-secret-that-is-long-enough-for-handler-tests-123456",
    };
    const login = await fetchWorker(
      new Request("https://cf-sql.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "normal-password" }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    const token = (await json(login)).token;

    const importRes = await fetchWorker(
      new Request("https://cf-sql.test/api/records/import", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ table: "users", records: [{ name: "Charlie" }, { name: "David" }] }),
      }),
      runtime,
      {} as ExecutionContext,
    );
    expect(importRes.status).toBe(200);
    const importBody = await json(importRes);
    expect(importBody).toMatchObject({ ok: true, count: 2 });
    expect(batch).toHaveBeenCalled();
  });
});
