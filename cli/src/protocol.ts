// 도구 호출 프로토콜 파서 (vscode 확장과 동일한 ```tool 형식).
// 확장의 src/tools.ts 파서와 같은 규칙을 쓴다 — 추후 공유 모듈로 추출 예정.

export interface ToolCall {
  name: string;
  args: Record<string, any>;
  /** 응답이 잘려 이 호출이 미완성(닫는 ``` 또는 <<<END 누락)임 */
  truncated?: boolean;
}

export const CLI_TOOL_NAMES = [
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "apply_bytes",
  "run_command",
  "search_text",
  "update_plan",
  "remember",
  "update_memory",
  "forget",
] as const;

function isToolName(s: any): boolean {
  return typeof s === "string" && (CLI_TOOL_NAMES as readonly string[]).includes(s);
}

export function toolNameList(): string {
  return (CLI_TOOL_NAMES as readonly string[]).join(", ");
}

/** 모델 출력에서 ```tool ...``` 블록을 파싱한다. */
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
      /* ignore */
    }
    return null;
  }

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
  let section: "old" | "new" | "content" | "plan" | null = null;
  const oldBuf: string[] = [];
  const newBuf: string[] = [];
  const contentBuf: string[] = [];
  const planBuf: string[] = [];
  let hasOld = false;
  let hasNew = false;
  let hasContent = false;
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
  if (hasPlan) {
    args.plan = planBuf.join("\n");
  }
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
    (CLI_TOOL_NAMES as readonly string[]).some((n) => text.includes(`"${n}"`))
  );
}

/** 존재하지 않는 도구 이름을 호출하려 한 경우 그 이름을 돌려준다. */
export function unknownToolAttempt(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```tool\s*$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") {
        j++;
      }
      const first = j < lines.length ? lines[j].trim() : "";
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
