// CLI 설정: API 키·모델·파라미터. 환경변수 > 설정파일(~/.nemotron/config.json) > 기본값.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CliConfig {
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoningBudget: number;
  enableThinking: boolean;
  /** run_command 하드 제한(ms). 0 = 무제한(완료까지 대기) */
  commandTimeout: number;
  /** 한 요청 내 최대 도구 호출 왕복 수 */
  maxIterations: number;
  /** true 면 파일 쓰기·명령 실행을 묻지 않고 자동 승인 */
  autoApprove: boolean;
  /** 완료 게이트: 편집이 있었고 이 값이 설정되면 '작업 완료' 선언 전 이 명령이 exit 0 이어야 함 */
  verifyCommand: string;
  /** 장기 메모리 사용(주입·remember 도구) */
  enableMemory: boolean;
  /** 프롬프트에 주입할 메모리 최대 글자수 */
  maxMemoryChars: number;
  /** 컨텍스트 길이 예산(글자수). 초과 시 오래된 도구 결과부터 압축·제외 */
  maxContextChars: number;
  /** 원문 유지할 최신 도구 결과 개수(나머지는 규칙 압축) */
  toolResultFullCount: number;
}

const DEFAULTS: Omit<CliConfig, "apiKey"> = {
  model: "nvidia/nemotron-3-ultra-550b-a55b",
  systemPrompt:
    "You are an AI assistant developed by NVIDIA. Be helpful, clear, and concise. " +
    "Use markdown code blocks with language tags for code. Respond in the same language the user writes in.",
  temperature: 0.2,
  topP: 0.95,
  maxTokens: 16384,
  reasoningBudget: 16384,
  enableThinking: true,
  commandTimeout: 0,
  maxIterations: 50,
  autoApprove: false,
  verifyCommand: "",
  enableMemory: true,
  maxMemoryChars: 4000,
  maxContextChars: 600000,
  toolResultFullCount: 3,
};

export function configPath(): string {
  return path.join(os.homedir(), ".nemotron", "config.json");
}

function readFileCfg(): Partial<CliConfig> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

export function loadConfig(): CliConfig {
  const fileCfg = readFileCfg();
  const apiKey =
    process.env.NVIDIA_API_KEY ||
    process.env.NEMOTRON_API_KEY ||
    fileCfg.apiKey ||
    "";
  return { ...DEFAULTS, ...fileCfg, apiKey };
}

/** 설정 파일에 한 키를 저장한다(병합). */
export function saveConfigValue(key: keyof CliConfig, value: unknown): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cfg = readFileCfg() as Record<string, unknown>;
  cfg[key] = value;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}
