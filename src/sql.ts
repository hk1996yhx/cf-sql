import type { AccessRole } from "./auth";

export const MAX_SQL_LENGTH = 100_000;
export const MAX_PARAMETER_COUNT = 100;

export type SqlParameter = string | number | null;
export type SqlStatementType = "read" | "crud" | "admin";

export interface SqlRequest {
  sql: unknown;
  params?: unknown;
}

export interface SqlExecutionResult {
  type: "rows" | "command";
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  meta: {
    durationMs: number;
    changes?: number | null;
    lastRowId?: number | null;
  };
}

export interface SchemaTable {
  name: string;
  type: string;
  sql: string | null;
}

export interface SchemaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlValidationError";
  }
}

export class SqlExecutionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SqlExecutionError";
  }
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function skipQuotedText(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

interface SqlScan {
  topLevelTokens: string[];
  separators: number[];
}

function scanSql(sql: string): SqlScan {
  const topLevelTokens: string[] = [];
  const separators: number[] = [];
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(index + 2, sql.length);
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const quote = character === "[" ? "]" : character;
      index = skipQuotedText(sql, index, quote);
      continue;
    }
    if (character === ";") {
      separators.push(index);
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < sql.length && isIdentifierPart(sql[end])) {
        end += 1;
      }
      if (depth === 0) {
        topLevelTokens.push(sql.slice(index, end).toLowerCase());
      }
      index = end;
      continue;
    }
    index += 1;
  }

  return { topLevelTokens, separators };
}

function hasMeaningfulSql(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    if (/\s/.test(sql[index])) {
      index += 1;
      continue;
    }
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    return true;
  }
  return false;
}

/** 校验 SQL 长度和单语句约束，避免一次请求隐式执行多条语句。 */
export function validateSql(sql: unknown): string {
  if (typeof sql !== "string") {
    throw new SqlValidationError("sql 必须是字符串");
  }
  const normalizedSql = sql.trim();
  if (normalizedSql.length === 0) {
    throw new SqlValidationError("sql 不能为空");
  }
  if (normalizedSql.length > MAX_SQL_LENGTH) {
    throw new SqlValidationError(`sql 长度不能超过 ${MAX_SQL_LENGTH} 个字符`);
  }

  const { separators } = scanSql(normalizedSql);
  if (separators.length > 0 && hasMeaningfulSql(normalizedSql.slice(separators[0] + 1))) {
    throw new SqlValidationError("每次请求只能执行一条 SQL 语句");
  }
  return normalizedSql;
}

function isSafePragma(sql: string): boolean {
  return /^pragma\s+(?:(?:main|temp)\.)?(?:table_info|table_xinfo|index_list|index_info|foreign_key_list|database_list)\s*(?:\(|;|$)/i.test(
    sql,
  );
}

function classifyValidatedSql(sql: string): SqlStatementType {
  const { topLevelTokens } = scanSql(sql);
  const firstKeyword = topLevelTokens[0];
  if (!firstKeyword) {
    throw new SqlValidationError("无法识别 SQL 语句");
  }

  if (firstKeyword === "select" || firstKeyword === "values" || firstKeyword === "explain") {
    return "read";
  }
  if (firstKeyword === "pragma") {
    return isSafePragma(sql) ? "read" : "admin";
  }
  if (["insert", "update", "delete", "replace"].includes(firstKeyword)) {
    return "crud";
  }
  if (firstKeyword === "with") {
    const mainKeyword = topLevelTokens.slice(1).find((keyword) =>
      ["select", "values", "insert", "update", "delete", "replace"].includes(keyword),
    );
    if (mainKeyword === "select" || mainKeyword === "values") {
      return "read";
    }
    if (["insert", "update", "delete", "replace"].includes(mainKeyword ?? "")) {
      return "crud";
    }
    return "admin";
  }
  return "admin";
}

/** 将 SQL 分类为查询、记录级 CRUD 或管理员结构操作。 */
export function classifySql(sql: unknown): SqlStatementType {
  return classifyValidatedSql(validateSql(sql));
}

function normalizeParameters(params: unknown): SqlParameter[] {
  if (params === undefined) {
    return [];
  }
  if (!Array.isArray(params)) {
    throw new SqlValidationError("params 必须是数组");
  }
  if (params.length > MAX_PARAMETER_COUNT) {
    throw new SqlValidationError(`params 不能超过 ${MAX_PARAMETER_COUNT} 个`);
  }

  return params.map((parameter, index) => {
    if (parameter === null || typeof parameter === "string") {
      return parameter;
    }
    if (typeof parameter === "number" && Number.isFinite(parameter)) {
      return parameter;
    }
    if (typeof parameter === "boolean") {
      return parameter ? 1 : 0;
    }
    throw new SqlValidationError(`params[${index}] 只能是字符串、数字、布尔值或 null`);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }
  return columns;
}

/** 执行单条 D1 语句，并将查询和写操作统一为控制台可消费的结果结构。 */
export async function executeSql(
  database: D1Database,
  request: SqlRequest,
  role: AccessRole,
): Promise<SqlExecutionResult> {
  const sql = validateSql(request.sql);
  const statementType = classifyValidatedSql(sql);
  if (role === "normal" && statementType === "admin") {
    throw new SqlValidationError("普通密码只能执行增删改查；删表、建表、改表等结构操作请使用 admin 密码");
  }
  const params = normalizeParameters(request.params);
  const startedAt = Date.now();

  try {
    const prepared = database.prepare(sql);
    const statement = params.length > 0 ? prepared.bind(...params) : prepared;

    if (statementType === "read") {
      const result = await statement.all<Record<string, unknown>>();
      const rows = (result.results ?? []) as Array<Record<string, unknown>>;
      return {
        type: "rows",
        columns: getColumns(rows),
        rows,
        rowCount: rows.length,
        meta: { durationMs: Date.now() - startedAt },
      };
    }

    const result = await statement.run();
    const changes = result.meta?.changes ?? null;
    const lastRowId = result.meta?.last_row_id ?? null;
    return {
      type: "command",
      columns: [],
      rows: [],
      rowCount: changes ?? 0,
      meta: {
        durationMs: Date.now() - startedAt,
        changes,
        lastRowId,
      },
    };
  } catch (error) {
    throw new SqlExecutionError(getErrorMessage(error), error);
  }
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.length > 128 || identifier.includes("\u0000")) {
    throw new SqlValidationError("表名长度无效");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** 读取可视化页面所需的表清单或指定表的列定义，表名始终按标识符转义。 */
export async function readSchema(database: D1Database, table?: string): Promise<
  { tables: SchemaTable[] } | { table: string; columns: SchemaColumn[] }
> {
  try {
    if (table === undefined) {
      const result = await database
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all<SchemaTable>();
      return { tables: (result.results ?? []) as SchemaTable[] };
    }

    if (typeof table !== "string") {
      throw new SqlValidationError("table 必须是字符串");
    }
    const result = await database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<SchemaColumn>();
    return { table, columns: (result.results ?? []) as SchemaColumn[] };
  } catch (error) {
    if (error instanceof SqlValidationError) {
      throw error;
    }
    throw new SqlExecutionError(getErrorMessage(error), error);
  }
}
