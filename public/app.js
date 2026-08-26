const SESSION_KEY = "cf-sql-session";
const HISTORY_KEY = "cf-sql-history";
const THEME_KEY = "cf-sql-theme";

const state = {
  session: loadSession(),
  tables: [],
  activeTable: null,
  lastResult: null,
  toastTimer: null,
};

const elements = {
  loginScreen: document.querySelector("#login-screen"),
  consoleScreen: document.querySelector("#console-screen"),
  loginForm: document.querySelector("#login-form"),
  loginButton: document.querySelector("#login-button"),
  loginLabel: document.querySelector("#login-label"),
  loginSpinner: document.querySelector("#login-spinner"),
  loginError: document.querySelector("#login-error"),
  passwordInput: document.querySelector("#password-input"),
  togglePassword: document.querySelector("#toggle-password"),
  logoutButton: document.querySelector("#logout-button"),
  themeToggle: document.querySelector("#theme-toggle"),
  roleLabel: document.querySelector("#role-label"),
  workspaceSubtitle: document.querySelector("#workspace-subtitle"),
  refreshSchema: document.querySelector("#refresh-schema"),
  tableSearch: document.querySelector("#table-search"),
  tableList: document.querySelector("#table-list"),
  tableEmpty: document.querySelector("#table-empty"),
  sqlEditor: document.querySelector("#sql-editor"),
  paramsInput: document.querySelector("#params-input"),
  runQuery: document.querySelector("#run-query"),
  querySpinner: document.querySelector("#query-spinner"),
  clearEditor: document.querySelector("#clear-editor"),
  statementMode: document.querySelector("#statement-mode"),
  resultsEmpty: document.querySelector("#results-empty"),
  commandResult: document.querySelector("#command-result"),
  commandSummary: document.querySelector("#command-summary"),
  resultsTableWrap: document.querySelector("#results-table-wrap"),
  resultsTable: document.querySelector("#results-table"),
  resultSummary: document.querySelector("#result-summary"),
  exportButton: document.querySelector("#export-button"),
  historyList: document.querySelector("#history-list"),
  historyEmpty: document.querySelector("#history-empty"),
  clearHistory: document.querySelector("#clear-history"),
  inspectorTitle: document.querySelector("#inspector-title"),
  columnList: document.querySelector("#column-list"),
  toast: document.querySelector("#toast"),
};

function loadSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (value?.token && value?.expiresAt > Date.now()) {
      return value;
    }
  } catch {
    // 损坏的会话只影响本地 UI 状态，不阻止重新登录。
  }
  sessionStorage.removeItem(SESSION_KEY);
  return null;
}

function saveSession(session) {
  state.session = session;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  state.session = null;
  state.activeTable = null;
  sessionStorage.removeItem(SESSION_KEY);
}

function setLoginError(message = "") {
  elements.loginError.textContent = message;
  elements.loginError.hidden = !message;
}

function setLoginLoading(loading) {
  elements.loginButton.disabled = loading;
  elements.loginSpinner.hidden = !loading;
  elements.loginLabel.textContent = loading ? "连接中…" : "进入控制台";
}

function showConsole() {
  elements.loginScreen.hidden = true;
  elements.consoleScreen.hidden = false;
  const isAdmin = state.session?.role === "admin";
  elements.roleLabel.textContent = isAdmin ? "admin 访问" : "普通访问";
  elements.workspaceSubtitle.textContent = isAdmin
    ? "admin 会话已就绪，可以执行 CRUD、删表和其他结构操作。"
    : "普通会话已就绪，可以执行记录级增删改查。";
  renderHistory();
  loadSchema();
}

function showLogin() {
  elements.consoleScreen.hidden = true;
  elements.loginScreen.hidden = false;
  elements.passwordInput.focus();
}

function getErrorMessage(data, fallback) {
  const error = data?.error;
  if (error?.details) return `${error.message ?? fallback}：${error.details}`;
  return error?.message ?? fallback;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("content-type", "application/json");
  if (state.session?.token) {
    headers.set("authorization", `Bearer ${state.session.token}`);
  }

  const response = await fetch(path, { ...options, headers });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // 非 JSON 的静态响应会在下面按 HTTP 状态处理。
  }
  if (!response.ok) {
    if (response.status === 401 && state.session) {
      clearSession();
      showLogin();
    }
    throw new Error(getErrorMessage(data, `请求失败（${response.status}）`));
  }
  return data;
}

function setBusy(button, spinner, busy) {
  button.disabled = busy;
  spinner.hidden = !busy;
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3500);
}

function escapeIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function renderTableList() {
  const search = elements.tableSearch.value.trim().toLowerCase();
  const tables = state.tables.filter((table) => table.name.toLowerCase().includes(search));
  elements.tableList.replaceChildren();
  elements.tableEmpty.hidden = state.tables.length > 0 || search.length > 0;

  if (state.tables.length === 0) return;
  if (tables.length === 0) {
    const empty = document.createElement("div");
    empty.className = "small-empty";
    empty.textContent = "没有匹配的数据表";
    elements.tableList.append(empty);
    return;
  }

  for (const table of tables) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `table-item${state.activeTable === table.name ? " active" : ""}`;
    item.dataset.table = table.name;
    const icon = document.createElement("span");
    icon.className = "table-kind";
    icon.textContent = table.type === "view" ? "◈" : "▦";
    const name = document.createElement("span");
    name.textContent = table.name;
    item.append(icon, name);
    item.addEventListener("click", () => selectTable(table.name));
    elements.tableList.append(item);
  }
}

async function loadSchema() {
  elements.refreshSchema.disabled = true;
  try {
    const data = await api("/api/schema", { method: "POST", body: "{}" });
    state.tables = Array.isArray(data.tables) ? data.tables : [];
    renderTableList();
    if (state.activeTable && state.tables.some((table) => table.name === state.activeTable)) {
      await loadTableSchema(state.activeTable);
    } else {
      state.activeTable = null;
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.refreshSchema.disabled = false;
  }
}

async function selectTable(tableName) {
  state.activeTable = tableName;
  renderTableList();
  elements.sqlEditor.value = `SELECT *\nFROM ${escapeIdentifier(tableName)}\nLIMIT 100;`;
  updateStatementMode();
  await loadTableSchema(tableName);
}

async function loadTableSchema(tableName) {
  elements.inspectorTitle.textContent = tableName;
  elements.columnList.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "small-empty";
  loading.textContent = "加载列定义…";
  elements.columnList.append(loading);
  try {
    const data = await api("/api/schema", { method: "POST", body: JSON.stringify({ table: tableName }) });
    elements.columnList.replaceChildren();
    if (!data.columns?.length) {
      const empty = document.createElement("div");
      empty.className = "small-empty";
      empty.textContent = "没有可显示的列定义。";
      elements.columnList.append(empty);
      return;
    }
    for (const column of data.columns) {
      const row = document.createElement("div");
      row.className = "column-row";
      const name = document.createElement("span");
      name.className = "column-name";
      name.textContent = column.name;
      const type = document.createElement("span");
      type.className = "column-type";
      type.textContent = column.type || "ANY";
      const pk = document.createElement("span");
      pk.className = "column-pk";
      pk.textContent = column.pk ? "PK" : "";
      row.append(name, type, pk);
      elements.columnList.append(row);
    }
  } catch (error) {
    elements.columnList.replaceChildren();
    const failure = document.createElement("div");
    failure.className = "small-empty";
    failure.textContent = error.message;
    elements.columnList.append(failure);
  }
}

function updateStatementMode() {
  const sql = elements.sqlEditor.value.trim().toLowerCase();
  const isRead = /^(select|values|explain|pragma\s+(?:(?:main|temp)\.)?(?:table_info|table_xinfo|index_list|index_info|foreign_key_list|database_list)\b)/.test(sql);
  const isCrud = /^(insert|update|delete|replace)\b/.test(sql);
  const isWith = /^with\b/.test(sql);
  elements.statementMode.textContent = sql ? (isRead ? "READ" : isCrud ? "CRUD" : isWith ? "WITH" : "ADMIN") : "READY";
  elements.statementMode.classList.toggle("write", Boolean(sql) && !isRead);
}

function parseParams() {
  const raw = elements.paramsInput.value.trim();
  if (!raw) return [];
  let params;
  try {
    params = JSON.parse(raw);
  } catch {
    throw new Error("绑定参数必须是合法 JSON 数组");
  }
  if (!Array.isArray(params)) throw new Error("绑定参数必须是 JSON 数组");
  return params;
}

function setResultVisibility(type) {
  elements.resultsEmpty.hidden = type !== "empty";
  elements.commandResult.hidden = type !== "command";
  elements.resultsTableWrap.hidden = type !== "rows";
}

function formatValue(value) {
  if (value === null || value === undefined) return { text: "NULL", className: "null-value" };
  if (typeof value === "number") return { text: String(value), className: "number-value" };
  if (typeof value === "object") {
    try { return { text: JSON.stringify(value), className: "" }; } catch { return { text: "[无法显示]", className: "null-value" }; }
  }
  return { text: String(value), className: "" };
}

function renderRows(result) {
  const head = elements.resultsTable.querySelector("thead");
  const body = elements.resultsTable.querySelector("tbody");
  head.replaceChildren();
  body.replaceChildren();
  const headerRow = document.createElement("tr");
  for (const column of result.columns ?? []) {
    const cell = document.createElement("th");
    cell.textContent = column;
    headerRow.append(cell);
  }
  head.append(headerRow);
  for (const row of result.rows ?? []) {
    const rowElement = document.createElement("tr");
    for (const column of result.columns ?? []) {
      const cell = document.createElement("td");
      const value = formatValue(row[column]);
      cell.textContent = value.text;
      if (value.className) cell.classList.add(value.className);
      cell.title = value.text;
      rowElement.append(cell);
    }
    body.append(rowElement);
  }
}

function renderResult(result) {
  state.lastResult = result;
  if (result.type === "rows") {
    setResultVisibility("rows");
    renderRows(result);
    elements.resultSummary.textContent = `${result.rowCount} 行 · ${result.meta?.durationMs ?? 0} ms`;
    elements.exportButton.disabled = result.rowCount === 0;
    return;
  }
  setResultVisibility("command");
  const changes = result.meta?.changes;
  const suffix = changes === null || changes === undefined ? "写操作已完成。" : `影响 ${changes} 行 · ${result.meta?.durationMs ?? 0} ms`;
  elements.commandSummary.textContent = suffix;
  elements.resultSummary.textContent = `${changes ?? 0} 行受影响 · ${result.meta?.durationMs ?? 0} ms`;
  elements.exportButton.disabled = true;
}

function loadHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(history) ? history.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(sql) {
  const history = [sql, ...loadHistory().filter((item) => item !== sql)].slice(0, 20);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  const history = loadHistory();
  elements.historyList.replaceChildren();
  elements.historyEmpty.hidden = history.length > 0;
  for (const [index, sql] of history.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    const number = document.createElement("span");
    number.className = "history-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const text = document.createElement("span");
    text.className = "history-sql";
    text.textContent = sql.replace(/\s+/g, " ").trim();
    item.append(number, text);
    item.title = sql;
    item.addEventListener("click", () => {
      elements.sqlEditor.value = sql;
      updateStatementMode();
      elements.sqlEditor.focus();
    });
    elements.historyList.append(item);
  }
}

async function runQuery() {
  const sql = elements.sqlEditor.value.trim();
  if (!sql) {
    showToast("请先输入 SQL", true);
    elements.sqlEditor.focus();
    return;
  }
  let params;
  try {
    params = parseParams();
  } catch (error) {
    showToast(error.message, true);
    return;
  }

  setBusy(elements.runQuery, elements.querySpinner, true);
  elements.resultSummary.textContent = "执行中…";
  try {
    const result = await api("/api/sql", { method: "POST", body: JSON.stringify({ sql, params }) });
    renderResult(result);
    saveHistory(sql);
  } catch (error) {
    setResultVisibility("empty");
    elements.exportButton.disabled = true;
    elements.resultSummary.textContent = "执行失败";
    showToast(error.message, true);
  } finally {
    elements.runQuery.disabled = false;
    elements.querySpinner.hidden = true;
  }
}

function csvValue(value) {
  const formatted = formatValue(value).text;
  return `"${formatted.replaceAll('"', '""')}"`;
}

function exportCsv() {
  const result = state.lastResult;
  if (!result || result.type !== "rows" || !result.rowCount) return;
  const lines = [result.columns.map(csvValue).join(",")];
  for (const row of result.rows) lines.push(result.columns.map((column) => csvValue(row[column])).join(","));
  const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cf-sql-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function applyTheme() {
  const theme = localStorage.getItem(THEME_KEY);
  if (theme === "light") document.body.dataset.theme = "light";
}

function toggleTheme() {
  const light = document.body.dataset.theme === "light";
  if (light) {
    delete document.body.dataset.theme;
    localStorage.setItem(THEME_KEY, "dark");
  } else {
    document.body.dataset.theme = "light";
    localStorage.setItem(THEME_KEY, "light");
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginError();
  const password = elements.passwordInput.value;
  if (!password) {
    setLoginError("请输入访问密码。");
    return;
  }
  setLoginLoading(true);
  try {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
    saveSession({ token: data.token, role: data.role, expiresAt: data.expiresAt });
    elements.passwordInput.value = "";
    showConsole();
  } catch (error) {
    setLoginError(error.message);
  } finally {
    setLoginLoading(false);
  }
});

elements.togglePassword.addEventListener("click", () => {
  const visible = elements.passwordInput.type === "text";
  elements.passwordInput.type = visible ? "password" : "text";
  elements.togglePassword.title = visible ? "显示密码" : "隐藏密码";
  elements.togglePassword.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
});

elements.logoutButton.addEventListener("click", () => {
  clearSession();
  showLogin();
  showToast("已安全退出");
});
elements.themeToggle.addEventListener("click", toggleTheme);
elements.refreshSchema.addEventListener("click", loadSchema);
elements.tableSearch.addEventListener("input", renderTableList);
elements.runQuery.addEventListener("click", runQuery);
elements.clearEditor.addEventListener("click", () => {
  elements.sqlEditor.value = "";
  elements.paramsInput.value = "";
  updateStatementMode();
  elements.sqlEditor.focus();
});
elements.sqlEditor.addEventListener("input", updateStatementMode);
elements.sqlEditor.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runQuery();
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const start = elements.sqlEditor.selectionStart;
    const end = elements.sqlEditor.selectionEnd;
    elements.sqlEditor.setRangeText("  ", start, end, "end");
  }
});
elements.exportButton.addEventListener("click", exportCsv);
elements.clearHistory.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

applyTheme();
updateStatementMode();
if (state.session) {
  showConsole();
} else {
  showLogin();
}
