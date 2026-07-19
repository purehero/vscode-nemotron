// AI가 워크스페이스 파일을 조회/읽기/쓰기 할 수 있게 해주는 도구 모음.
// 지시 기반(ReAct) 프로토콜: 모델이 ```tool {json} ``` 블록을 출력하면 실행한다.

import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs";
import { PersistentShell, detectShell } from "./shell";
import { BackgroundJobs } from "./background";

export interface ToolCall {
  name: string;
  args: Record<string, any>;
  /** 응답이 잘려 이 호출이 미완성(닫는 ``` 또는 <<<END 누락)임 — 실행 금지 신호 */
  truncated?: boolean;
}

export interface ToolResult {
  name: string;
  ok: boolean;
  /** 모델에 다시 전달할 전체 결과 */
  output: string;
  /** UI 표시용 짧은 미리보기 */
  preview: string;
  /**
   * 일시적/시그널성 실패라 그대로 재시도하면 성공할 수 있음.
   * (예: 명령이 시그널로 종료, 지속 셸 프로세스가 죽음, spawn 자원 부족)
   * edit 매칭 실패·일반 non-zero 종료·사용자 거부 등 결정적 실패에는 설정하지 않는다.
   */
  retryable?: boolean;
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
  "capture_screen",
  "analyze_image",
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
    ? "- run_command: run a command and inspect its output. keys: command (bash shell — use POSIX syntax like ls, cat, grep, $VAR, &&, |), background (optional true). Runs in a persistent shell (cd/venv/env carry over between calls) and WAITS until the command finishes — however long that takes (builds, installs, tests) — then returns the full output and exit code. It never times out. Only pass background:true for a process that never exits on its own (e.g. a dev server): it is started without waiting and keeps running in the background."
    : "- run_command: run a command and inspect its output. keys: command (Windows cmd.exe — use dir, type, %VAR% syntax. POSIX commands like ls/cat/grep do not work), background (optional true). Runs in a persistent shell (cd/env carry over between calls) and WAITS until the command finishes — however long that takes (builds, installs, tests) — then returns the full output and exit code. It never times out. Only pass background:true for a process that never exits on its own (e.g. a dev server): it is started without waiting and keeps running in the background.",
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
  "- run_command waits for the command to finish, however long it takes (builds, installs, and test suites are fine — just call it once and wait for the result). Do not try to poll or re-run it while it is working. Use background: true only for a process that never returns on its own, such as a dev server.",
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
    // 닫는 펜스를 만나지 못하고 EOF 로 끝났다면 응답이 잘린 것
    const fenceClosed = i < lines.length;
    i++; // 닫는 펜스(또는 EOF) 건너뛰기
    const call = parseBlock(tag, block);
    if (call) {
      if (!fenceClosed) {
        call.truncated = true;
      }
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
      if (key === "replace_all" || key === "regex" || key === "background") {
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
  // 구분자 블록(<<<CONTENT/<<<OLD/<<<NEW/…)이 <<<END 로 닫히지 않은 채
  // 끝났다면 응답이 그 블록 도중에 잘린 것 → 미완성 호출로 표시
  const call: ToolCall = { name, args };
  if (section !== null) {
    call.truncated = true;
  }
  return call;
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

/**
 * ```tool 블록(또는 JSON)에서 "존재하지 않는 도구 이름"을 호출하려 한 경우
 * 그 이름을 돌려준다. (예: 제거된 check_command, 오타 등) 없으면 null.
 * 형식은 맞는데 이름만 틀린 경우를 짚어 정확히 안내하기 위함.
 */
export function unknownToolAttempt(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```tool\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") {
        j++;
      }
      const first = j < lines.length ? lines[j].trim() : "";
      // 라인 형식의 첫 줄이 '도구 이름'처럼 보이는데 유효하지 않은 경우
      if (first && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(first) && !isToolName(first)) {
        return first;
      }
    }
  }
  const m = text.match(/"name"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/);
  if (m && !isToolName(m[1])) {
    return m[1];
  }
  return null;
}

/** 유효한 도구 이름 목록(모델 교정 안내용). */
export function toolNameList(): string {
  return (TOOL_NAMES as readonly string[]).join(", ");
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
 * macOS: 지정한 앱의 앞 창(app 미지정 시 전체 화면)을 캡쳐해 축소된 JPEG 로 저장한다.
 * 비전 API 페이로드 한도를 고려해 sips 로 최대 변 1024px·JPEG 품질 60 으로 줄인다.
 * 워크스페이스 상대경로와 참고 메모를 돌려준다.
 */
export async function captureAppScreenshot(
  app: string | undefined,
  stamp: number
): Promise<{ path: string; note: string }> {
  if (process.platform !== "darwin") {
    throw new Error("Screen capture is currently supported on macOS only.");
  }
  const cwd = workspaceRoot().fsPath;
  const dirRel = ".nemotron/screenshots";
  await vscode.workspace.fs.createDirectory(safeUri(dirRel));
  const rawRel = `${dirRel}/shot_${stamp}.png`;
  const outRel = `${dirRel}/shot_${stamp}.jpg`;
  const rawAbs = safeUri(rawRel).fsPath;
  const outAbs = safeUri(outRel).fsPath;

  let note = "";
  const capArgs = ["-x"]; // -x: 캡쳐음 없음
  if (app) {
    // 대상 앱을 앞으로 가져온다
    await runExe(
      "/usr/bin/osascript",
      ["-e", `tell application "${app}" to activate`],
      cwd,
      8000
    );
    await new Promise((r) => setTimeout(r, 500));
    // 앞 창의 위치/크기 (Accessibility 권한 필요)
    const b = await runExe(
      "/usr/bin/osascript",
      [
        "-e",
        `tell application "System Events" to tell process "${app}" to get {position, size} of front window`,
      ],
      cwd,
      8000
    );
    const nums = (b.output.match(/-?\d+/g) || []).map(Number);
    if (b.code === 0 && nums.length >= 4) {
      const [x, y, w, h] = nums;
      capArgs.push(`-R${x},${y},${w},${h}`);
    } else {
      note =
        `Could not read the "${app}" window bounds (grant Accessibility permission to VS Code); ` +
        "captured the full screen instead. ";
    }
  }
  capArgs.push(rawAbs);
  const cap = await runExe("/usr/sbin/screencapture", capArgs, cwd, 15000);
  if (cap.code !== 0) {
    throw new Error(
      "screencapture failed" +
        (cap.output.trim() ? ": " + cap.output.trim() : "") +
        ". Grant Screen Recording permission to VS Code in System Settings › Privacy & Security."
    );
  }
  // 축소 + JPEG 변환. 실패하면 원본 PNG 를 그대로 사용한다.
  const sips = await runExe(
    "/usr/bin/sips",
    [
      "-s", "format", "jpeg",
      "-Z", "1024",
      "-s", "formatOptions", "60",
      rawAbs, "--out", outAbs,
    ],
    cwd,
    15000
  );
  if (sips.code === 0) {
    return { path: outRel, note };
  }
  return { path: rawRel, note: note + "(sips resize failed; using full-size PNG) " };
}

/** capture_screen 도구 사용 안내 (설정에서 켜졌을 때만 system prompt 에 덧붙임). */
export const CAPTURE_INSTRUCTION = [
  "",
  "Screen capture + vision (macOS):",
  "- Use capture_screen to see a running app's GUI. It captures the app window, sends it to a vision model, and returns a TEXT description — use it to verify UI/layout/visual bugs you cannot check from code alone.",
  "- key: app (the application name, e.g. Godot, Safari; omit to capture the full screen). Put what to look for in a <<<TASK ... <<<END block.",
  "- Capturing may ask the user for permission and requires macOS Screen Recording/Accessibility permission for VS Code.",
  "",
  "```tool",
  "capture_screen",
  "app: Godot",
  "<<<TASK",
  "Is the player sprite visible and centered? Report any error dialogs or misaligned UI.",
  "<<<END",
  "```",
].join("\n");

/**
 * 기존 이미지 파일을 비전 분석용으로 준비한다.
 * macOS 에서 파일이 크면 sips 로 최대 변 1024px·JPEG 품질 60 으로 줄여
 * .nemotron/screenshots 에 임시 저장하고 그 상대경로를 돌려준다.
 * 축소가 불필요하거나(작음) 불가능하면(비 macOS·sips 실패) 원본 경로를 그대로 돌려준다.
 */
export async function prepareImageForVision(
  relPath: string,
  stamp: number
): Promise<{ path: string; note: string }> {
  const srcUri = safeUri(relPath); // 워크스페이스 밖 경로 차단 + 존재 확인
  const stat = await vscode.workspace.fs.stat(srcUri);
  const SMALL = 700_000; // ~0.7MB 이하는 base64 후에도 비전 API 한도 내라 원본 사용
  if (stat.size <= SMALL) {
    return { path: relPath, note: "" };
  }
  if (process.platform !== "darwin") {
    return {
      path: relPath,
      note: "(large image sent as-is; automatic resize is macOS-only) ",
    };
  }
  const dirRel = ".nemotron/screenshots";
  await vscode.workspace.fs.createDirectory(safeUri(dirRel));
  const outRel = `${dirRel}/img_${stamp}.jpg`;
  const outAbs = safeUri(outRel).fsPath;
  const sips = await runExe(
    "/usr/bin/sips",
    [
      "-s", "format", "jpeg",
      "-Z", "1024",
      "-s", "formatOptions", "60",
      srcUri.fsPath, "--out", outAbs,
    ],
    workspaceRoot().fsPath,
    15000
  );
  if (sips.code === 0) {
    return { path: outRel, note: "(resized for vision) " };
  }
  return { path: relPath, note: "(resize failed; sending the original image) " };
}

/** analyze_image 도구 사용 안내 (비전 기능이 켜졌을 때 system prompt 에 덧붙임). */
export const ANALYZE_INSTRUCTION = [
  "",
  "Image file analysis (vision):",
  "- Use analyze_image to analyze an existing image file in the workspace (screenshots, diagrams, UI mockups, photos). It sends the image to a vision model and returns a TEXT description.",
  "- key: path (workspace-relative path to the image, e.g. .nemotron/screenshots/shot_123.jpg or docs/mockup.png). Put what to look for in a <<<TASK ... <<<END block.",
  "",
  "```tool",
  "analyze_image",
  "path: docs/mockup.png",
  "<<<TASK",
  "What UI elements are shown? Describe the layout and any visible text.",
  "<<<END",
  "```",
].join("\n");

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
  /** 백그라운드 명령 잡 관리 (background:true 분리 실행 및 정리). */
  background?: BackgroundJobs;
  /** 실행 중 진행 상황(경과 시간 등)을 UI 에 한 줄로 표시 (run_command 대기 중). */
  reportProgress?: (text: string) => void;
  /** sub-agent 실행 (run_agent 도구). */
  runAgent?: (
    agent: string,
    task: string
  ) => Promise<{ ok: boolean; output: string; preview: string }>;
  /** 작업 계획 갱신 (update_plan 도구). */
  updatePlan?: (items: { text: string; done: boolean }[]) => void;
  /** 화면 캡쳐 + 비전 분석 (capture_screen 도구). */
  captureScreen?: (
    app: string | undefined,
    question: string
  ) => Promise<{ ok: boolean; output: string; preview: string }>;
  /** 기존 이미지 파일 비전 분석 (analyze_image 도구). */
  analyzeImage?: (
    path: string,
    question: string
  ) => Promise<{ ok: boolean; output: string; preview: string }>;
}

/** 워크스페이스에서 셸 명령을 실행하고 출력을 캡처한다. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ code: number | null; output: string; timedOut: boolean; crashed?: boolean }> {
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
    // timeoutMs <= 0 → 무제한(명령이 끝날 때까지 대기)
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill();
            } catch {
              /* ignore */
            }
          }, timeoutMs)
        : undefined;
    child.on("error", (e) => {
      clearTimeout(timer);
      // spawn 실패(EAGAIN 등 자원 부족) — 일시적일 수 있어 재시도 대상
      resolve({
        code: null,
        output: output + "\nExecution error: " + e.message,
        timedOut,
        crashed: true,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // 시그널로 종료됐고 우리가 (타임아웃/폭주로) 죽인 게 아니면 재시도 대상
      const crashed = !!signal && !timedOut && !killed;
      resolve({
        code,
        output: signal ? output + `\n(terminated by signal ${signal})` : output,
        timedOut,
        crashed,
      });
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
        // 0(또는 음수) = 무제한: 명령이 끝날 때까지 죽이지 않고 기다린다.
        const timeoutMs = cfg.get<number>("commandTimeout", 0);

        // background:true → 기다리지 않고 즉시 백그라운드로 분리(끝나지 않는 개발 서버 등).
        if (call.args?.background === true && ctx.background) {
          const id = ctx.background.start(command);
          const s = await ctx.background.wait(id, 1000);
          const dropNote = s.dropped ? "…(earlier output dropped)\n" : "";
          if (s.running) {
            const statusLine = `started in background: id=${id} (running)`;
            return {
              name: call.name,
              ok: true,
              output:
                `$ ${command}\n[${statusLine}]\n` +
                dropNote +
                (s.newOutput.trim() || "(no output yet)") +
                `\n\nStarted without waiting (use this only for processes that do not exit, e.g. a dev server). It keeps running until the user stops it or the panel closes.`,
              preview: `${command}  →  ${statusLine}`,
            };
          }
          const status = s.code === 0 ? `exit code 0` : `exit code ${s.code}`;
          return {
            name: call.name,
            ok: s.code === 0,
            output:
              `$ ${command}\n[background ${id} finished immediately, ${status}]\n` +
              dropNote +
              (s.newOutput.trim() || "(no output)"),
            preview: `${command}  →  ${status}`,
          };
        }

        // 기본: 지속 셸에서 실행하고 끝날 때까지 기다린다(cd/venv 유지).
        // 대기 중 1초마다 경과 시간을 UI 에 표시한다(reportProgress).
        const usePersistent = !!ctx.shell;
        const startTs = Date.now();
        let ticker: ReturnType<typeof setInterval> | undefined;
        if (ctx.reportProgress) {
          ctx.reportProgress(`$ ${command}  ⏳ 0s`);
          ticker = setInterval(() => {
            const secs = Math.round((Date.now() - startTs) / 1000);
            ctx.reportProgress!(`$ ${command}  ⏳ ${secs}s`);
          }, 1000);
        }
        let res: {
          code: number | null;
          output: string;
          timedOut: boolean;
          crashed?: boolean;
        };
        try {
          res = usePersistent
            ? await ctx.shell!.run(command, timeoutMs)
            : await runShell(command, cwd, timeoutMs);
        } finally {
          if (ticker) {
            clearInterval(ticker);
          }
        }
        const elapsedS = Math.round((Date.now() - startTs) / 1000);

        // 시그널성/일시적 실패 판정.
        const killedBySignal =
          !res.timedOut && res.code !== null && res.code > 128 && res.code < 192;
        const retryable = !!res.crashed || killedBySignal;
        const status = res.timedOut
          ? `stopped by timeout (${timeoutMs}ms)`
          : res.crashed
            ? "shell terminated (signal?)"
            : killedBySignal
              ? `killed by signal (exit ${res.code})`
              : `exit code ${res.code}`;
        return {
          name: call.name,
          ok: res.code === 0 && !res.timedOut,
          output: `$ ${command}\n[${status}, ${elapsedS}s]\n${res.output || "(no output)"}`,
          preview: `${command}  →  ${status} (${elapsedS}s)`,
          retryable,
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
      case "capture_screen": {
        if (!ctx.captureScreen) {
          return {
            name: call.name,
            ok: false,
            output: "Screen capture is not available in this environment.",
            preview: "unsupported",
          };
        }
        const app = String(call.args?.app ?? "").trim() || undefined;
        const question =
          String(call.args?.task ?? "").trim() ||
          "Describe what is shown on this screen in detail, including any errors, dialogs, or layout issues.";
        const r = await ctx.captureScreen(app, question);
        return { name: call.name, ok: r.ok, output: r.output, preview: r.preview };
      }
      case "analyze_image": {
        if (!ctx.analyzeImage) {
          return {
            name: call.name,
            ok: false,
            output: "Image analysis is not available in this environment.",
            preview: "unsupported",
          };
        }
        const path = String(call.args?.path ?? "").trim();
        if (!path) {
          return {
            name: call.name,
            ok: false,
            output: "analyze_image requires a 'path' (workspace-relative image file).",
            preview: "no path",
          };
        }
        const question =
          String(call.args?.task ?? "").trim() ||
          "Describe this image in detail, including any text, UI elements, errors, or layout issues.";
        const r = await ctx.analyzeImage(path, question);
        return { name: call.name, ok: r.ok, output: r.output, preview: r.preview };
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
