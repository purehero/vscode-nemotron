// 에이전트 루프: 모델 스트리밍 → 도구 파싱 → 실행 → 결과 되먹임 → 반복.
// Nemotron API 클라이언트는 확장과 공유(../src/nemotron.ts).
// 확장의 "똑똑함" 장치 이식: 스트리밍/빈응답/도구 재시도, 잘린쓰기 보호,
// 자동 이어가기, 완료 게이트(verify).

import { streamChat, ChatMessage, StreamParams } from "../../src/nemotron";
import { CliConfig } from "./config";
import { TOOL_INSTRUCTION } from "./instruction";
import {
  parseToolCalls,
  hasToolAttempt,
  unknownToolAttempt,
  toolNameList,
} from "./protocol";
import { runTool, execCommand, ExecContext, ToolResult } from "./tools";
import { ToolCall } from "./protocol";
import { declaresCompletion, looksUnfinished, endsWithQuestion } from "./heuristics";

const WRITE_TOOLS = ["write_file", "edit_file"];

export interface AgentIO {
  writeContent: (text: string) => void;
  writeReasoning?: (text: string) => void;
  writeSystem: (text: string) => void;
  writeTool: (text: string) => void;
  writeProgress: (text: string) => void;
  endProgress: () => void;
  confirm: (summary: string) => Promise<boolean>;
}

function params(cfg: CliConfig): StreamParams {
  return {
    model: cfg.model,
    temperature: cfg.temperature,
    topP: cfg.topP,
    maxTokens: cfg.maxTokens,
    reasoningBudget: cfg.reasoningBudget,
    enableThinking: cfg.enableThinking,
  };
}

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/** 중지 버튼(Abort)으로 즉시 깨어날 수 있는 sleep. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

/** 스트리밍 1회 — 429/503/500 이고 아직 출력 전이면 백오프 재시도. */
async function streamOnce(
  cfg: CliConfig,
  messages: ChatMessage[],
  io: AgentIO,
  signal: AbortSignal
): Promise<string> {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    let answer = "";
    try {
      for await (const ev of streamChat(cfg.apiKey, messages, params(cfg), signal)) {
        if (ev.type === "content" && ev.text) {
          answer += ev.text;
          io.writeContent(ev.text);
        } else if (ev.type === "reasoning" && ev.text && io.writeReasoning) {
          io.writeReasoning(ev.text);
        }
      }
      return answer;
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) throw err;
      const status = err?.status;
      const temporary = status === 429 || status === 503 || status === 500;
      if (!(temporary && answer === "" && attempt < maxRetries)) throw err;
      const backoff =
        typeof err?.retryAfterMs === "number"
          ? err.retryAfterMs
          : Math.min(30_000, 1000 * 2 ** attempt);
      io.writeSystem(
        `⏳ HTTP ${status} (rate limited) — retrying in ${Math.ceil(backoff / 1000)}s (${attempt + 1}/${maxRetries})`
      );
      await sleep(backoff, signal);
      if (signal.aborted) throw abortError();
    }
  }
}

/** 도구 실행 — 일시적/시그널성 실패는 최대 2회 백오프 재시도. */
async function runToolWithRetry(
  call: ToolCall,
  exec: ExecContext,
  io: AgentIO,
  signal: AbortSignal,
  maxRetries = 2
): Promise<ToolResult> {
  for (let attempt = 0; ; attempt++) {
    let res: ToolResult;
    try {
      res = await runTool(call, exec);
    } catch (e: any) {
      res = { ok: false, output: "Error: " + (e?.message ?? e), preview: "error", retryable: true };
    }
    const canRetry = res.retryable === true && attempt < maxRetries && !signal.aborted;
    if (!canRetry) return res;
    io.writeTool(`↻ ${call.name}: transient failure — retrying (${attempt + 1}/${maxRetries})`);
    await sleep(500 * (attempt + 1), signal);
  }
}

function callLabel(call: ToolCall): string {
  if (call.args?.command) return "  " + String(call.args.command);
  if (call.args?.path) return "  " + String(call.args.path);
  if (call.args?.query) return "  " + String(call.args.query);
  return "";
}

/** 한 사용자 입력을 처리한다. history 는 호출측이 유지한다(대화 이어짐). */
export async function runAgentTurn(
  history: ChatMessage[],
  cfg: CliConfig,
  io: AgentIO,
  signal: AbortSignal
): Promise<void> {
  const root = process.cwd();
  const exec: ExecContext = {
    root,
    commandTimeout: cfg.commandTimeout,
    confirm: io.confirm,
    onProgress: io.writeProgress,
  };

  let iter = 0;
  let formatRetries = 0;
  let unknownToolRetries = 0;
  let emptyRetries = 0;
  let continueNudges = 0;
  let verifyRetries = 0;
  let usedTools = false;
  let edited = false;

  while (iter < cfg.maxIterations) {
    iter++;
    if (signal.aborted) return;

    const messages: ChatMessage[] = [
      { role: "system", content: cfg.systemPrompt + "\n\n" + TOOL_INSTRUCTION },
      ...history,
    ];

    let answer: string;
    try {
      answer = await streamOnce(cfg, messages, io, signal);
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) return;
      io.writeSystem(`⚠️ API error: ${err?.message ?? err}`);
      return;
    }

    // 빈 응답: 이력 그대로 3초 후 재시도(직전 작업 이어감)
    if (!answer.trim()) {
      if (emptyRetries < 3) {
        emptyRetries++;
        io.writeSystem(`📭 Received an empty response — retrying in 3s (${emptyRetries}/3)`);
        await sleep(3000, signal);
        if (signal.aborted) return;
        continue;
      }
      io.writeSystem("📭 Empty response 3 times in a row — stopping. Please try again shortly.");
      return;
    }
    emptyRetries = 0;

    const calls = parseToolCalls(answer);

    if (calls.length === 0) {
      // 도구를 시도한 것 같은데 파싱 실패 → 교정 요청(없는 도구 vs 형식)
      if (hasToolAttempt(answer)) {
        const badTool = unknownToolAttempt(answer);
        if (badTool && unknownToolRetries < 3) {
          unknownToolRetries++;
          io.writeTool(`⚠️ No such tool: ${badTool} (${unknownToolRetries}/3)`);
          history.push({ role: "assistant", content: answer });
          history.push({
            role: "user",
            content:
              `There is no tool named "${badTool}". Available tools: ${toolNameList()}. ` +
              `Call a valid tool using the exact format, or write the final answer with no tool block.`,
          });
          continue;
        }
        if (!badTool && formatRetries < 8) {
          formatRetries++;
          io.writeTool(`⚠️ Tool-call format not recognized (${formatRetries}/8)`);
          history.push({ role: "assistant", content: answer });
          history.push({
            role: "user",
            content:
              "The previous tool call was not run because its format was invalid. " +
              "Use a ```tool block: tool name on the first line, key: value, multi-line text in <<<OLD/<<<NEW/<<<END or <<<CONTENT/<<<END.",
          });
          continue;
        }
      }

      // 자동 이어가기: 작업 예고만 하고 멈췄거나, 도구를 썼는데 완료선언 없이 끝남
      const unfinished =
        looksUnfinished(answer) ||
        (usedTools && !declaresCompletion(answer) && !endsWithQuestion(answer));
      if (continueNudges < 3 && unfinished) {
        continueNudges++;
        io.writeTool(`↻ Auto-continue — no completion declaration (${continueNudges}/3)`);
        history.push({ role: "assistant", content: answer });
        history.push({
          role: "user",
          content:
            "Your response ended without completing the task. Continue the remaining work with tool calls now. " +
            "If everything is done, declare 'Task completed.' with a summary. If you need a decision, end with a question mark.",
        });
        continue;
      }

      // 완료 게이트: 편집이 있었고 verifyCommand 가 설정됐으면, 완료선언 전 빌드/테스트 통과 요구
      const verifyCmd = (cfg.verifyCommand || "").trim();
      if (verifyCmd && edited && verifyRetries < 3 && declaresCompletion(answer)) {
        io.writeTool(`✔ Verifying before completion: ${verifyCmd}`);
        const vr = await execCommand(verifyCmd, root, cfg.commandTimeout, io.writeProgress);
        io.endProgress();
        if (signal.aborted) return;
        if (vr.code !== 0) {
          verifyRetries++;
          io.writeTool(`  ↳ ⚠️ verify failed (exit ${vr.code}) — continuing (${verifyRetries}/3)`);
          history.push({ role: "assistant", content: answer });
          history.push({
            role: "user",
            content:
              `The verify command \`${verifyCmd}\` FAILED (exit code ${vr.code}), so the task is NOT complete. ` +
              `Fix the problems and do not declare completion until it passes.\n\n[verify output]\n${vr.output.slice(0, 8000)}`,
          });
          continue;
        }
        io.writeTool(`  ↳ ✅ verify passed (${verifyCmd})`);
      }

      // 최종 답변으로 확정
      history.push({ role: "assistant", content: answer });
      return;
    }

    // 잘린 파일쓰기 방지: 응답이 도중에 끊겨 write/edit 가 미완성이면 실행하지 않는다
    const truncatedWrite = calls.some((c) => WRITE_TOOLS.includes(c.name) && c.truncated);
    if (truncatedWrite) {
      io.writeSystem("✂️ Response was cut off before a file write finished — not applied.");
      history.push({ role: "assistant", content: answer });
      history.push({
        role: "user",
        content:
          "Your previous response was cut off before the file-writing tool call was complete, so it was NOT applied and the file is unchanged. " +
          "Resend the COMPLETE tool call. Use edit_file for partial changes, or split into several smaller edit_file calls.",
      });
      continue;
    }

    // 도구 실행
    formatRetries = 0;
    unknownToolRetries = 0;
    continueNudges = 0;
    usedTools = true;
    history.push({ role: "assistant", content: answer });
    const results: string[] = [];
    for (const call of calls) {
      if (signal.aborted) return;
      io.writeTool(`🔧 ${call.name}${callLabel(call)}`);
      const res = await runToolWithRetry(call, exec, io, signal);
      io.endProgress();
      io.writeTool(`  ↳ ${res.ok ? "✅" : "⚠️"} ${res.preview}`);
      if (res.ok && WRITE_TOOLS.includes(call.name)) edited = true;
      results.push(`[Tool ${call.name} result]\n${res.output}`);
    }
    history.push({ role: "user", content: results.join("\n\n") });
  }

  io.writeSystem(`⚠️ Reached the max tool-call limit (${cfg.maxIterations}).`);
}
