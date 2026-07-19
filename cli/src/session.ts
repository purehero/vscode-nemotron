// 세션 저장/복원: 프로젝트 .nemotron/session.json 에 대화 이력 + 계획을 보관.
// 종료 후에도 /resume 으로 이어가기.

import * as fs from "fs";
import * as path from "path";
import { ChatMessage } from "../../src/nemotron";
import { PlanItem } from "./tools";

export interface SessionData {
  history: ChatMessage[];
  plan: PlanItem[];
  savedAt: string;
}

function sessionFile(root: string): string {
  return path.join(root, ".nemotron", "session.json");
}

export function saveSession(root: string, history: ChatMessage[], plan: PlanItem[]): void {
  try {
    if (history.length === 0) return;
    const p = sessionFile(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ history, plan, savedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch {
    /* 저장 실패는 무시 */
  }
}

export function loadSession(root: string): SessionData | null {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile(root), "utf8"));
    if (Array.isArray(data?.history)) return data as SessionData;
  } catch {
    /* 없거나 손상 */
  }
  return null;
}

export function clearSession(root: string): void {
  try {
    fs.unlinkSync(sessionFile(root));
  } catch {
    /* 없으면 무시 */
  }
}
