// NVIDIA Nemotron API 스트리밍 클라이언트
// 익스텐션 호스트(Node 18+)의 전역 fetch 를 사용하므로 CORS 문제가 없다.

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface StreamParams {
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningBudget: number;
  enableThinking: boolean;
  /** true 면 Nemotron 전용 파라미터(chat_template_kwargs 등)를 보내지 않음 — 타 모델(sub-agent)용 */
  plain?: boolean;
}

export interface Usage {
  prompt: number;
  completion: number;
  total: number;
}

export interface StreamEvent {
  type: "reasoning" | "content" | "usage" | "finish";
  text?: string;
  usage?: Usage;
  /** finish 이벤트의 종료 사유 ("stop" | "length"(토큰 한도로 잘림) 등) */
  finishReason?: string;
}

const API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

/**
 * 비전 모델에 이미지 1장 + 질문을 보내 텍스트 분석을 받는다 (비스트리밍).
 * capture_screen 도구가 사용한다. imageDataUrl 은 "data:image/jpeg;base64,..." 형식.
 */
export async function visionComplete(
  apiKey: string,
  model: string,
  imageDataUrl: string,
  question: string,
  maxTokens: number,
  signal: AbortSignal
): Promise<string> {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    }),
    signal,
  });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${resp.status} — ${detail.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  return json?.choices?.[0]?.message?.content ?? "";
}

/**
 * Nemotron chat completions 를 스트리밍한다.
 * reasoning_content / content 를 구분해 이벤트로 방출한다.
 */
export async function* streamChat(
  apiKey: string,
  messages: ChatMessage[],
  p: StreamParams,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: p.model,
      messages,
      max_tokens: p.maxTokens,
      temperature: p.temperature,
      top_p: p.topP,
      ...(p.plain
        ? {}
        : {
            chat_template_kwargs: { enable_thinking: p.enableThinking },
            reasoning_budget: p.reasoningBudget,
          }),
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${resp.status} — ${detail.slice(0, 500)}`);
  }
  if (!resp.body) {
    throw new Error("Response body (stream) is empty.");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        return;
      }
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk?.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) {
        yield { type: "reasoning", text: delta.reasoning_content };
      }
      if (delta.content) {
        yield { type: "content", text: delta.content };
      }
      const finishReason = chunk?.choices?.[0]?.finish_reason;
      if (finishReason) {
        yield { type: "finish", finishReason };
      }
      if (chunk?.usage) {
        yield {
          type: "usage",
          usage: {
            prompt: chunk.usage.prompt_tokens ?? 0,
            completion: chunk.usage.completion_tokens ?? 0,
            total: chunk.usage.total_tokens ?? 0,
          },
        };
      }
    }
  }
}
