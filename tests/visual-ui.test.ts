import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../", import.meta.url);

function readProjectFile(path: string): string {
  return readFileSync(new URL(path, projectRoot), "utf8");
}

describe("visual console interaction contract", () => {
  it("does not force local development to wait on a remote D1 binding", () => {
    const config = readProjectFile("wrangler.jsonc");
    expect(config).not.toMatch(/"remote"\s*:\s*true/);
  });

  it("lets the create-table handler show validation errors instead of native silent blocking", () => {
    const html = readProjectFile("public/index.html");
    const app = readProjectFile("public/app.js");
    expect(html).toMatch(/<form[^>]+id="table-form"[^>]+novalidate/);
    expect(app).toMatch(/function saveTable\(event\)[\s\S]*?event\.preventDefault\(\)/);
    expect(app).toMatch(/function saveTable\(event\)[\s\S]*?请填写有效的表名/);
  });

  it("keeps the create-table action available to normal sessions", () => {
    const app = readProjectFile("public/app.js");
    const dialogHandler = app.slice(app.indexOf("function openTableDialog"), app.indexOf("async function saveTable"));
    expect(app).not.toMatch(/elements\.createTableButton\.disabled = !isAdmin/);
    expect(app).not.toMatch(/elements\.welcomeCreateButton\.disabled = !isAdmin/);
    expect(dialogHandler).not.toContain('state.session?.role !== "admin"');
    expect(app).toMatch(/只有 admin 密码可以删除数据表/);
  });

  it("exposes a second SQL execution mode beside the visual actions", () => {
    const html = readProjectFile("public/index.html");
    const app = readProjectFile("public/app.js");
    expect(html).toMatch(/id="sql-command-form"/);
    expect(html).toMatch(/id="sql-command-input"/);
   expect(html).toMatch(/id="execute-sql-button"/);
   expect(app).toMatch(/function executeSqlCommand\(event\)[\s\S]*?api\("\/api\/sql"/);
   expect(app).toMatch(/elements\.sqlCommandForm\.addEventListener\("submit", executeSqlCommand\)/);
 });

  it("supports visual import and export buttons and dialogs", () => {
    const html = readProjectFile("public/index.html");
    const app = readProjectFile("public/app.js");
    expect(html).toMatch(/id="import-records-button"/);
    expect(html).toMatch(/id="export-records-button"/);
    expect(html).toMatch(/id="import-dialog"/);
    expect(html).toMatch(/id="export-dialog"/);
    expect(html).toMatch(/id="export-csv-btn"/);
    expect(html).toMatch(/id="export-json-btn"/);
    expect(app).toMatch(/function exportToCsv\(/);
    expect(app).toMatch(/function exportToJson\(/);
    expect(app).toMatch(/function parseCsvText\(/);
    expect(app).toMatch(/function parseJsonText\(/);
  });
});
