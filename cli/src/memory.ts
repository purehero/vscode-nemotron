// 장기 메모리: 파일 1개 = 메모리 1개 (.nemotron/memory/<id>.md). 확장과 동일 포맷.
// 세션을 넘어 교훈/선호/규약을 기록·참조·수정한다.

import * as fs from "fs";
import * as path from "path";

export interface MemoryEntry {
  id: string;
  category: string;
  created: string;
  content: string;
}

function memDir(root: string): string {
  return path.join(root, ".nemotron", "memory");
}

function memFile(root: string, id: string): string {
  return path.join(memDir(root), `${id}.md`);
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
    if (cat) category = cat[1].trim();
    if (cr) created = cr[1].trim();
  }
  return { id, category, created, content };
}

function serialize(category: string, created: string, content: string): string {
  return `---\ncategory: ${category}\ncreated: ${created}\n---\n${content}\n`;
}

export function listMemories(root: string): MemoryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(memDir(root));
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const text = fs.readFileSync(path.join(memDir(root), name), "utf8");
      out.push(parseMemory(name.replace(/\.md$/, ""), text));
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return out;
}

/** system prompt 주입용 문자열 (예산 안에서 최신순). */
export function formatMemoriesForPrompt(mems: MemoryEntry[], budget: number): string {
  const lines: string[] = [];
  let acc = 0;
  for (const m of mems) {
    const line = `- (${m.id}) [${m.category}] ${m.content.replace(/\s*\n\s*/g, " ")}`;
    if (lines.length > 0 && acc + line.length > budget) break;
    acc += line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

export function saveMemory(root: string, category: string, content: string): string {
  const id = "m" + Date.now().toString(36);
  const created = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(memDir(root), { recursive: true });
  fs.writeFileSync(memFile(root, id), serialize(category || "note", created, content), "utf8");
  return id;
}

export function updateMemory(root: string, id: string, content: string): void {
  const file = memFile(root, id);
  const prev = parseMemory(id, fs.readFileSync(file, "utf8")); // throws if missing
  const created = prev.created || new Date().toISOString().slice(0, 10);
  fs.writeFileSync(file, serialize(prev.category, created, content), "utf8");
}

export function forgetMemory(root: string, id: string): void {
  fs.unlinkSync(memFile(root, id)); // throws if missing
}

export const MEMORY_INSTRUCTION = [
  "",
  "Long-term memory:",
  "- Relevant saved memories appear near the top of this prompt under [Long-term memory], each with an (id).",
  "- Honor them before acting. When you learn something durable — a mistake and its fix, a user preference, or a project convention — save it with the remember tool.",
  "- If a memory is wrong or outdated, correct it with update_memory or delete it with forget (by id).",
  "- Do NOT save trivial/one-off details or things already visible in the code/git. Keep each memory one concise fact.",
  "",
  "```tool",
  "remember",
  "category: mistake",
  "<<<CONTENT",
  "The build entry is build.mjs (run `node build.mjs`); there is no webpack config.",
  "<<<END",
  "```",
].join("\n");
