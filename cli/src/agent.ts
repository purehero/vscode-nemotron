// 에이전트 루프: 모델 스트리밍 → 도구 파싱 → 실행 → 결과 되먹임 → 반복.
// Nemotron API 클라이언트는 확장과 공유(../src/nemotron.ts).

import { streamChat, ChatMessage, StreamParams } from "../../src/nemotron";
import { CliConfig } from "./config";
import { TOOL_INSTRUCTION } from "./instruction";
import {
  parseToolCalls,
  hasToolAttempt,
  unknownToolAttempt,
  toolNameList,
} from "./protocol";
import { runTool, ExecContext } from "./tools";

export interface AgentIO {
  /** 모델의 본문(답변) 토큰 출력 */
  writeContent: (text: string) => void;
  /** 추론(reasoning) 토큰 출력 (표시용, 옅게) */
  writeReasoning?: (text: string) => void;
  /** 상태/시스템 메시지 */
  writeSystem: (text: string) => void;
  /** 도구 호출/결과 표시 */
  writeTool: (text: string) => void;
  /** run_command 등 진행 표시(제자리 갱신) */
  writeProgress: (text: string) => void;
  /** 진행 표시 종료(제자리 라인 정리) */
  endProgress: () => void;
  /** 승인 프롬프트 (파일 쓰기·명령 실행) */
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

  while (iter < cfg.maxIterations) {
    iter++;
    if (signal.aborted) return;

    // 시스템 프롬프트 + 도구 지시문 + 대화
    const messages: ChatMessage[] = [
      { role: "system", content: cfg.systemPrompt + "\n\n" + TOOL_INSTRUCTION },
      ...history,
    ];

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
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) return;
      io.writeSystem(`⚠️ API error: ${err?.message ?? err}`);
      return;
    }

    const calls = parseToolCalls(answer);

    if (calls.length === 0) {
      // 도구를 시도한 것 같은데 파싱 실패 → 교정 요청 (없는 도구/형식 구분)
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
        io.writeSystem("⚠️ Could not parse a valid tool call — stopping.");
      }
      // 최종 답변으로 확정
      history.push({ role: "assistant", content: answer });
      return;
    }

    // 도구 실행
    formatRetries = 0;
    unknownToolRetries = 0;
    history.push({ role: "assistant", content: answer });
    const results: string[] = [];
    for (const call of calls) {
      if (signal.aborted) return;
      io.writeTool(`🔧 ${call.name}${call.args?.path ? "  " + call.args.path : call.args?.command ? "  " + call.args.command : ""}`);
      let res;
      try {
        res = await runTool(call, exec);
      } catch (e: any) {
        res = { ok: false, output: `Error: ${e?.message ?? e}`, preview: "error" };
      }
      io.endProgress();
      io.writeTool(`  ↳ ${res.ok ? "✅" : "⚠️"} ${res.preview}`);
      results.push(`[Tool ${call.name} result]\n${res.output}`);
    }
    history.push({ role: "user", content: results.join("\n\n") });
    // 다음 반복에서 모델이 결과를 보고 이어감
  }

  io.writeSystem(`⚠️ Reached the max tool-call limit (${cfg.maxIterations}).`);
}
