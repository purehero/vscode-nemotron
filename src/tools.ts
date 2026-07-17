// AI가 워크스페이스 파일을 조회/읽기/쓰기 할 수 있게 해주는 도구 모음.
// 지시 기반(ReAct) 프로토콜: 모델이 ```tool {json} ``` 블록을 출력하면 실행한다.

import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import { PersistentShell, detectShell } from "./shell";

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  ok: boolean;
  /** 모델에 다시 전달할 전체 결과 */
  output: string;
  /** UI 표시용 짧은 미리보기 */
  preview: string;
}

export const TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "apply_bytes",
  "run_command",
  "get_diagnostics",
  "search_text",
  "list_symbols",
  "find_definition",
  "find_references",
  "update_plan",
  "run_agent",
  "remember",
  "update_memory",
  "forget",
] as const;

/** sub-agent 정의 (설정 nemotron.agents) */
export interface AgentDef {
  name: string;
  model: string;
  description?: string;
  systemPrompt?: string;
  /** "image" 면 텍스트→이미지 생성 모델 (결과를 파일로 저장) */
  type?: "chat" | "image";
}

export function getAgents(): AgentDef[] {
  const raw = vscode.workspace
    .getConfiguration("nemotron")
    .get<AgentDef[]>("agents", []);
  return raw.filter((a) => a && a.name && a.model);
}

/** sub-agent 사용법 안내 (설정에 따라 동적 생성, 시스템 프롬프트에 덧붙임) */
export function agentInstruction(): string {
  const list = getAgents();
  if (list.length === 0) {
    return "";
  }
  return [
    "",
    "You can delegate sub-tasks to specialized helper AIs (sub-agents):",
    "",
    "```tool",
    "run_agent",
    "agent: coder",
    "<<<TASK",
    "Description of the task to delegate (the sub-agent does not know this conversation's context, so include all necessary code/information)",
    "<<<END",
    "```",
    "",
    "Available sub-agents:",
    ...list.map(
      (a) =>
        `- ${a.name} (${a.model})${a.type === "image" ? " [image generation]" : ""}${
          a.description ? " : " + a.description : ""
        }`
    ),
    "",
    "sub-agent rules:",
    "- Delegating sub-tasks that require expertise (e.g. complex algorithms, math proofs, large summaries) improves quality.",
    "- Results come back as a tool result. Review and revise them, then incorporate them into your final answer.",
    "- Handle simple tasks yourself; delegate only when it adds value.",
    "- An [image generation] agent uses TASK as the image prompt (the more detailed the English prompt, the better). The generated image is saved as a workspace file and its path is returned.",
  ].join("\n");
}

const MAX_LIST = 500;
const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT = 20_000;

/** 모델에 주입할 도구 사용 안내 (시스템 프롬프트에 덧붙인다). */
export const TOOL_INSTRUCTION = [
  "You have access to tools that can read and modify files in the user's working folder (workspace).",
  "When you need a tool, output a code block in the format below (multiple are allowed). The first line is the tool name:",
  "",
  "```tool",
  "tool_name",
  "key: value",
  "```",
  "",
  "★ Important: for multi-line text such as code, do NOT put it inside a JSON string; write it 'as is' in the delimiter blocks below.",
  "  (Do not escape quotes/newlines. JSON often breaks on multi-line content.)",
  "",
  "Examples:",
  "",
  "```tool",
  "read_file",
  "path: app.py",
  "```",
  "",
  "```tool",
  "list_files",
  "glob: **/*.py",
  "```",
  "",
  "```tool",
  "edit_file",
  "path: app.py",
  "<<<OLD",
  "existing code that matches exactly (including indentation)",
  "<<<NEW",
  "the new replacement code",
  "<<<END",
  "```",
  "",
  "```tool",
  "write_file",
  "path: hello.py",
  "<<<CONTENT",
  'print("hi")',
  "<<<END",
  "```",
  "",
  "```tool",
  "run_command",
  "command: python app.py",
  "```",
  "",
  "```tool",
  "get_diagnostics",
  "path: app.py",
  "```",
  "",
  "```tool",
  "search_text",
  "query: def _start_generation",
  "glob: **/*.py",
  "```",
  "",
  "If the content has many special characters or is too long to pass inline, you can save the before/after content to files and apply it byte by byte:",
  "",
  "```tool",
  "write_file",
  "path: .nemotron/old.txt",
  "<<<CONTENT",
  "existing content that matches the original exactly",
  "<<<END",
  "```",
  "```tool",
  "write_file",
  "path: .nemotron/new.txt",
  "<<<CONTENT",
  "the new replacement content",
  "<<<END",
  "```",
  "```tool",
  "apply_bytes",
  "path: app.py",
  "old_file: .nemotron/old.txt",
  "new_file: .nemotron/new.txt",
  "```",
  "",
  "Available tools:",
  "- list_files : list files. keys: glob (optional), max (optional)",
  "- read_file  : read a file. key: path",
  "- edit_file  : partial edit. keys: path, replace_all (optional), plus <<<OLD / <<<NEW / <<<END blocks",
  "- apply_bytes: 'byte-level' partial edit using files that hold the before/after content. keys: path, old_file, new_file, replace_all (optional)",
  "- write_file : create/replace entirely. keys: path, plus <<<CONTENT / <<<END block",
  detectShell().kind === "bash"
    ? "- run_command: run a command and inspect its output. key: command (bash shell — use POSIX syntax like ls, cat, grep, $VAR, &&, |)"
    : "- run_command: run a command and inspect its output. key: command (Windows cmd.exe — use dir, type, %VAR% syntax. POSIX commands like ls/cat/grep do not work)",
  "- get_diagnostics: the editor's error/warning list (Problems). key: path (optional; whole workspace if omitted)",
  "- search_text : search file contents (grep). keys: query, glob (optional), regex (optional true), max (optional)",
  "- list_symbols : symbol list (language server). key: path (document symbol tree) or query (workspace symbol search)",
  "- find_definition: a symbol's definition location (language server). keys: path, symbol, line (optional, 1-based hint)",
  "- find_references: a symbol's references (language server). keys: path, symbol, line (optional, 1-based hint)",
  "- update_plan : create/update a task plan (checklist). In the <<<PLAN / <<<END block, one line each: '[x] completed step' or '[ ] remaining step'",
  "",
  "Task plan example:",
  "",
  "```tool",
  "update_plan",
  "<<<PLAN",
  "[x] Explore relevant files",
  "[ ] Fix the root cause of the bug",
  "[ ] Verify by running tests",
  "<<<END",
  "```",
  "",
  "Rules:",
  "- When you call a tool, output only that code block and wait for the result.",
  "- You may call multiple tools at once.",
  "- **To modify part of an existing file, you MUST use edit_file (or apply_bytes); do not rewrite the whole file with write_file.**",
  "- Prefer edit_file by default; use file-based apply_bytes only when the content is very long or collides with delimiters like <<<END.",
  "- The OLD block of edit_file (or the old_file of apply_bytes) must match the file content exactly, including whitespace/indentation, and include enough surrounding context to be unique in the file.",
  "- To change several places at once, use replace_all: true.",
  "- When locating code, use search_text before reading an entire file.",
  "- To find a symbol's definition/references, prefer find_definition/find_references over search_text (they are language-server based and accurate). Use list_symbols to understand file structure.",
  "- For complex work needing 3+ steps, create a plan with update_plan at the start, and update it with update_plan as you finish each step. Before declaring 'Task completed.', make sure every item is [x].",
  "- Check syntax/type errors with get_diagnostics first (no execution needed). Use run_command only when you need runtime results.",
  "- get_diagnostics is accurate only when the relevant language extension (e.g. Python=Pylance) is installed. If diagnostics are empty but you suspect a syntax error, check directly with run_command (e.g. python -m py_compile file.py).",
  "- GDScript (.gd) is handled automatically by get_diagnostics: it uses Godot editor (LSP) diagnostics first, and falls back to the godot CLI (--check-only) for syntax checking.",
  "- To confirm an error by running code, view the output with run_command, then fix it with edit_file.",
  "- Once you have enough information from the results, write the final answer without tools. Respond in the user's language.",
  "- **When you have finished all tool-based work, you MUST end your response with the declaration 'Task completed.' followed by a summary. Without it the system assumes the work is unfinished and will ask you to continue.**",
  "- If you need a user decision mid-task, end your response with a question that finishes with a question mark (?).",
  "- Always use workspace-relative paths.",
  "- edit_file / write_file / run_command may require user approval.",
].join("\n");

function isToolName(s: any): boolean {
  return typeof s === "string" && (TOOL_NAMES as readonly string[]).includes(s);
}

/**
 * 모델 출력에서 ```tool ...``` 블록을 파싱한다.
 * - 라인 형식(첫 줄=도구명, key:값, <<<OLD/<<<NEW/<<<END, <<<CONTENT/<<<END): 이스케이프 불필요, 견고함
 * - JSON 형식({"name":...,"args":...}): 하위 호환
 * 닫는 펜스(```) 는 자체 줄로 인식하므로 코드 내부의 인라인 백틱에 영향받지 않는다.
 */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^\s*```([a-zA-Z]*)\s*$/);
    if (!open) {
      i++;
      continue;
    }
    const tag = open[1].toLowerCase();
    i++;
    const block: string[] = [];
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
      block.push(lines[i]);
      i++;
    }
    i++; // 닫는 펜스(또는 EOF) 건너뛰기
    const call = parseBlock(tag, block);
    if (call) {
      calls.push(call);
    }
  }
  return calls;
}

function parseBlock(tag: string, lines: string[]): ToolCall | null {
  const body = lines.join("\n").trim();
  if (!body) {
    return null;
  }

  // JSON 형식 (하위 호환)
  if (body.startsWith("{")) {
    try {
      const obj = JSON.parse(body);
      if (obj && isToolName(obj.name)) {
        return { name: obj.name, args: obj.args ?? {} };
      }
    } catch {
      /* 라인 형식으로 처리 시도하지 않음 */
    }
    return null;
  }

  // 라인 형식은 tool 태그일 때만
  if (tag !== "tool") {
    return null;
  }

  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === "") {
    idx++;
  }
  const name = idx < lines.length ? lines[idx].trim() : "";
  if (!isToolName(name)) {
    return null;
  }
  idx++;

  const args: Record<string, any> = {};
  let section: "old" | "new" | "content" | "task" | "plan" | null = null;
  const oldBuf: string[] = [];
  const newBuf: string[] = [];
  const contentBuf: string[] = [];
  const taskBuf: string[] = [];
  const planBuf: string[] = [];
  let hasOld = false;
  let hasNew = false;
  let hasContent = false;
  let hasTask = false;
  let hasPlan = false;

  for (; idx < lines.length; idx++) {
    const line = lines[idx];
    const marker = line.trim();
    if (marker === "<<<OLD") {
      section = "old";
      hasOld = true;
      continue;
    }
    if (marker === "<<<NEW") {
      section = "new";
      hasNew = true;
      continue;
    }
    if (marker === "<<<CONTENT") {
      section = "content";
      hasContent = true;
      continue;
    }
    if (marker === "<<<TASK") {
      section = "task";
      hasTask = true;
      continue;
    }
    if (marker === "<<<PLAN") {
      section = "plan";
      hasPlan = true;
      continue;
    }
    if (marker === "<<<END") {
      section = null;
      continue;
    }
    if (section === "old") {
      oldBuf.push(line);
      continue;
    }
    if (section === "new") {
      newBuf.push(line);
      continue;
    }
    if (section === "content") {
      contentBuf.push(line);
      continue;
    }
    if (section === "task") {
      taskBuf.push(line);
      continue;
    }
    if (section === "plan") {
      planBuf.push(line);
      continue;
    }
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*:\s?(.*)$/);
    if (kv) {
      const key = kv[1];
      const raw = kv[2];
      if (key === "replace_all" || key === "regex") {
        args[key] = /^\s*true\s*$/i.test(raw);
      } else if (key === "max") {
        args[key] = Number(raw.trim());
      } else {
        args[key] = raw.trim();
      }
    }
  }

  if (hasOld) {
    args.old_string = oldBuf.join("\n");
  }
  if (hasNew) {
    args.new_string = newBuf.join("\n");
  }
  if (hasContent) {
    args.content = contentBuf.join("\n");
  }
  if (hasTask) {
    args.task = taskBuf.join("\n");
  }
  if (hasPlan) {
    args.plan = planBuf.join("\n");
  }
  return { name, args };
}

/** 모델이 도구를 호출하려 시도했는지(형식이 깨졌어도) 감지한다. */
export function hasToolAttempt(text: string): boolean {
  if (/^\s*```tool\s*$/m.test(text)) {
    return true;
  }
  return (
    text.includes('"name"') &&
    (TOOL_NAMES as readonly string[]).some((n) => text.includes(`"${n}"`))
  );
}

function workspaceRoot(): vscode.Uri {
  const r = vscode.workspace.workspaceFolders?.[0];
  if (!r) {
    throw new Error("No open working folder (workspace).");
  }
  return r.uri;
}

/** 워크스페이스 밖으로 벗어나는 경로를 차단한다. */
function safeUri(rel: string): vscode.Uri {
  if (typeof rel !== "string" || !rel.trim()) {
    throw new Error("A path is required.");
  }
  const base = workspaceRoot();
  const uri = vscode.Uri.joinPath(base, rel);
  const basePath = base.path.endsWith("/") ? base.path : base.path + "/";
  if (uri.path !== base.path && !uri.path.startsWith(basePath)) {
    throw new Error("Cannot access paths outside the working folder: " + rel);
  }
  return uri;
}

/**
 * 언어 서버가 해당 파일을 분석하도록 유도하고 진단이 갱신될 때까지 기다린다.
 * 언어 서버는 '열린' 문서만 분석하므로, 닫힌 파일은 openTextDocument 로
 * 백그라운드 로드(탭은 열리지 않음)한 뒤 진단 변경 이벤트를 대기한다.
 */
export async function ensureAnalyzed(
  relPath: string,
  timeoutMs = 3000
): Promise<void> {
  let uri: vscode.Uri;
  try {
    uri = safeUri(relPath);
  } catch {
    return;
  }
  const key = uri.toString();
  const wasOpen = vscode.workspace.textDocuments.some(
    (d) => d.uri.toString() === key
  );
  try {
    await vscode.workspace.openTextDocument(uri);
  } catch {
    return; // 존재하지 않거나 열 수 없는 파일
  }
  // 이미 열려 있고 진단이 하나라도 있으면 최신으로 간주
  if (wasOpen && vscode.languages.getDiagnostics(uri).length > 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, timeoutMs);
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.toString() === key)) {
        clearTimeout(timer);
        sub.dispose();
        // 이벤트 직후 잔여 갱신 여유
        setTimeout(resolve, 200);
      }
    });
  });
}

// ── GDScript: Godot CLI 폴백 검사 ──
let cachedGodotLookup: string | null | undefined;

/** godot 실행 파일 찾기: 설정 → PATH(godot, godot4) 순 */
function findGodot(): string | null {
  const cfgPath = vscode.workspace
    .getConfiguration("nemotron")
    .get<string>("godotPath", "")
    .trim();
  if (cfgPath) {
    return fs.existsSync(cfgPath) ? cfgPath : null;
  }
  if (cachedGodotLookup !== undefined) {
    return cachedGodotLookup;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  for (const name of ["godot", "godot4"]) {
    try {
      const r = cp.spawnSync(finder, [name], {
        windowsHide: true,
        encoding: "utf8",
      });
      const first = r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
      if (first) {
        cachedGodotLookup = first;
        return cachedGodotLookup;
      }
    } catch {
      /* ignore */
    }
  }
  cachedGodotLookup = null;
  return null;
}

/** 실행 파일을 인자 배열로 직접 실행하고 출력을 캡처 (셸 미사용) */
function runExe(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = cp.spawn(file, args, { cwd, windowsHide: true });
    let output = "";
    let timedOut = false;
    const capture = (b: Buffer) => {
      output += b.toString("utf8");
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + "\nExecution error: " + e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/**
 * GDScript 파일을 godot CLI 로 문법 검사한다 (Godot 에디터 LSP 폴백).
 * godot 을 찾지 못하면 null.
 */
export async function checkGdScript(relPath: string): Promise<string | null> {
  const godot = findGodot();
  if (!godot) {
    return null;
  }
  const cwd = workspaceRoot().fsPath;
  const abs = safeUri(relPath).fsPath;
  const args = ["--headless"];
  if (fs.existsSync(cwd + "/project.godot")) {
    args.push("--path", cwd); // 프로젝트 컨텍스트에서 검사 (리소스 참조 해석)
  }
  args.push("--check-only", "--script", abs);
  const res = await runExe(godot, args, cwd, 20000);
  if (res.timedOut) {
    return "(godot --check-only check timed out)";
  }
  if (res.code === 0) {
    return "(godot --check-only: no syntax errors)";
  }
  return `[godot --check-only result, exit code ${res.code}]\n${res.output.trim().slice(0, 3000)}`;
}

/** 편집기 진단(오류/경고)을 "파일:행:열 [심각도] 메시지" 형태로 요약한다. (④ 검증 루프에서도 재사용) */
export function formatDiagnostics(relPath?: string, maxItems = 100): string {
  const sevName = ["Error", "Warning", "Info", "Hint"];
  let entries: readonly [vscode.Uri, readonly vscode.Diagnostic[]][];
  if (relPath) {
    const uri = safeUri(relPath);
    entries = [[uri, vscode.languages.getDiagnostics(uri)]];
  } else {
    entries = vscode.languages.getDiagnostics();
  }
  const lines: string[] = [];
  let total = 0;
  for (const [uri, diags] of entries) {
    if (uri.scheme !== "file") {
      continue;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    for (const d of diags) {
      // 오류/경고만 (정보/힌트 제외)
      if (d.severity > vscode.DiagnosticSeverity.Warning) {
        continue;
      }
      total++;
      if (lines.length < maxItems) {
        lines.push(
          `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
            `[${sevName[d.severity]}] ${d.message.split("\n")[0]}`
        );
      }
    }
  }
  if (total === 0) {
    return "(no errors or warnings)";
  }
  let out = lines.join("\n");
  if (total > lines.length) {
    out += `\n… and ${total - lines.length} more`;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * update_plan 의 plan 텍스트를 줄 단위로 파싱한다.
 * - `[x]`/`[X]` = 완료, `[ ]` = 미완, 접두어 없는 비어있지 않은 줄은 done:false 로 간주한다.
 */
export function parsePlan(plan: string): { text: string; done: boolean }[] {
  const items: { text: string; done: boolean }[] = [];
  for (const raw of plan.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const m = line.match(/^[-*]?\s*\[([ xX])\]\s*(.*)$/);
    if (m) {
      const text = m[2].trim();
      if (text) {
        items.push({ text, done: m[1].toLowerCase() === "x" });
      }
      continue;
    }
    // 접두어 없는 줄은 미완 단계로 간주
    items.push({ text: line, done: false });
  }
  return items;
}

/** 작업 계획 항목을 `[x]`/`[ ]` 텍스트 목록으로 직렬화한다. */
export function formatPlan(items: { text: string; done: boolean }[]): string {
  return items.map((it) => `[${it.done ? "x" : " "}] ${it.text}`).join("\n");
}

/** SymbolKind → label */
function symbolKindLabel(kind: vscode.SymbolKind): string {
  const map: Record<number, string> = {
    [vscode.SymbolKind.File]: "File",
    [vscode.SymbolKind.Module]: "Module",
    [vscode.SymbolKind.Namespace]: "Namespace",
    [vscode.SymbolKind.Package]: "Package",
    [vscode.SymbolKind.Class]: "Class",
    [vscode.SymbolKind.Method]: "Method",
    [vscode.SymbolKind.Property]: "Property",
    [vscode.SymbolKind.Field]: "Field",
    [vscode.SymbolKind.Constructor]: "Constructor",
    [vscode.SymbolKind.Enum]: "Enum",
    [vscode.SymbolKind.Interface]: "Interface",
    [vscode.SymbolKind.Function]: "Function",
    [vscode.SymbolKind.Variable]: "Variable",
    [vscode.SymbolKind.Constant]: "Constant",
    [vscode.SymbolKind.String]: "String",
    [vscode.SymbolKind.Number]: "Number",
    [vscode.SymbolKind.Boolean]: "Boolean",
    [vscode.SymbolKind.Array]: "Array",
    [vscode.SymbolKind.Object]: "Object",
    [vscode.SymbolKind.Key]: "Key",
    [vscode.SymbolKind.Null]: "Null",
    [vscode.SymbolKind.EnumMember]: "EnumMember",
    [vscode.SymbolKind.Struct]: "Struct",
    [vscode.SymbolKind.Event]: "Event",
    [vscode.SymbolKind.Operator]: "Operator",
    [vscode.SymbolKind.TypeParameter]: "TypeParameter",
  };
  return map[kind] ?? "Other";
}

/** Location | LocationLink 배열을 `상대경로:라인 + 라인 텍스트` 목록으로 만든다. */
async function formatLocations(
  locs: (vscode.Location | vscode.LocationLink)[],
  max: number
): Promise<string[]> {
  const out: string[] = [];
  for (const loc of locs) {
    if (out.length >= max) {
      break;
    }
    // LocationLink(targetUri/targetRange) 와 Location(uri/range) 모두 처리
    const uri = (loc as vscode.LocationLink).targetUri ?? (loc as vscode.Location).uri;
    const range =
      (loc as vscode.LocationLink).targetRange ?? (loc as vscode.Location).range;
    if (!uri || !range) {
      continue;
    }
    const rel = vscode.workspace.asRelativePath(uri, false);
    const line = range.start.line;
    let text = "";
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      text = doc.lineAt(Math.min(line, doc.lineCount - 1)).text.trim();
    } catch {
      /* 라인 텍스트 조회 실패는 무시 */
    }
    out.push(`${rel}:${line + 1}${text ? "  " + text.slice(0, 200) : ""}`);
  }
  return out;
}

/** 대상 파일 텍스트에서 symbol 의 위치(0-기반 line/character)를 찾는다. */
function locateSymbol(
  text: string,
  symbol: string,
  lineHint?: number
): { line: number; character: number } | null {
  const lines = text.split(/\r?\n/);
  // line 힌트(1-기반)가 있으면 그 라인을 우선 검사
  if (lineHint && lineHint >= 1 && lineHint <= lines.length) {
    const idx = lines[lineHint - 1].indexOf(symbol);
    if (idx >= 0) {
      return { line: lineHint - 1, character: idx };
    }
  }
  for (let ln = 0; ln < lines.length; ln++) {
    const idx = lines[ln].indexOf(symbol);
    if (idx >= 0) {
      return { line: ln, character: idx };
    }
  }
  return null;
}

/** @멘션 첨부용: 워크스페이스 상대경로 텍스트 파일을 읽는다(크기 제한). */
export async function readWorkspaceText(
  rel: string,
  maxBytes = 50_000
): Promise<{ text: string; truncated: boolean }> {
  const uri = safeUri(rel);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > maxBytes) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)),
      truncated: true,
    };
  }
  return { text: new TextDecoder("utf-8").decode(bytes), truncated: false };
}

// ── 장기 메모리(Long-term Memory) ────────────────────────────────
// AI 가 세션을 넘어 교훈/선호/규약을 스스로 기록·참조·수정하는 저장소.
// 파일 1개 = 메모리 1개: .nemotron/memory/<id>.md (프런트매터 + 본문)
const MEMORY_DIR = ".nemotron/memory";

export interface MemoryEntry {
  id: string;
  category: string;
  created: string;
  content: string;
}

function memoryUri(id: string): vscode.Uri {
  return safeUri(`${MEMORY_DIR}/${id}.md`);
}

function parseMemory(id: string, text: string): MemoryEntry {
  let category = "note";
  let created = "";
  let content = text.trim();
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (m) {
    content = m[2].trim();
    const cat = m[1].match(/category:\s*(.+)/);
    const cr = m[1].match(/created:\s*(.+)/);
    if (cat) {
      category = cat[1].trim();
    }
    if (cr) {
      created = cr[1].trim();
    }
  }
  return { id, category, created, content };
}

function serializeMemory(category: string, created: string, content: string): Uint8Array {
  const body = `---\ncategory: ${category}\ncreated: ${created}\n---\n${content}\n`;
  return new TextEncoder().encode(body);
}

/** 저장된 모든 메모리를 최신 생성 순으로 읽는다. */
export async function listMemories(): Promise<MemoryEntry[]> {
  let dir: [string, vscode.FileType][];
  try {
    dir = await vscode.workspace.fs.readDirectory(safeUri(MEMORY_DIR));
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const [name, type] of dir) {
    if (type !== vscode.FileType.File || !name.endsWith(".md")) {
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(safeUri(`${MEMORY_DIR}/${name}`));
      out.push(parseMemory(name.replace(/\.md$/, ""), new TextDecoder("utf-8").decode(bytes)));
    } catch {
      /* 개별 파일 오류는 건너뛴다 */
    }
  }
  out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return out;
}

/** system prompt 주입용 문자열 (예산 안에서 최신순으로 채운다). */
export function formatMemoriesForPrompt(mems: MemoryEntry[], budget: number): string {
  const lines: string[] = [];
  let acc = 0;
  for (const m of mems) {
    const line = `- (${m.id}) [${m.category}] ${m.content.replace(/\s*\n\s*/g, " ")}`;
    if (lines.length > 0 && acc + line.length > budget) {
      break;
    }
    acc += line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

/** 메모리 도구 사용 안내 (설정에서 켜졌을 때만 system prompt 에 덧붙임). */
export const MEMORY_INSTRUCTION = [
  "",
  "Long-term memory:",
  "- Relevant saved memories appear at the top of this prompt under [Long-term memory], each with an (id).",
  "- Honor them before acting. When you learn something durable — a mistake you made and its fix, a user preference, or a project convention — save it with the remember tool so future sessions won't repeat it.",
  "- If a memory turns out wrong or outdated, correct it with update_memory or delete it with forget (reference it by its id).",
  "- Do NOT save trivial/one-off details or things already visible in the code, git, or NEMOTRON.md. Keep each memory a single concise fact.",
  "",
  "```tool",
  "remember",
  "category: mistake",
  "<<<CONTENT",
  "The build entry is esbuild.js (run `npm run build`); this project has no webpack config.",
  "<<<END",
  "```",
  "",
  "```tool",
  "forget",
  "id: mabc123",
  "```",
].join("\n");

export interface ToolContext {
  /**
   * 파일 변경 승인 (true=허용). summary 는 변경 요약,
   * proposed 는 적용 후 전체 내용(diff 미리보기용).
   */
  confirmWrite: (
    path: string,
    summary: string,
    proposed?: string
  ) => Promise<boolean>;
  /** 터미널 명령 실행 승인 (true=허용). */
  confirmCommand: (command: string) => Promise<boolean>;
  /** 변경 직전 원본 백업(/undo 용). bytes=null 이면 새 파일이었음. */
  recordBackup?: (relPath: string, bytes: Uint8Array | null) => void;
  /** 지속 셸 세션 (cd/venv 유지). 없으면 단발 프로세스로 실행. */
  shell?: PersistentShell;
  /** sub-agent 실행 (run_agent 도구). */
  runAgent?: (
    agent: string,
    task: string
  ) => Promise<{ ok: boolean; output: string; preview: string }>;
  /** 작업 계획 갱신 (update_plan 도구). */
  updatePlan?: (items: { text: string; done: boolean }[]) => void;
}

/** 워크스페이스에서 셸 명령을 실행하고 출력을 캡처한다. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const sh = detectShell();
    const child =
      sh.kind === "bash"
        ? cp.spawn(sh.path, ["-c", command], { cwd, windowsHide: true })
        : cp.spawn(command, { cwd, shell: true, windowsHide: true });
    let output = "";
    let timedOut = false;
    let killed = false;
    const capture = (buf: Buffer) => {
      output += buf.toString("utf8");
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + "\n…(output truncated)";
        if (!killed) {
          killed = true;
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + "\nExecution error: " + e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** 미리보기용으로 문자열을 앞뒤로 자른다. */
function snippet(s: string, max = 300): string {
  const t = s.length > max ? s.slice(0, max) + " …(truncated)" : s;
  return t;
}

/** 대상 파일에서 oldStr 을 newStr 로 치환한다. edit_file / apply_edit 공용. */
async function doEdit(
  toolName: string,
  path: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!oldStr) {
    return {
      name: toolName,
      ok: false,
      output: "The old content is empty.",
      preview: `${path} (no old)`,
    };
  }
  const uri = safeUri(path);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder("utf-8").decode(bytes);

  // 정확 일치 횟수 계산
  let count = 0;
  let from = 0;
  while (true) {
    const i = text.indexOf(oldStr, from);
    if (i < 0) {
      break;
    }
    count++;
    from = i + oldStr.length;
  }
  if (count === 0) {
    return {
      name: toolName,
      ok: false,
      output:
        "The old content was not found in the file. It must match exactly, including whitespace/indentation.",
      preview: `${path} (no match)`,
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      name: toolName,
      ok: false,
      output: `The old content was found in ${count} places. Include more context to make it unique, or use replace_all.`,
      preview: `${path} (${count} matches)`,
    };
  }

  // 적용 결과를 미리 계산 (diff 미리보기용)
  let updated: string;
  if (replaceAll) {
    updated = text.split(oldStr).join(newStr);
  } else {
    const i = text.indexOf(oldStr);
    updated = text.slice(0, i) + newStr + text.slice(i + oldStr.length);
  }

  const approved = await ctx.confirmWrite(
    path,
    [
      replaceAll ? `Editing ${count} places.` : "Editing 1 place.",
      "",
      "- Before:",
      snippet(oldStr),
      "",
      "+ After:",
      snippet(newStr),
    ].join("\n"),
    updated
  );
  if (!approved) {
    return {
      name: toolName,
      ok: false,
      output: `The user rejected the change to '${path}'.`,
      preview: `${path} (rejected)`,
    };
  }

  ctx.recordBackup?.(path, bytes);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
  return {
    name: toolName,
    ok: true,
    output: `Edited file: ${path} (${replaceAll ? count + " places" : "1 place"})`,
    preview: `${path} edited${replaceAll ? ` (${count} places)` : ""}`,
  };
}

/**
 * 바이트 앵커 방식 부분 수정: 전 과정을 Buffer(바이트)로 처리한다.
 * 원본에서 oldBuf(변경 전 바이트)를 찾아 위치를 검증한 뒤 newBuf 로 splice 한다.
 * 문자열 디코딩/이스케이프가 전혀 없어 특수문자·인코딩 문제에서 자유롭다.
 */
async function doByteEdit(
  path: string,
  oldBuf: Buffer,
  newBuf: Buffer,
  replaceAll: boolean,
  ctx: ToolContext
): Promise<ToolResult> {
  if (oldBuf.length === 0) {
    return {
      name: "apply_bytes",
      ok: false,
      output: "The old content is empty.",
      preview: `${path} (no old)`,
    };
  }
  const uri = safeUri(path);
  const orig = Buffer.from(await vscode.workspace.fs.readFile(uri));

  // 바이트 단위 일치 위치 수집
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const i = orig.indexOf(oldBuf, from);
    if (i < 0) {
      break;
    }
    positions.push(i);
    from = i + oldBuf.length;
  }
  if (positions.length === 0) {
    return {
      name: "apply_bytes",
      ok: false,
      output:
        "The old byte sequence was not found in the original. old_file content must match the original exactly (including whitespace/newlines).",
      preview: `${path} (no match)`,
    };
  }
  if (positions.length > 1 && !replaceAll) {
    return {
      name: "apply_bytes",
      ok: false,
      output: `The old byte sequence was found in ${positions.length} places. Include more context in old_file to make it unique, or use replace_all.`,
      preview: `${path} (${positions.length} matches)`,
    };
  }

  // 바이트 splice 를 미리 계산 (diff 미리보기용)
  const parts: Buffer[] = [];
  let cursor = 0;
  const targets = replaceAll ? positions : [positions[0]];
  for (const i of targets) {
    parts.push(orig.subarray(cursor, i), newBuf);
    cursor = i + oldBuf.length;
  }
  parts.push(orig.subarray(cursor));
  const result = Buffer.concat(parts);

  const approved = await ctx.confirmWrite(
    path,
    [
      replaceAll ? `Editing ${positions.length} places.` : "Editing 1 place.",
      `(bytes: before ${oldBuf.length} → after ${newBuf.length})`,
      "",
      "- Before:",
      snippet(oldBuf.toString("utf8")),
      "",
      "+ After:",
      snippet(newBuf.toString("utf8")),
    ].join("\n"),
    result.toString("utf8")
  );
  if (!approved) {
    return {
      name: "apply_bytes",
      ok: false,
      output: `The user rejected the change to '${path}'.`,
      preview: `${path} (rejected)`,
    };
  }

  ctx.recordBackup?.(path, orig);
  await vscode.workspace.fs.writeFile(uri, result);
  const n = targets.length;
  return {
    name: "apply_bytes",
    ok: true,
    output: `Edited file (bytes): ${path} (${n} places, ${orig.length}→${result.length} bytes)`,
    preview: `${path} edited${n > 1 ? ` (${n} places)` : ""}`,
  };
}

export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "list_files": {
        const glob = typeof call.args?.glob === "string" ? call.args.glob : "**/*";
        const max = Math.min(Number(call.args?.max) || MAX_LIST, MAX_LIST);
        const uris = await vscode.workspace.findFiles(
          glob,
          "**/{node_modules,.git,out,dist,.vscode-test}/**",
          max
        );
        const rels = uris
          .map((u) => vscode.workspace.asRelativePath(u, false))
          .sort();
        const body = rels.length ? rels.join("\n") : "(no matching files)";
        return {
          name: call.name,
          ok: true,
          output: `${rels.length} files total:\n${body}`,
          preview: `${rels.length} files`,
        };
      }
      case "read_file": {
        const path = String(call.args?.path ?? "");
        const uri = safeUri(path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        let text = new TextDecoder("utf-8").decode(bytes);
        let note = "";
        if (bytes.byteLength > MAX_READ_BYTES) {
          text = new TextDecoder("utf-8").decode(bytes.slice(0, MAX_READ_BYTES));
          note = `\n... (file is large; showing only the first ${MAX_READ_BYTES} bytes)`;
        }
        return {
          name: call.name,
          ok: true,
          output: `File: ${path}\n\`\`\`\n${text}${note}\n\`\`\``,
          preview: `${path} (${bytes.byteLength} bytes)`,
        };
      }
      case "write_file": {
        const path = String(call.args?.path ?? "");
        const content = String(call.args?.content ?? "");
        const uri = safeUri(path);
        let prevBytes: Uint8Array | null = null;
        try {
          prevBytes = await vscode.workspace.fs.readFile(uri);
        } catch {
          prevBytes = null; // 새 파일
        }
        const approved = await ctx.confirmWrite(
          path,
          `Writing the entire file (${content.length} chars${prevBytes === null ? ", new file" : ""}).`,
          content
        );
        if (!approved) {
          return {
            name: call.name,
            ok: false,
            output: `The user rejected writing '${path}'.`,
            preview: `${path} (rejected)`,
          };
        }
        ctx.recordBackup?.(path, prevBytes);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        return {
          name: call.name,
          ok: true,
          output: `File saved: ${path} (${content.length} chars)`,
          preview: `${path} saved`,
        };
      }
      case "edit_file": {
        const path = String(call.args?.path ?? "");
        const oldStr = String(call.args?.old_string ?? "");
        const newStr = String(call.args?.new_string ?? "");
        const replaceAll = call.args?.replace_all === true;
        return doEdit("edit_file", path, oldStr, newStr, replaceAll, ctx);
      }
      case "apply_bytes": {
        // 변경 전/후 내용을 담은 '파일'을 받아 바이트 단위로 적용한다.
        const path = String(call.args?.path ?? "");
        const oldFile = String(call.args?.old_file ?? "");
        const newFile = String(call.args?.new_file ?? "");
        const replaceAll = call.args?.replace_all === true;
        if (!oldFile || !newFile) {
          throw new Error("old_file and new_file are required.");
        }
        const oldBuf = Buffer.from(
          await vscode.workspace.fs.readFile(safeUri(oldFile))
        );
        const newBuf = Buffer.from(
          await vscode.workspace.fs.readFile(safeUri(newFile))
        );
        return doByteEdit(path, oldBuf, newBuf, replaceAll, ctx);
      }
      case "run_command": {
        const command = String(call.args?.command ?? "").trim();
        if (!command) {
          throw new Error("A command is required.");
        }
        const approved = await ctx.confirmCommand(command);
        if (!approved) {
          return {
            name: call.name,
            ok: false,
            output: `The user rejected running the command: ${command}`,
            preview: "execution rejected",
          };
        }
        const cwd = workspaceRoot().fsPath;
        const cfg = vscode.workspace.getConfiguration("nemotron");
        const timeoutMs = cfg.get<number>("commandTimeout", 60000);
        const usePersistent = cfg.get<boolean>("persistentShell", true) && ctx.shell;
        const res = usePersistent
          ? await ctx.shell!.run(command, timeoutMs)
          : await runShell(command, cwd, timeoutMs);
        const status = res.timedOut
          ? `stopped by timeout (${timeoutMs}ms)${usePersistent ? " (shell restarted)" : ""}`
          : `exit code ${res.code}`;
        return {
          name: call.name,
          ok: res.code === 0 && !res.timedOut,
          output: `$ ${command}\n[${status}]\n${res.output || "(no output)"}`,
          preview: `${command}  →  ${status}`,
        };
      }
      case "get_diagnostics": {
        const path = call.args?.path ? String(call.args.path) : undefined;
        if (path) {
          // 닫힌 파일도 언어 서버가 분석하도록 유도 후 결과 수집
          await ensureAnalyzed(path);
        }
        let body = formatDiagnostics(path);
        const scope = path ?? "entire workspace";
        let none = body === "(no errors or warnings)";
        // GDScript: LSP 진단이 비어 있으면 godot CLI 폴백 검사
        if (path && none && path.toLowerCase().endsWith(".gd")) {
          const gd = await checkGdScript(path);
          if (gd) {
            body = gd;
            none = gd.includes("no syntax errors");
          } else {
            body +=
              "\n(GDScript: the Godot editor (LSP) is not connected and the godot CLI was not found. Keep the Godot editor running, or add the godot path to PATH or the nemotron.godotPath setting.)";
          }
        }
        if (!path && none) {
          body +=
            "\n(Note: files not open in the editor may not be analyzed by the language server and can be missing from this list. Specify a path to check a particular file.)";
        }
        return {
          name: call.name,
          ok: true,
          output: `[Diagnostics: ${scope}]\n${body}`,
          preview: none ? `${scope} — no problems` : `${scope} — problems found`,
        };
      }
      case "search_text": {
        const query = String(call.args?.query ?? "");
        if (!query) {
          throw new Error("A query is required.");
        }
        const isRegex = call.args?.regex === true;
        const glob = typeof call.args?.glob === "string" ? call.args.glob : "**/*";
        const maxResults = Math.min(Number(call.args?.max) || 200, 500);
        let re: RegExp;
        try {
          re = new RegExp(isRegex ? query : escapeRegExp(query), "i");
        } catch (e: any) {
          throw new Error("Regex error: " + String(e?.message ?? e));
        }
        const uris = await vscode.workspace.findFiles(
          glob,
          "**/{node_modules,.git,out,dist,.vscode-test,.nemotron}/**",
          2000
        );
        const hits: string[] = [];
        let filesWithHits = 0;
        for (const uri of uris) {
          if (hits.length >= maxResults) {
            break;
          }
          let bytes: Uint8Array;
          try {
            bytes = await vscode.workspace.fs.readFile(uri);
          } catch {
            continue;
          }
          // 너무 크거나 바이너리(NUL 포함) 파일은 건너뜀
          if (bytes.byteLength > 1_000_000 || bytes.includes(0)) {
            continue;
          }
          const text = new TextDecoder("utf-8").decode(bytes);
          const rel = vscode.workspace.asRelativePath(uri, false);
          let fileHit = false;
          const fileLines = text.split(/\r?\n/);
          for (let ln = 0; ln < fileLines.length; ln++) {
            if (re.test(fileLines[ln])) {
              fileHit = true;
              hits.push(`${rel}:${ln + 1}: ${fileLines[ln].trim().slice(0, 200)}`);
              if (hits.length >= maxResults) {
                break;
              }
            }
          }
          if (fileHit) {
            filesWithHits++;
          }
        }
        const body = hits.length
          ? hits.join("\n") + (hits.length >= maxResults ? "\n… (limit reached)" : "")
          : "(no matches)";
        return {
          name: call.name,
          ok: true,
          output: `[Search: ${query}]\n${body}`,
          preview: `${hits.length} hits (${filesWithHits} files)`,
        };
      }
      case "list_symbols": {
        const path = typeof call.args?.path === "string" ? call.args.path.trim() : "";
        const query = typeof call.args?.query === "string" ? call.args.query.trim() : "";
        if (!path && !query) {
          throw new Error("Either path (document symbols) or query (workspace symbols) is required.");
        }
        if (path) {
          const uri = safeUri(path);
          // 언어 서버가 분석하도록 문서를 먼저 연다
          await vscode.workspace.openTextDocument(uri);
          const symbols =
            (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
              "vscode.executeDocumentSymbolProvider",
              uri
            )) ?? [];
          const lines: string[] = [];
          const walk = (nodes: vscode.DocumentSymbol[], depth: number): void => {
            for (const s of nodes) {
              if (lines.length >= 200) {
                return;
              }
              lines.push(
                "  ".repeat(depth) +
                  `${s.name} [${symbolKindLabel(s.kind)}] :${s.range.start.line + 1}`
              );
              if (s.children && s.children.length) {
                walk(s.children, depth + 1);
              }
            }
          };
          walk(symbols, 0);
          const body = lines.length ? lines.join("\n") : "(no symbols)";
          return {
            name: call.name,
            ok: true,
            output: `[Document symbols: ${path}]\n${body}${
              lines.length >= 200 ? "\n… (200-item limit reached)" : ""
            }`,
            preview: `${path} — ${lines.length} symbols`,
          };
        }
        // 워크스페이스 심볼 검색
        const symbols =
          (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            "vscode.executeWorkspaceSymbolProvider",
            query
          )) ?? [];
        const lines = symbols.slice(0, 100).map((s) => {
          const rel = vscode.workspace.asRelativePath(s.location.uri, false);
          return `${rel}:${s.location.range.start.line + 1} [${symbolKindLabel(
            s.kind
          )}] ${s.name}`;
        });
        const body = lines.length ? lines.join("\n") : "(no matching symbols)";
        return {
          name: call.name,
          ok: true,
          output: `[Workspace symbol search: ${query}]\n${body}${
            symbols.length > 100 ? "\n… (100-item limit reached)" : ""
          }`,
          preview: `${query} — ${lines.length} hits`,
        };
      }
      case "find_definition":
      case "find_references": {
        const path = String(call.args?.path ?? "").trim();
        const symbol = String(call.args?.symbol ?? "").trim();
        if (!path || !symbol) {
          throw new Error("path and symbol are required.");
        }
        const lineHint = call.args?.line ? Number(call.args.line) : undefined;
        const uri = safeUri(path);
        // 언어 서버가 분석하도록 문서를 먼저 연다
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = locateSymbol(doc.getText(), symbol, lineHint);
        if (!pos) {
          return {
            name: call.name,
            ok: false,
            output: `Could not find '${symbol}' in ${path}.${
              lineHint ? ` (with line ${lineHint} hint)` : ""
            }`,
            preview: `${path} — '${symbol}' not located`,
          };
        }
        const position = new vscode.Position(pos.line, pos.character);
        if (call.name === "find_definition") {
          const raw =
            (await vscode.commands.executeCommand<
              (vscode.Location | vscode.LocationLink)[]
            >("vscode.executeDefinitionProvider", uri, position)) ?? [];
          const lines = await formatLocations(raw, 100);
          const body = lines.length ? lines.join("\n") : "(no definition found)";
          return {
            name: call.name,
            ok: lines.length > 0,
            output: `[Definition: ${symbol} (${path}:${pos.line + 1})]\n${body}`,
            preview: `${symbol} — ${lines.length} definitions`,
          };
        }
        const raw =
          (await vscode.commands.executeCommand<vscode.Location[]>(
            "vscode.executeReferenceProvider",
            uri,
            position
          )) ?? [];
        const lines = await formatLocations(raw, 100);
        const body = lines.length ? lines.join("\n") : "(no references found)";
        return {
          name: call.name,
          ok: lines.length > 0,
          output: `[References: ${symbol} (${path}:${pos.line + 1})]\n${body}${
            raw.length > 100 ? "\n… (100-item limit reached)" : ""
          }`,
          preview: `${symbol} — ${lines.length} references`,
        };
      }
      case "update_plan": {
        const planText = String(call.args?.plan ?? "");
        const items = parsePlan(planText);
        if (items.length === 0) {
          throw new Error("No plan items in the <<<PLAN ... <<<END block.");
        }
        ctx.updatePlan?.(items);
        const done = items.filter((it) => it.done).length;
        return {
          name: call.name,
          ok: true,
          output: `Plan updated: ${done}/${items.length} done\n${formatPlan(items)}`,
          preview: `Plan ${done}/${items.length} done`,
        };
      }
      case "run_agent": {
        const agent = String(call.args?.agent ?? "").trim();
        const task = String(call.args?.task ?? "").trim();
        if (!agent || !task) {
          throw new Error("Both the agent key and a <<<TASK ... <<<END block are required.");
        }
        if (!ctx.runAgent) {
          return {
            name: call.name,
            ok: false,
            output: "sub-agent execution is not supported in this environment.",
            preview: "unsupported",
          };
        }
        const r = await ctx.runAgent(agent, task);
        return { name: call.name, ok: r.ok, output: r.output, preview: r.preview };
      }
      case "remember": {
        const content = String(call.args?.content ?? "").trim();
        const category = String(call.args?.category ?? "note").trim() || "note";
        if (!content) {
          throw new Error("A <<<CONTENT ... <<<END block with the memory text is required.");
        }
        const id = "m" + Date.now().toString(36);
        const created = new Date().toISOString().slice(0, 10);
        await vscode.workspace.fs.createDirectory(safeUri(MEMORY_DIR));
        await vscode.workspace.fs.writeFile(memoryUri(id), serializeMemory(category, created, content));
        return {
          name: call.name,
          ok: true,
          output: `Memory saved (id ${id}, ${category}): ${content}`,
          preview: `🧠 remembered [${category}] (${id})`,
        };
      }
      case "update_memory": {
        const id = String(call.args?.id ?? "").trim();
        const content = String(call.args?.content ?? "").trim();
        if (!id || !content) {
          throw new Error("An id key and a <<<CONTENT ... <<<END block are both required.");
        }
        let prev: MemoryEntry;
        try {
          const bytes = await vscode.workspace.fs.readFile(memoryUri(id));
          prev = parseMemory(id, new TextDecoder("utf-8").decode(bytes));
        } catch {
          throw new Error(`No memory with id '${id}'.`);
        }
        const created = prev.created || new Date().toISOString().slice(0, 10);
        await vscode.workspace.fs.writeFile(memoryUri(id), serializeMemory(prev.category, created, content));
        return {
          name: call.name,
          ok: true,
          output: `Memory updated (id ${id}): ${content}`,
          preview: `🧠 updated (${id})`,
        };
      }
      case "forget": {
        const id = String(call.args?.id ?? "").trim();
        if (!id) {
          throw new Error("An id key is required.");
        }
        try {
          await vscode.workspace.fs.delete(memoryUri(id));
        } catch {
          throw new Error(`No memory with id '${id}'.`);
        }
        return {
          name: call.name,
          ok: true,
          output: `Memory forgotten (id ${id}).`,
          preview: `🧠 forgot (${id})`,
        };
      }
      default:
        return {
          name: call.name,
          ok: false,
          output: "Unknown tool: " + call.name,
          preview: "unknown tool",
        };
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return { name: call.name, ok: false, output: "Error: " + msg, preview: "Error: " + msg };
  }
}
