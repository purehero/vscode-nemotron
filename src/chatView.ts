import * as vscode from "vscode";
import { streamChat, ChatMessage, StreamParams, Role, Usage } from "./nemotron";
import {
  TOOL_INSTRUCTION,
  parseToolCalls,
  hasToolAttempt,
  runTool,
  ToolResult,
  formatDiagnostics,
  ensureAnalyzed,
  checkGdScript,
  readWorkspaceText,
  getAgents,
  agentInstruction,
  formatPlan,
} from "./tools";
import { RateLimiter } from "./rateLimiter";
import { PersistentShell } from "./shell";

// 빌드 시각: esbuild 의 define 로 주입된다 (tsc 는 이 선언으로 통과)
declare const __BUILD_TIME__: string;

/** 주입된 빌드 시각을 안전하게 읽는다 (watch 없이 tsc 로 직접 실행되는 경우 "dev") */
function buildTime(): string {
  try {
    return typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev";
  } catch {
    return "dev";
  }
}

/** diff 미리보기용 가상 문서 제공자 (nemotron-proposed: 스킴) */
class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "nemotron-proposed";
  private map = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.map.get(uri.toString()) ?? "";
  }
  set(uri: vscode.Uri, content: string): void {
    this.map.set(uri.toString(), content);
  }
  delete(uri: vscode.Uri): void {
    this.map.delete(uri.toString());
  }
}

const SECRET_KEY = "nemotron.apiKey";

type ClientRole = "primary" | "secondary";

interface Client {
  webview: vscode.Webview;
  ready: boolean;
  role: ClientRole;
}

/** history 항목: hidden 은 도구 호출/결과 등 최종 대화에는 숨기는 내부 턴 */
interface Turn {
  role: Role;
  content: string;
  hidden?: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "nemotron.chatView";

  private clients = new Set<Client>();
  private panel?: vscode.WebviewPanel;

  private history: Turn[] = [];
  private abort?: AbortController;
  private busy = false;

  // 진행 중(스트리밍) 봇 응답 버퍼 — 새 웹뷰 재생(replay)에 사용
  private liveAnswer = "";
  private liveReasoning = "";

  // 세션 토큰 사용량 누적
  private usage = { prompt: 0, completion: 0, total: 0, requests: 0 };
  private lastUsage?: Usage;

  // API 요청 속도 제한 (RPM)
  private readonly limiter = new RateLimiter();

  // 마지막 활성 텍스트 편집기 (웹뷰에 포커스가 있으면 activeTextEditor 가 비므로 기억해 둔다)
  private lastEditor?: vscode.TextEditor;

  // ⑤ diff 미리보기 문서 제공자
  private readonly proposed = new ProposedContentProvider();
  private diffCounter = 0;

  // ⑥ /undo 백업 스택
  private undoStack: { path: string; bytes: Uint8Array | null }[] = [];

  // ⑪ NEMOTRON.md 프로젝트 지침 (전송 시 갱신)
  private projectDoc?: string;
  private projectDocNotified = false;

  // ⑫ 지속 셸 세션
  private shell?: PersistentShell;

  // 작업 계획(update_plan 도구) — 현재 세션의 체크리스트
  private plan: { text: string; done: boolean }[] = [];

  // 세션 관리: 현재 세션 ID (자동 저장 파일명)
  private sessionId = `s${Date.now()}`;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.lastEditor = vscode.window.activeTextEditor;
    ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.document.uri.scheme === "file") {
          this.lastEditor = e;
        }
      }),
      vscode.workspace.registerTextDocumentContentProvider(
        ProposedContentProvider.scheme,
        this.proposed
      ),
      { dispose: () => this.shell?.dispose() }
    );
  }

  /**
   * 사용자 응답 대기(알림/모달)를 중지(■) 버튼이 깨울 수 있게 한다.
   * abort 되면 fallback 값으로 즉시 반환된다.
   */
  private raceAbort<T>(p: Thenable<T>, fallback: T): Promise<T> {
    const signal = this.abort?.signal;
    if (!signal) {
      return Promise.resolve(p).catch(() => fallback);
    }
    if (signal.aborted) {
      return Promise.resolve(fallback);
    }
    return new Promise<T>((resolve) => {
      const onAbort = () => resolve(fallback);
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(p).then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve(fallback);
        }
      );
    });
  }

  private getShell(): PersistentShell | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    if (!this.shell) {
      this.shell = new PersistentShell(root.uri.fsPath);
    }
    return this.shell;
  }

  // ── WebviewViewProvider (사이드바) ──
  public resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    const client = this.attach(view.webview, "primary");
    view.onDidDispose(() => this.clients.delete(client));
  }

  // ── 편집기 탭(별도 창으로 분리 가능)에서 열기 ──
  public openInEditor(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "nemotron.chatPanel",
      "Nemotron Chat",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, "media")],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, "media", "icon.svg");
    panel.webview.html = this.html(panel.webview);
    const client = this.attach(panel.webview, "secondary");
    panel.onDidDispose(() => {
      this.clients.delete(client);
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.panel = panel;
  }

  private attach(webview: vscode.Webview, role: ClientRole): Client {
    const client: Client = { webview, ready: false, role };
    this.clients.add(client);
    webview.onDidReceiveMessage((msg) => this.onMessage(msg, client));
    return client;
  }

  // ── 외부(명령)에서 호출 ──
  public clear(): void {
    this.history = [];
    this.liveAnswer = "";
    this.liveReasoning = "";
    this.usage = { prompt: 0, completion: 0, total: 0, requests: 0 };
    this.lastUsage = undefined;
    this.plan = [];
    this.abort?.abort();
    this.post({ type: "clear" });
    this.post({ type: "plan", items: [] });
    this.postTitle();
  }

  /** 코드 명령 등에서 프롬프트를 채팅에 주입하고 즉시 생성 */
  public async sendUserPrompt(text: string): Promise<void> {
    // 채팅 뷰가 하나도 없으면 사이드바를 열어 웹뷰가 resolve 되도록 한다.
    if (this.clients.size === 0) {
      await vscode.commands.executeCommand("nemotron.chatView.focus");
    }
    this.post({ type: "userMessage", text });
    await this.handleSend(text, true);
  }

  // ── 메시지 처리 ──
  private async onMessage(msg: any, client: Client): Promise<void> {
    switch (msg?.type) {
      case "ready":
        client.ready = true;
        this.replay(client);
        break;
      case "send":
        await this.handleSend(String(msg.text ?? ""));
        break;
      case "stop":
        this.abort?.abort();
        if (this.busy) {
          // 실행 중인 터미널 명령도 즉시 종료 (세션은 다음 명령에서 재시작)
          this.shell?.dispose();
        }
        break;
      case "clear":
        this.clear();
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("nemotron.setApiKey");
        break;
      case "command":
        await this.handleCommand(String(msg.name ?? ""));
        break;
      case "codeAction":
        await this.handleCodeAction(String(msg.action ?? ""), String(msg.code ?? ""));
        break;
    }
  }

  /** ⑨ 코드블록 버튼: 복사 / 편집기에 적용 / 새 파일 */
  private async handleCodeAction(action: string, code: string): Promise<void> {
    if (!code) {
      return;
    }
    switch (action) {
      case "copy":
        await vscode.env.clipboard.writeText(code);
        this.post({ type: "system", text: "📋 Code copied to clipboard." });
        break;
      case "apply": {
        const ed =
          vscode.window.activeTextEditor?.document.uri.scheme === "file"
            ? vscode.window.activeTextEditor
            : this.lastEditor;
        if (!ed || ed.document.isClosed) {
          vscode.window.showWarningMessage("No editor to apply to.");
          return;
        }
        const editor = await vscode.window.showTextDocument(
          ed.document,
          ed.viewColumn ?? vscode.ViewColumn.One
        );
        const sel = editor.selection;
        const ok = await editor.edit((b) => {
          if (sel.isEmpty) {
            b.insert(sel.active, code);
          } else {
            b.replace(sel, code);
          }
        });
        this.post({
          type: "system",
          text: ok
            ? `✅ ${
                sel.isEmpty ? "Inserted into" : "Replaced selection in"
              } ${vscode.workspace.asRelativePath(ed.document.uri, false)}. (Ctrl+Z to undo)`
            : "Failed to apply.",
        });
        break;
      }
      case "newfile": {
        const doc = await vscode.workspace.openTextDocument({ content: code });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        break;
      }
    }
  }

  /** 슬래시(/) 명령 처리 */
  private async handleCommand(name: string): Promise<void> {
    switch (name) {
      case "model":
        await this.pickModel();
        break;
      case "system":
        await this.editSystemPrompt();
        break;
      case "temperature":
        await this.pickNumber("temperature", "temperature (creativity)", 0, 2, false);
        break;
      case "topp":
        await this.pickNumber("topP", "top_p (cumulative probability)", 0, 1, false);
        break;
      case "maxtokens":
        await this.pickNumber("maxTokens", "Maximum tokens to generate", 1, 131072, true);
        break;
      case "reasoning":
        await this.pickNumber("reasoningBudget", "Reasoning budget (tokens)", 0, 131072, true);
        break;
      case "rpm":
        await this.pickNumber("maxRpm", "Maximum requests per minute (RPM)", 1, 600, true);
        break;
      case "iterations":
        await this.pickNumber(
          "maxToolIterations",
          "Maximum tool-call round trips (asks whether to continue when reached)",
          1,
          200,
          true
        );
        break;
      case "thinking":
        await this.toggleBool("enableThinking", "Show thinking (reasoning) process");
        break;
      case "tools":
        await this.toggleBool("enableTools", "File tools");
        break;
      case "context":
        await this.toggleBool("autoContext", "Auto-attach active file/selection");
        break;
      case "autowrite":
        await this.toggleBool("autoApproveWrites", "Auto-approve file writes");
        break;
      case "autorun":
        await this.toggleBool("autoApproveCommands", "Auto-approve terminal commands");
        break;
      case "apikey":
        await vscode.commands.executeCommand("nemotron.setApiKey");
        break;
      case "settings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "nemotron"
        );
        break;
      case "usage":
        this.showUsage();
        break;
      case "auto":
        await this.toggleAutoMode();
        break;
      case "agents":
        await this.showAgents();
        break;
      case "init":
        await this.initProjectDoc();
        break;
      case "new":
        await this.newSession();
        break;
      case "continue":
        await this.resumeWork();
        break;
      case "history":
        await this.showHistory();
        break;
      case "undo":
        await this.undoEdit();
        break;
      case "save":
        await this.saveChat();
        break;
      case "load":
        await this.loadChat();
        break;
      case "diff":
        await this.toggleBool("showDiff", "Diff preview when approving changes");
        break;
      case "shell":
        await this.toggleBool("persistentShell", "Persistent terminal session (keeps cd/venv)");
        break;
      case "clear":
        this.clear();
        break;
    }
  }

  private showUsage(): void {
    const u = this.usage;
    if (u.requests === 0) {
      this.post({
        type: "system",
        text: "📊 Usage: no responses generated in this conversation yet.",
      });
      return;
    }
    const n = (x: number) => x.toLocaleString("en-US");
    const last = this.lastUsage;
    const lines = [
      "📊 Token usage (current conversation)",
      `• Requests: ${n(u.requests)}`,
      `• Input (prompt): ${n(u.prompt)}`,
      `• Output (completion): ${n(u.completion)}`,
      `• Total: ${n(u.total)}`,
    ];
    if (last) {
      lines.push(
        `• Last request: input ${n(last.prompt)} + output ${n(last.completion)} = ${n(last.total)}`
      );
    }
    this.post({ type: "system", text: lines.join("\n") });
  }

  private async editSystemPrompt(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("nemotron");
    const current = cfg.get<string>("systemPrompt", "");
    const input = await vscode.window.showInputBox({
      title: "System Prompt",
      value: current,
      ignoreFocusOut: true,
      prompt: "Base instructions for the AI (use /settings for multi-line editing)",
    });
    if (input === undefined) {
      return;
    }
    await cfg.update("systemPrompt", input, vscode.ConfigurationTarget.Global);
    this.post({ type: "system", text: "✅ System prompt updated." });
  }

  private async pickNumber(
    key: string,
    title: string,
    min: number,
    max: number,
    integer: boolean
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("nemotron");
    const current = cfg.get<number>(key);
    const input = await vscode.window.showInputBox({
      title,
      value: String(current),
      ignoreFocusOut: true,
      prompt: `Range: ${min} ~ ${max}${integer ? " (integer)" : ""}`,
      validateInput: (v) => {
        const n = Number(v);
        if (v.trim() === "" || Number.isNaN(n)) {
          return "Enter a number.";
        }
        if (n < min || n > max) {
          return `Must be between ${min} and ${max}.`;
        }
        if (integer && !Number.isInteger(n)) {
          return "Enter an integer.";
        }
        return undefined;
      },
    });
    if (input === undefined) {
      return;
    }
    const n = Number(input);
    await cfg.update(key, n, vscode.ConfigurationTarget.Global);
    this.post({ type: "system", text: `✅ ${title}: ${n}` });
  }

  private async toggleBool(key: string, title: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("nemotron");
    const current = cfg.get<boolean>(key, false);
    const items: (vscode.QuickPickItem & { value: boolean })[] = [
      { label: "On", description: current ? "● current" : undefined, value: true },
      { label: "Off", description: !current ? "● current" : undefined, value: false },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: `Current: ${current ? "on" : "off"}`,
    });
    if (!pick) {
      return;
    }
    await cfg.update(key, pick.value, vscode.ConfigurationTarget.Global);
    this.post({
      type: "system",
      text: `✅ ${title}: ${pick.value ? "on" : "off"}`,
    });
  }

  private async pickModel(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("nemotron");
    const current = cfg.get<string>("model", "nvidia/nemotron-3-ultra-550b-a55b");
    const presets = cfg.get<string[]>("models", []);
    const list = Array.from(new Set([current, ...presets]));

    const items: vscode.QuickPickItem[] = list.map((m) => ({
      label: m,
      description: m === current ? "● in use" : undefined,
    }));
    items.push({
      label: "$(sync) Fetch from NVIDIA catalog…",
      description: "Browse chat models from the NVIDIA catalog",
    });
    items.push({ label: "$(edit) Enter manually…", description: "Enter a model ID manually" });

    const pick = await vscode.window.showQuickPick(items, {
      title: "Select Nemotron Model",
      placeHolder: `Current: ${current}`,
    });
    if (!pick) {
      return;
    }

    // NVIDIA 카탈로그에서 채팅 모델을 가져와 선택
    if (pick.label.startsWith("$(sync)")) {
      await this.pickModelFromCatalog(current);
      return;
    }

    let model = pick.label;
    if (pick.label.startsWith("$(edit)")) {
      const input = await vscode.window.showInputBox({
        title: "Enter Model ID",
        value: current,
        prompt: "e.g. nvidia/nemotron-3-ultra-550b-a55b",
        ignoreFocusOut: true,
      });
      if (!input || !input.trim()) {
        return;
      }
      model = input.trim();
    }
    if (model === current) {
      this.post({ type: "system", text: `Model unchanged: ${model}` });
      return;
    }
    await cfg.update("model", model, vscode.ConfigurationTarget.Global);
    this.post({ type: "system", text: `✅ Model changed: ${model}` });
  }

  /** NVIDIA 카탈로그에서 채팅 모델을 골라 nemotron.model 로 설정하고 목록에 등록 */
  private async pickModelFromCatalog(current: string): Promise<void> {
    let ids: string[] = [];
    try {
      ids = await this.fetchCatalogModels(isChatModel);
    } catch (e: any) {
      this.post({
        type: "error",
        text: "Failed to fetch model catalog: " + String(e?.message ?? e),
      });
      return;
    }
    if (ids.length === 0) {
      this.post({ type: "error", text: "No chat models were returned." });
      return;
    }

    const items: vscode.QuickPickItem[] = ids.map((id) => ({
      label: id,
      description: id === current ? "● current" : undefined,
      detail: "$(sparkle) " + autoAgentDesc(id),
    }));
    const pick = await vscode.window.showQuickPick(items, {
      title: `NVIDIA catalog — ${ids.length} chat models`,
      placeHolder: "Select a model to use",
      matchOnDetail: true,
    });
    if (!pick) {
      return;
    }

    const model = pick.label;
    const cfg = vscode.workspace.getConfiguration("nemotron");
    // ① 현재 모델로 설정
    await cfg.update("model", model, vscode.ConfigurationTarget.Global);
    // ② 프리셋 목록(nemotron.models)에 없으면 추가
    const presets = cfg.get<string[]>("models", []);
    if (!presets.includes(model)) {
      await cfg.update(
        "models",
        [...presets, model],
        vscode.ConfigurationTarget.Global
      );
    }
    // ③ 웹뷰에 변경 알림
    this.post({ type: "system", text: `✅ Model changed: ${model}` });
  }

  /** 확정된 대화(history)와 진행 중 응답을 새 웹뷰에 그대로 복원한다. */
  private replay(client: Client): void {
    const wv = client.webview;
    void wv.postMessage({ type: "clear" });
    void wv.postMessage({ type: "sessionTitle", text: this.titleOrDefault() });
    void wv.postMessage({ type: "autoMode", value: this.isAutoMode() });
    void wv.postMessage({ type: "plan", items: this.plan });
    for (const m of this.history) {
      if (m.hidden) {
        continue;
      }
      if (m.role === "user") {
        void wv.postMessage({ type: "userMessage", text: m.content });
      } else if (m.role === "assistant") {
        void wv.postMessage({ type: "botStart" });
        void wv.postMessage({ type: "content", text: m.content });
        void wv.postMessage({ type: "botEnd" });
      }
    }
    // 스트리밍이 진행 중이면 현재까지의 부분 응답을 복원
    if (this.busy) {
      void wv.postMessage({ type: "botStart" });
      if (this.liveReasoning) {
        void wv.postMessage({ type: "reasoning", text: this.liveReasoning });
      }
      if (this.liveAnswer) {
        void wv.postMessage({ type: "content", text: this.liveAnswer });
      }
      void wv.postMessage({ type: "busy", value: true });
    }
  }

  /** 준비된 모든 웹뷰(사이드바 + 편집기 패널)로 브로드캐스트 */
  private post(msg: unknown): void {
    for (const c of this.clients) {
      if (c.ready) {
        void c.webview.postMessage(msg);
      }
    }
  }

  private async getApiKey(): Promise<string | undefined> {
    let key = await this.ctx.secrets.get(SECRET_KEY);
    if (!key) {
      const pick = await vscode.window.showWarningMessage(
        "NVIDIA API key is not set.",
        "Enter API Key"
      );
      if (pick) {
        await vscode.commands.executeCommand("nemotron.setApiKey");
        key = await this.ctx.secrets.get(SECRET_KEY);
      }
    }
    return key;
  }

  private params(): StreamParams {
    const c = vscode.workspace.getConfiguration("nemotron");
    return {
      model: c.get<string>("model", "nvidia/nemotron-3-ultra-550b-a55b"),
      temperature: c.get<number>("temperature", 1.0),
      topP: c.get<number>("topP", 0.95),
      maxTokens: c.get<number>("maxTokens", 16384),
      reasoningBudget: c.get<number>("reasoningBudget", 16384),
      enableThinking: c.get<boolean>("enableThinking", true),
    };
  }

  private toolsEnabled(): boolean {
    const on = vscode.workspace
      .getConfiguration("nemotron")
      .get<boolean>("enableTools", true);
    return on && (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  }

  /** 모델에 보낼 messages 배열 구성 (도구 안내·프로젝트 지침·길이 관리 포함) */
  private buildMessages(withTools: boolean): ChatMessage[] {
    let sys = vscode.workspace
      .getConfiguration("nemotron")
      .get<string>("systemPrompt", "");
    if (withTools) {
      sys = (sys ? sys + "\n\n" : "") + TOOL_INSTRUCTION + agentInstruction();
    }
    // ⑪ 프로젝트 지침(NEMOTRON.md) 자동 포함
    if (this.projectDoc) {
      sys += "\n\n[Project instructions — NEMOTRON.md in the workspace]\n" + this.projectDoc;
    }
    // 작업 계획: 미완 항목이 남아 있으면 모델이 항상 현재 계획을 보도록 덧붙인다
    if (this.plan.length > 0 && this.plan.some((it) => !it.done)) {
      sys += "\n\n[Current task plan]\n" + formatPlan(this.plan);
    }
    const messages: ChatMessage[] = [];
    if (sys && sys.trim()) {
      messages.push({ role: "system", content: sys });
    }

    // ⑧ 컨텍스트 길이 관리: 최신 턴부터 예산 안에서 채우고 오래된 턴은 생략
    const budget = vscode.workspace
      .getConfiguration("nemotron")
      .get<number>("maxContextChars", 120000);
    const kept: ChatMessage[] = [];
    let acc = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const t = this.history[i];
      if (kept.length > 0 && acc + t.content.length > budget) {
        break;
      }
      acc += t.content.length;
      kept.unshift({ role: t.role, content: t.content });
    }
    if (kept.length < this.history.length) {
      messages.push({
        role: "user",
        content: `[Notice] The conversation is long, so the previous ${
          this.history.length - kept.length
        } messages were omitted. Re-check any needed content from the files.`,
      });
    }
    messages.push(...kept);
    return messages;
  }

  /** ⑪ 워크스페이스 루트의 NEMOTRON.md 를 읽어 캐시 */
  private async loadProjectDoc(): Promise<void> {
    try {
      const { text } = await readWorkspaceText("NEMOTRON.md", 8000);
      this.projectDoc = text.trim() || undefined;
    } catch {
      this.projectDoc = undefined;
    }
    // 세션당 한 번, 지침이 적용 중임을 표시
    if (this.projectDoc && !this.projectDocNotified) {
      this.projectDocNotified = true;
      this.post({
        type: "system",
        text: `📋 Using project instructions (NEMOTRON.md). (${this.projectDoc.length.toLocaleString("en-US")} chars)`,
      });
    }
  }

  /** NEMOTRON.md 생성(AI 분석)/열기 */
  private async initProjectDoc(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      this.post({ type: "error", text: "No open working folder." });
      return;
    }
    const uri = vscode.Uri.joinPath(root.uri, "NEMOTRON.md");
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    // 파일이 없고 도구가 켜져 있으면 AI 에게 워크스페이스를 분석해 작성시킨다
    if (!exists && this.toolsEnabled()) {
      this.post({
        type: "system",
        text: "📋 NEMOTRON.md not found. The AI will analyze the workspace and create it automatically…",
      });
      await this.sendUserPrompt(
        "This workspace does not yet have NEMOTRON.md project instructions. " +
          "Explore the workspace with the list_files, read_file, search_text, and list_symbols tools to understand the project, then " +
          "use write_file to create NEMOTRON.md at the workspace root. " +
          "Include the following sections. Write it in the repository's primary language; default to English:\n" +
          "## Project overview (what the project does)\n" +
          "## Directory structure (essentials only)\n" +
          "## Key files (one-line role per file)\n" +
          "## Build/test instructions (based on what you find)\n" +
          "## Coding conventions (conventions observed in the code)\n" +
          "Keep the whole thing under 8,000 characters, and declare 'Task completed.' when done."
      );
      return;
    }
    if (!exists) {
      const template = [
        "# Project Instructions (NEMOTRON.md)",
        "",
        "The contents of this file are always included in the Nemotron AI system prompt.",
        "Feel free to write project rules and descriptions here. (Up to 8,000 characters are used.)",
        "",
        "## Project overview",
        "- (What this project is, in a line or two)",
        "",
        "## Coding conventions",
        "- (e.g. functions/variables in snake_case, comments in English)",
        "- (e.g. type hints required)",
        "",
        "## Build/test instructions",
        "- (e.g. run with python main.py)",
        "",
        "## Notes",
        "- (e.g. do not edit config.json directly)",
        "",
      ].join("\n");
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(template));
      this.post({
        type: "system",
        text: "📋 Created NEMOTRON.md. Once you fill it in, the AI will always reference it from the next message onward.",
      });
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }

  /** /agents: sub-agent 목록 보기 + NVIDIA 카탈로그 동기화 + 설정 편집 */
  private async showAgents(): Promise<void> {
    const agents = getAgents();
    type Item = vscode.QuickPickItem & { isEdit?: boolean; isSync?: boolean };
    const items: Item[] = agents.map((a) => ({
      label: a.name,
      description: a.model,
      detail: a.description ?? "",
    }));
    items.push(
      { label: "$(sync) Update from NVIDIA model list…", isSync: true },
      { label: "$(gear) Edit settings… (nemotron.agents)", isEdit: true }
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: `sub-agents (${agents.length})`,
      placeHolder: "NVIDIA specialized models the AI can delegate to via the run_agent tool",
      matchOnDescription: true,
    });
    if (pick?.isSync) {
      await this.syncAgents();
    } else if (pick?.isEdit) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "nemotron.agents"
      );
    }
  }

  /**
   * NVIDIA 카탈로그(/v1/models)에서 filter 를 통과하는 모델 ID 목록을 정렬해 반환한다.
   * 진행 표시 포함, API 키가 없거나 요청이 실패하면 throw 한다.
   */
  private async fetchCatalogModels(
    filter: (id: string) => boolean
  ): Promise<string[]> {
    const key = await this.getApiKey();
    if (!key) {
      throw new Error("NVIDIA API key is not set.");
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fetching NVIDIA model catalog…",
      },
      async () => {
        const resp = await fetch("https://integrate.api.nvidia.com/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const json: any = await resp.json();
        return (json?.data ?? [])
          .map((m: any) => String(m?.id ?? ""))
          .filter((id: string) => filter(id))
          .sort();
      }
    );
  }

  /** NVIDIA 무료 엔드포인트 카탈로그(/v1/models)에서 nvidia/ 모델을 가져와 sub-agent 갱신 */
  private async syncAgents(): Promise<void> {
    let ids: string[] = [];
    try {
      ids = await this.fetchCatalogModels(isNvidiaChatModel);
    } catch (e: any) {
      this.post({
        type: "error",
        text: "Failed to fetch model list: " + String(e?.message ?? e),
      });
      return;
    }
    if (ids.length === 0) {
      this.post({ type: "error", text: "No NVIDIA models were returned." });
      return;
    }

    const current = getAgents();
    const items = ids.map((id) => ({
      label: id,
      description: current.some((a) => a.model === id) ? "● registered" : undefined,
      detail: "$(sparkle) " + autoAgentDesc(id),
      picked: current.some((a) => a.model === id),
    }));
    const picks = await vscode.window.showQuickPick(items, {
      title: `${ids.length} NVIDIA models — select models to use as sub-agents`,
      placeHolder: "Checked models become your sub-agent list (existing ones are pre-checked)",
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!picks) {
      return;
    }
    const used = new Set<string>();
    const agents = picks.map((p) => {
      const existing = current.find((a) => a.model === p.label);
      if (existing) {
        used.add(existing.name);
        return existing; // 사용자 지정 이름/프롬프트 보존
      }
      let name = autoAgentName(p.label);
      while (used.has(name)) {
        name += "2";
      }
      used.add(name);
      return { name, model: p.label, description: autoAgentDesc(p.label) };
    });
    await vscode.workspace
      .getConfiguration("nemotron")
      .update("agents", agents, vscode.ConfigurationTarget.Global);
    this.post({
      type: "system",
      text:
        `✅ Updated sub-agents to ${agents.length}: ` +
        agents.map((a) => a.name).join(", "),
    });
  }

  /** run_agent 도구: 특화 모델(sub-agent)에게 하위 작업을 위임 */
  private async runSubAgent(
    agentName: string,
    task: string
  ): Promise<{ ok: boolean; output: string; preview: string }> {
    const agents = getAgents();
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
      return {
        ok: false,
        output:
          `Unknown sub-agent: '${agentName}'. ` +
          `Available: ${agents.map((a) => a.name).join(", ") || "(none)"}`,
        preview: "no such agent",
      };
    }
    // 이미지 생성 agent 는 별도 엔드포인트(genai)로 처리
    if (agent.type === "image") {
      return this.runImageAgent(agent, task);
    }
    if (!agent.model.startsWith("nvidia/")) {
      return {
        ok: false,
        output:
          `sub-agents can only use NVIDIA-provided models (nvidia/...). ` +
          `'${agent.name}' is set to model '${agent.model}'. Update it via /agents.`,
        preview: "not an NVIDIA model",
      };
    }
    const key = await this.ctx.secrets.get(SECRET_KEY);
    if (!key) {
      return { ok: false, output: "No API key.", preview: "no key" };
    }

    // 메인 루프와 같은 RPM 카운터 공유
    const maxRpm = vscode.workspace
      .getConfiguration("nemotron")
      .get<number>("maxRpm", 40);
    try {
      await this.limiter.acquire(maxRpm, { signal: this.abort?.signal });
    } catch {
      return { ok: false, output: "Stopped.", preview: "stopped" };
    }

    const messages: ChatMessage[] = [];
    if (agent.systemPrompt && agent.systemPrompt.trim()) {
      messages.push({ role: "system", content: agent.systemPrompt });
    }
    messages.push({ role: "user", content: task });

    const params: StreamParams = {
      model: agent.model,
      temperature: 0.6,
      topP: 0.95,
      maxTokens: 8192,
      reasoningBudget: 0,
      enableThinking: false,
      plain: true, // Nemotron 전용 파라미터 제외 (타 모델 호환)
    };
    const signal = this.abort?.signal ?? new AbortController().signal;

    let text = "";
    try {
      for await (const ev of streamChat(key, messages, params, signal)) {
        if (ev.type === "content") {
          text += ev.text ?? "";
        } else if (ev.type === "usage" && ev.usage) {
          this.usage.prompt += ev.usage.prompt;
          this.usage.completion += ev.usage.completion;
          this.usage.total += ev.usage.total;
          this.usage.requests += 1;
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { ok: false, output: "sub-agent execution was stopped.", preview: "stopped" };
      }
      return {
        ok: false,
        output: `sub-agent '${agent.name}' (${agent.model}) call failed: ${String(err?.message ?? err)}`,
        preview: `${agent.name} failed`,
      };
    }
    // deepseek-r1 등은 <think>...</think> 를 본문에 포함하므로 제거
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) {
      return { ok: false, output: "(sub-agent response is empty)", preview: `${agent.name} empty response` };
    }
    return {
      ok: true,
      output: `[sub-agent ${agent.name} (${agent.model}) result]\n${text}`,
      preview: `${agent.name} done (${text.length.toLocaleString("en-US")} chars)`,
    };
  }

  /** 이미지 생성 sub-agent: NVIDIA genai 엔드포인트 호출 → 파일 저장 → 에디터 표시 */
  private async runImageAgent(
    agent: { name: string; model: string },
    prompt: string
  ): Promise<{ ok: boolean; output: string; preview: string }> {
    const key = await this.ctx.secrets.get(SECRET_KEY);
    if (!key) {
      return { ok: false, output: "No API key.", preview: "no key" };
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return { ok: false, output: "No open working folder.", preview: "no folder" };
    }
    const maxRpm = vscode.workspace
      .getConfiguration("nemotron")
      .get<number>("maxRpm", 40);
    try {
      await this.limiter.acquire(maxRpm, { signal: this.abort?.signal });
    } catch {
      return { ok: false, output: "Stopped.", preview: "stopped" };
    }

    // 모델 계열별 요청 형식 (SDXL 계열만 text_prompts 배열 사용)
    const m = agent.model.toLowerCase();
    const body: any = /sdxl|stable-diffusion-xl/.test(m)
      ? {
          text_prompts: [{ text: prompt, weight: 1 }],
          cfg_scale: 5,
          sampler: "K_EULER_ANCESTRAL",
          seed: 0,
          steps: 25,
        }
      : /flux/.test(m)
      ? {
          prompt,
          width: 1024,
          height: 1024,
          seed: 0,
          steps: /schnell/.test(m) ? 4 : 30,
        }
      : {
          prompt,
          cfg_scale: 5,
          aspect_ratio: "1:1",
          seed: 0,
          steps: 30,
          negative_prompt: "",
        };

    try {
      const resp = await fetch(
        "https://ai.api.nvidia.com/v1/genai/" + agent.model,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: this.abort?.signal,
        }
      );
      if (!resp.ok) {
        let detail = "";
        try {
          detail = (await resp.text()).slice(0, 400);
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          output: `Image generation failed (HTTP ${resp.status}) — model: ${agent.model}\n${detail}`,
          preview: `${agent.name} failed (${resp.status})`,
        };
      }
      const json: any = await resp.json();
      // 모델별 응답 형태 대응: {image} | {artifacts:[{base64}]} | {data:[{b64_json}]}
      const b64: string | undefined =
        json?.image ?? json?.artifacts?.[0]?.base64 ?? json?.data?.[0]?.b64_json;
      if (!b64) {
        return {
          ok: false,
          output:
            "No image found in the response. Response structure: " +
            JSON.stringify(json).slice(0, 300),
          preview: "no image",
        };
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const rel = `.nemotron/images/img_${stamp}.png`;
      const uri = vscode.Uri.joinPath(root.uri, rel);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(b64, "base64"));
      // 생성된 이미지를 옆 편집기 그룹에 표시
      try {
        await vscode.commands.executeCommand("vscode.open", uri, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: true,
        });
      } catch {
        /* 표시 실패는 무시 */
      }
      return {
        ok: true,
        output: `Generated and saved image: ${rel} (model: ${agent.model}). It has been opened in the editor.`,
        preview: `${agent.name} → ${rel}`,
      };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { ok: false, output: "Image generation was stopped.", preview: "stopped" };
      }
      return {
        ok: false,
        output: `Image generation error: ${String(err?.message ?? err)}`,
        preview: `${agent.name} error`,
      };
    }
  }

  /** ⚡ 자동 승인 모드 토글 */
  private async toggleAutoMode(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("nemotron");
    const next = !cfg.get<boolean>("autoMode", false);
    await cfg.update("autoMode", next, vscode.ConfigurationTarget.Global);
    this.post({ type: "autoMode", value: next });
    this.post({
      type: "system",
      text: next
        ? "⚡ Auto-approve mode ON — file edits and command execution proceed without confirmation. (Turn off with /auto or the ⚡ button)"
        : "🔒 Auto-approve mode OFF — a confirmation dialog appears for file edits and command execution.",
    });
  }

  private isAutoMode(): boolean {
    return vscode.workspace
      .getConfiguration("nemotron")
      .get<boolean>("autoMode", false);
  }

  /** 파일 변경(write/edit) 승인 프롬프트. proposed 가 있으면 네이티브 diff 미리보기. */
  private async confirmWrite(
    path: string,
    summary: string,
    proposed?: string
  ): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration("nemotron");
    if (this.isAutoMode() || cfg.get<boolean>("autoApproveWrites", false)) {
      return true;
    }

    if (proposed !== undefined && cfg.get<boolean>("showDiff", true)) {
      const root = vscode.workspace.workspaceFolders?.[0];
      if (root) {
        const target = vscode.Uri.joinPath(root.uri, path);
        const rightUri = vscode.Uri.parse(
          `${ProposedContentProvider.scheme}:/${path}?v${this.diffCounter++}`
        );
        this.proposed.set(rightUri, proposed);
        // 원본이 없는 새 파일이면 왼쪽도 빈 가상 문서
        let leftUri = target;
        try {
          await vscode.workspace.fs.stat(target);
        } catch {
          leftUri = vscode.Uri.parse(
            `${ProposedContentProvider.scheme}:/(new file)?v${this.diffCounter++}`
          );
          this.proposed.set(leftUri, "");
        }
        try {
          await vscode.commands.executeCommand(
            "vscode.diff",
            leftUri,
            rightUri,
            `Nemotron proposal: ${path}`,
            { preview: true }
          );
          this.post({
            type: "system",
            text: `⏸ Awaiting approval: ${path} — choose Allow/Reject in the bottom-right notification (or the 🔔 notification center).`,
          });
          const pick = await this.raceAbort(
            vscode.window.showWarningMessage(
              `AI change proposal — ${path} (review the diff, then choose)`,
              "Allow",
              "Reject"
            ),
            "Reject" as string | undefined
          );
          await this.closeDiffTab(rightUri);
          this.proposed.delete(rightUri);
          if (leftUri !== target) {
            this.proposed.delete(leftUri);
          }
          return pick === "Allow";
        } catch {
          /* diff 실패 시 모달로 폴백 */
        }
      }
    }

    const pick = await this.raceAbort(
      vscode.window.showWarningMessage(
        `The AI wants to change a file: ${path}`,
        { modal: true, detail: summary },
        "Allow"
      ),
      undefined as string | undefined
    );
    return pick === "Allow";
  }

  private async closeDiffTab(rightUri: vscode.Uri): Promise<void> {
    try {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input: any = tab.input;
          if (
            input?.modified &&
            String(input.modified) === String(rightUri)
          ) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** 터미널 명령 실행 승인 프롬프트 */
  private async confirmCommand(command: string): Promise<boolean> {
    const auto = vscode.workspace
      .getConfiguration("nemotron")
      .get<boolean>("autoApproveCommands", false);
    if (this.isAutoMode() || auto) {
      return true;
    }
    const pick = await this.raceAbort(
      vscode.window.showWarningMessage(
        "The AI wants to run a terminal command:",
        { modal: true, detail: command },
        "Allow Execution"
      ),
      undefined as string | undefined
    );
    return pick === "Allow Execution";
  }

  // ── ⑥ 편집 백업 & /undo ──
  private recordBackup(relPath: string, bytes: Uint8Array | null): void {
    if (relPath.startsWith(".nemotron")) {
      return; // 임시 파일은 제외
    }
    this.undoStack.push({ path: relPath, bytes });
    if (this.undoStack.length > 20) {
      this.undoStack.shift();
    }
  }

  private async undoEdit(): Promise<void> {
    const item = this.undoStack.pop();
    if (!item) {
      this.post({ type: "system", text: "No AI edit to undo." });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return;
    }
    const uri = vscode.Uri.joinPath(root.uri, item.path);
    try {
      if (item.bytes === null) {
        await vscode.workspace.fs.delete(uri); // 새로 만들었던 파일 → 삭제
        this.post({ type: "system", text: `↩️ Undone: deleted ${item.path} (creation reverted)` });
      } else {
        await vscode.workspace.fs.writeFile(uri, item.bytes);
        this.post({ type: "system", text: `↩️ Undone: restored ${item.path}` });
      }
    } catch (e: any) {
      this.undoStack.push(item); // 실패 시 다시 넣음
      this.post({ type: "error", text: "Undo failed: " + String(e?.message ?? e) });
    }
  }

  // ── 세션 관리 (자동 저장 · 기록 · 복원) ──
  private sessionsDir(): vscode.Uri {
    const base = this.ctx.storageUri ?? this.ctx.globalStorageUri;
    return vscode.Uri.joinPath(base, "sessions");
  }

  private sessionTitle(): string {
    const first = this.history.find((t) => t.role === "user" && !t.hidden);
    const raw = (first?.content ?? "(empty)").replace(/\s+/g, " ").trim();
    return raw.length > 40 ? raw.slice(0, 40) + "…" : raw;
  }

  private titleOrDefault(): string {
    return this.history.some((t) => !t.hidden) ? this.sessionTitle() : "New chat";
  }

  /** 웹뷰 상단 바의 세션명 갱신 */
  private postTitle(): void {
    this.post({ type: "sessionTitle", text: this.titleOrDefault() });
  }

  /** 현재 세션을 조용히 저장 (대화가 있을 때만) */
  private async autoSaveSession(): Promise<void> {
    if (this.history.length === 0) {
      return;
    }
    try {
      const dir = this.sessionsDir();
      await vscode.workspace.fs.createDirectory(dir);
      const data = {
        id: this.sessionId,
        title: this.sessionTitle(),
        updatedAt: new Date().toISOString(),
        usage: this.usage,
        history: this.history,
        plan: this.plan,
      };
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dir, this.sessionId + ".json"),
        new TextEncoder().encode(JSON.stringify(data))
      );
    } catch {
      /* 자동 저장 실패는 조용히 무시 */
    }
  }

  /** 새 세션 시작 (현재 세션은 자동 저장 후 보관) */
  public async newSession(): Promise<void> {
    await this.autoSaveSession();
    this.abort?.abort();
    this.history = [];
    this.usage = { prompt: 0, completion: 0, total: 0, requests: 0 };
    this.lastUsage = undefined;
    this.undoStack = [];
    this.plan = [];
    this.projectDocNotified = false;
    this.sessionId = `s${Date.now()}`;
    this.post({ type: "clear" });
    this.post({ type: "plan", items: [] });
    this.postTitle();
    this.post({
      type: "system",
      text: "🆕 Started a new session. You can restore the previous session from /history.",
    });
  }

  /** 시작 시 가장 최근 세션을 자동 복원 (설정 nemotron.restoreLastSession) */
  public async restoreLastSession(): Promise<void> {
    const on = vscode.workspace
      .getConfiguration("nemotron")
      .get<boolean>("restoreLastSession", true);
    if (!on || this.history.length > 0 || this.busy) {
      return;
    }
    try {
      const dir = this.sessionsDir();
      const entries = await vscode.workspace.fs.readDirectory(dir);
      let best: { id: string; updatedAt: string } | undefined;
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith(".json")) {
          continue;
        }
        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(dir, name)
          );
          const d = JSON.parse(new TextDecoder("utf-8").decode(bytes));
          if (!Array.isArray(d?.history) || d.history.length === 0) {
            continue;
          }
          const u = String(d.updatedAt ?? "");
          if (!best || u > best.updatedAt) {
            best = { id: String(d.id ?? name.replace(/\.json$/, "")), updatedAt: u };
          }
        } catch {
          /* 손상 파일 무시 */
        }
      }
      if (best) {
        await this.loadSession(best.id);
        // 작업 도중 중단된 세션이면 원클릭 재개 제안
        if (this.sessionLooksInterrupted()) {
          this.post({
            type: "system",
            text: "⏸ The previous session appears to have been interrupted mid-task. Resume with /continue or [Continue] in the notification.",
          });
          const pick = await vscode.window.showInformationMessage(
            "Nemotron: the previous task appears to have been interrupted. Continue where it left off?",
            "Continue"
          );
          if (pick === "Continue") {
            void this.resumeWork();
          }
        }
      }
    } catch {
      /* 저장된 세션 없음 */
    }
  }

  /** 복원된 세션이 작업 도중 중단된 상태인지 판별 */
  private sessionLooksInterrupted(): boolean {
    const last = this.history[this.history.length - 1];
    if (!last) {
      return false;
    }
    if (last.hidden) {
      return true; // 도구 피드백/컨텍스트로 끝남 = 턴이 완료되지 못함
    }
    if (last.role === "user") {
      return true; // 질문에 답변이 오기 전에 종료됨
    }
    return last.role === "assistant" && looksUnfinished(last.content);
  }

  /** ▶️ 이전 작업 이어서 진행 (/continue, 재시작 후 재개) */
  public async resumeWork(): Promise<void> {
    if (this.busy) {
      this.post({ type: "system", text: "A task is already in progress." });
      return;
    }
    if (this.history.length === 0) {
      this.post({ type: "system", text: "There is no previous task to continue." });
      return;
    }
    this.post({ type: "userMessage", text: "▶️ Continue previous task" });
    await this.handleSend(
      "Review the conversation so far and the tool execution history. " +
        "If there was work in progress, continue the remaining steps right now with tool calls. " +
        "If everything is already done, report 'Task completed.' and briefly summarize the results.",
      true
    );
  }

  /** 세션 기록 목록 → 선택 복원 / 삭제 */
  public async showHistory(): Promise<void> {
    await this.autoSaveSession();
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.sessionsDir());
    } catch {
      /* 디렉터리 없음 */
    }
    const sessions: {
      id: string;
      title: string;
      updatedAt: string;
      count: number;
      tokens: number;
    }[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith(".json")) {
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(this.sessionsDir(), name)
        );
        const d = JSON.parse(new TextDecoder("utf-8").decode(bytes));
        if (!Array.isArray(d?.history)) {
          continue;
        }
        sessions.push({
          id: String(d.id ?? name.replace(/\.json$/, "")),
          title: String(d.title ?? "(no title)"),
          updatedAt: String(d.updatedAt ?? ""),
          count: d.history.filter((t: any) => !t.hidden).length,
          tokens: Number(d.usage?.total ?? 0),
        });
      } catch {
        /* 손상 파일 무시 */
      }
    }
    if (sessions.length === 0) {
      this.post({ type: "system", text: "No saved sessions." });
      return;
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    type Item = vscode.QuickPickItem & { id?: string; isDelete?: boolean };
    const items: Item[] = sessions.map((s) => ({
      label: (s.id === this.sessionId ? "● " : "") + s.title,
      description: s.updatedAt.slice(0, 16).replace("T", " "),
      detail: `${s.count} messages · ${s.tokens.toLocaleString("en-US")} tokens` +
        (s.id === this.sessionId ? " · current session" : ""),
      id: s.id,
    }));
    items.push({ label: "$(trash) Delete sessions…", isDelete: true });

    const pick = await vscode.window.showQuickPick(items, {
      title: "Session History",
      placeHolder: "Select a session to restore",
      matchOnDetail: true,
    });
    if (!pick) {
      return;
    }
    if (pick.isDelete) {
      await this.deleteSessions(sessions);
      return;
    }
    if (pick.id && pick.id !== this.sessionId) {
      await this.loadSession(pick.id);
    }
  }

  private async deleteSessions(
    sessions: { id: string; title: string; updatedAt: string }[]
  ): Promise<void> {
    const picks = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.title,
        description: s.updatedAt.slice(0, 16).replace("T", " "),
        id: s.id,
      })),
      { title: "Select sessions to delete (multiple allowed)", canPickMany: true }
    );
    if (!picks || picks.length === 0) {
      return;
    }
    for (const p of picks) {
      try {
        await vscode.workspace.fs.delete(
          vscode.Uri.joinPath(this.sessionsDir(), p.id + ".json")
        );
      } catch {
        /* ignore */
      }
    }
    this.post({ type: "system", text: `🗑 Deleted ${picks.length} session(s).` });
  }

  private async loadSession(id: string): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.sessionsDir(), id + ".json")
      );
      const data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      if (!Array.isArray(data?.history)) {
        throw new Error("Not a valid session file.");
      }
      this.abort?.abort();
      this.sessionId = id;
      this.history = data.history;
      this.usage = data.usage ?? { prompt: 0, completion: 0, total: 0, requests: 0 };
      this.lastUsage = undefined;
      this.undoStack = [];
      // 이전 형식(plan 없음) 세션과 호환: 없으면 빈 배열
      this.plan = Array.isArray(data.plan) ? data.plan : [];
      for (const c of this.clients) {
        if (c.ready) {
          this.replay(c);
        }
      }
      this.postTitle();
      this.post({ type: "system", text: `📂 Restored session: ${this.sessionTitle()}` });
    } catch (e: any) {
      this.post({ type: "error", text: "Failed to restore session: " + String(e?.message ?? e) });
    }
  }

  // ── ⑦ 대화 저장/불러오기 ──
  private chatsDir(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    return vscode.Uri.joinPath(root.uri, ".nemotron", "chats");
  }

  private async saveChat(): Promise<void> {
    if (this.history.length === 0) {
      this.post({ type: "system", text: "No conversation to save." });
      return;
    }
    const dir = this.chatsDir();
    if (!dir) {
      this.post({ type: "error", text: "No open working folder." });
      return;
    }
    const stamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace("T", "_")
      .replace(/:/g, "-");
    const name = await vscode.window.showInputBox({
      title: "Save Conversation As",
      value: `chat_${stamp}`,
      ignoreFocusOut: true,
    });
    if (!name) {
      return;
    }
    const file = vscode.Uri.joinPath(dir, name.replace(/[\\/:*?"<>|]/g, "_") + ".json");
    await vscode.workspace.fs.createDirectory(dir);
    const data = { savedAt: new Date().toISOString(), usage: this.usage, history: this.history };
    await vscode.workspace.fs.writeFile(
      file,
      new TextEncoder().encode(JSON.stringify(data, null, 1))
    );
    this.post({
      type: "system",
      text: `💾 Conversation saved: ${vscode.workspace.asRelativePath(file, false)}`,
    });
  }

  private async loadChat(): Promise<void> {
    const dir = this.chatsDir();
    if (!dir) {
      return;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      this.post({ type: "system", text: "No saved conversations. (Save with /save)" });
      return;
    }
    const files = entries
      .filter(([n, t]) => t === vscode.FileType.File && n.endsWith(".json"))
      .map(([n]) => n)
      .sort()
      .reverse();
    if (files.length === 0) {
      this.post({ type: "system", text: "No saved conversations. (Save with /save)" });
      return;
    }
    const pick = await vscode.window.showQuickPick(files, {
      title: "Select a Conversation to Load",
    });
    if (!pick) {
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, pick));
      const data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      if (!Array.isArray(data?.history)) {
        throw new Error("Not a valid conversation file.");
      }
      this.abort?.abort();
      this.history = data.history;
      if (data.usage) {
        this.usage = data.usage;
      }
      for (const c of this.clients) {
        if (c.ready) {
          this.replay(c);
        }
      }
      this.post({ type: "system", text: `📂 Loaded conversation: ${pick}` });
    } catch (e: any) {
      this.post({ type: "error", text: "Failed to load: " + String(e?.message ?? e) });
    }
  }

  /** 활성 파일/선택 영역 요약 (① 컨텍스트 자동 주입) */
  private buildAutoContext(): string | undefined {
    const on = vscode.workspace
      .getConfiguration("nemotron")
      .get<boolean>("autoContext", true);
    if (!on) {
      return undefined;
    }
    const ed =
      vscode.window.activeTextEditor?.document.uri.scheme === "file"
        ? vscode.window.activeTextEditor
        : this.lastEditor;
    if (!ed || ed.document.isClosed || ed.document.uri.scheme !== "file") {
      return undefined;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
    const lang = ed.document.languageId;
    const sel = ed.selection;
    let out = `Active file the user is viewing: ${rel} (${lang})`;
    if (sel && !sel.isEmpty) {
      let selText = ed.document.getText(sel);
      if (selText.length > 3000) {
        selText = selText.slice(0, 3000) + "\n…(selection is long; showing part)";
      }
      out += `\nSelection (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\`\`\`${lang}\n${selText}\n\`\`\``;
    } else if (sel) {
      out += `, cursor at line ${sel.active.line + 1}`;
    }
    return out;
  }

  /** 메시지 속 @상대경로 멘션 파일을 읽어 첨부 텍스트로 만든다. */
  private async collectMentions(text: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /@([\w가-힣.\-/\\]+\.[\w]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < 5) {
      const rel = m[1].replace(/\\/g, "/");
      if (seen.has(rel)) {
        continue;
      }
      seen.add(rel);
      try {
        const { text: body, truncated } = await readWorkspaceText(rel);
        out.push(
          `@mentioned file: ${rel}${truncated ? " (file is large; showing the beginning)" : ""}\n\`\`\`\n${body}\n\`\`\``
        );
      } catch {
        /* 존재하지 않는 경로는 무시 */
      }
    }
    return out;
  }

  private async handleSend(text: string, alreadyEchoed = false): Promise<void> {
    if (this.busy || !text.trim()) {
      return;
    }
    const key = await this.getApiKey();
    if (!key) {
      this.post({ type: "error", text: "An API key is required. (Nemotron: Set API Key)" });
      return;
    }

    if (!alreadyEchoed) {
      this.post({ type: "userMessage", text });
    }

    // ① 컨텍스트 자동 첨부: 활성 파일/선택 영역 + @멘션 파일 (숨김 턴)
    const ctxParts: string[] = [];
    if (!alreadyEchoed) {
      const ac = this.buildAutoContext();
      if (ac) {
        ctxParts.push(ac);
      }
    }
    ctxParts.push(...(await this.collectMentions(text)));
    if (ctxParts.length) {
      this.history.push({
        role: "user",
        content: "[Automatically attached context — for reference]\n" + ctxParts.join("\n\n"),
        hidden: true,
      });
    }

    this.history.push({ role: "user", content: text });
    this.postTitle();

    await this.loadProjectDoc(); // ⑪ NEMOTRON.md 갱신
    const withTools = this.toolsEnabled();
    const maxIterCfg = Math.max(
      1,
      vscode.workspace
        .getConfiguration("nemotron")
        .get<number>("maxToolIterations", 25)
    );
    let iterBudget = maxIterCfg;

    this.busy = true;
    this.post({ type: "busy", value: true });
    this.abort = new AbortController();
    let lastAnswer = "";
    let emptyRetries = 0;
    let continueNudges = 0;
    let usedToolsThisTurn = false;

    try {
      for (let iter = 0; ; iter++) {
        // 요청 속도 제한 (기본 40 RPM)
        const maxRpm = vscode.workspace
          .getConfiguration("nemotron")
          .get<number>("maxRpm", 40);
        await this.limiter.acquire(maxRpm, {
          signal: this.abort.signal,
          onWait: (ms) =>
            this.post({
              type: "system",
              text: `⏳ Rate limit (${maxRpm} RPM) — waiting about ${Math.ceil(
                ms / 1000
              )}s…`,
            }),
        });

        this.liveAnswer = "";
        this.liveReasoning = "";
        this.post({ type: "botStart" });
        let answer = "";

        for await (const ev of streamChat(
          key,
          this.buildMessages(withTools),
          this.params(),
          this.abort.signal
        )) {
          if (ev.type === "usage" && ev.usage) {
            this.usage.prompt += ev.usage.prompt;
            this.usage.completion += ev.usage.completion;
            this.usage.total += ev.usage.total;
            this.usage.requests += 1;
            this.lastUsage = ev.usage;
          } else if (ev.type === "reasoning") {
            this.liveReasoning += ev.text ?? "";
            this.post({ type: "reasoning", text: ev.text });
          } else if (ev.type === "content") {
            answer += ev.text ?? "";
            this.liveAnswer = answer;
            this.post({ type: "content", text: ev.text });
          }
        }
        this.post({ type: "botEnd" });
        lastAnswer = answer;

        // 빈 응답: 이력을 바꾸지 않고 3초 후 같은 요청을 재시도 → 직전 작업이 이어진다
        if (!answer.trim()) {
          if (emptyRetries < 3) {
            emptyRetries++;
            this.post({ type: "dropLastBot" });
            this.post({
              type: "system",
              text: `📭 Received an empty response — retrying in 3s (${emptyRetries}/3)`,
            });
            await this.raceAbort(
              new Promise<string>((r) => setTimeout(() => r("ok"), 3000)),
              "aborted"
            );
            if (this.abort?.signal.aborted) {
              this.post({ type: "system", text: "⏹ Generation stopped." });
              break;
            }
            continue;
          }
          this.post({
            type: "system",
            text: "📭 Empty response 3 times in a row — stopping. Please try again shortly.",
          });
          break;
        }
        emptyRetries = 0; // 정상 응답이면 카운터 리셋

        const calls = withTools ? parseToolCalls(answer) : [];

        // 도구 호출이 없으면 최종 답변으로 확정하고 종료
        if (calls.length === 0) {
          // 도구를 시도했으나 형식이 깨진 경우: JSON 을 답변으로 남기지 말고 교정 요청
          if (withTools && hasToolAttempt(answer) && iter < iterBudget) {
            this.history.push({ role: "assistant", content: answer, hidden: true });
            this.post({ type: "dropLastBot" });
            this.post({
              type: "tool",
              name: "Format error",
              detail: "Could not recognize the tool-call format; retrying",
            });
            this.history.push({
              role: "user",
              content:
                "The previous tool call was not run because its format was invalid. " +
                "Call it again following the exact format (```tool code block, tool name on the first line, key: value, and multi-line text in <<<OLD/<<<NEW/<<<END or <<<CONTENT/<<<END blocks). " +
                "Do not put multi-line code inside a JSON string.",
              hidden: true,
            });
            continue;
          }
          // 자동 이어가기 판정:
          // ① "~하겠습니다" 작업 예고 후 도구 호출 없이 끝남 (도구 미사용 턴 포함)
          // ② 도구를 사용한 작업 턴인데 '작업을 완료하였습니다' 선언 없이 끝남
          const unfinished =
            looksUnfinished(answer) ||
            (usedToolsThisTurn &&
              !declaresCompletion(answer) &&
              !endsWithQuestion(answer));
          if (withTools && continueNudges < 3 && unfinished) {
            continueNudges++;
            this.history.push({ role: "assistant", content: answer });
            this.post({
              type: "tool",
              name: "Auto-continue",
              detail: `Detected a stop without a completion declaration — requesting continuation (${continueNudges}/3)`,
            });
            this.history.push({
              role: "user",
              content:
                "Your response ended without completing the task. " +
                "Continue the remaining work with tool calls now. " +
                "If everything is done, declare 'Task completed.' with a summary. " +
                "If you need a user decision, end with a question mark.",
              hidden: true,
            });
            continue;
          }
          if (answer) {
            this.history.push({ role: "assistant", content: answer });
          }
          break;
        }

        // 도구 호출 턴: 화면의 JSON 말풍선을 걷어내고 도구 활동으로 대체
        usedToolsThisTurn = true;
        this.history.push({ role: "assistant", content: answer, hidden: true });
        this.post({ type: "dropLastBot" });

        if (iter >= iterBudget) {
          if (this.isAutoMode()) {
            // ⚡ 자동 승인 모드: 묻지 않고 자동 연장 (중지 ■ 버튼이 유일한 제동)
            iterBudget += maxIterCfg;
            this.post({
              type: "system",
              text: `⚡ Auto-approve: tool-call limit automatically extended to ${iterBudget}.`,
            });
          } else {
            const pick = await this.raceAbort(
              vscode.window.showWarningMessage(
                `Nemotron tool calls reached ${iterBudget}. Continue?`,
                "Continue",
                "Stop"
              ),
              "Stop" as string | undefined
            );
            if (pick === "Continue") {
              iterBudget += maxIterCfg;
              this.post({
                type: "system",
                text: `▶️ Extended tool-call limit to ${iterBudget}.`,
              });
            } else {
              this.post({
                type: "system",
                text: `⚠️ Stopped at the tool-call limit (${iterBudget}). (Adjust the limit with /iterations)`,
              });
              break;
            }
          }
        }

        const results: ToolResult[] = [];
        for (const call of calls) {
          if (this.abort?.signal.aborted) {
            break;
          }
          this.post({
            type: "tool",
            name: call.name,
            detail: this.argSummary(call.name, call.args),
          });
          const res = await runTool(call, {
            confirmWrite: (p, s, proposed) => this.confirmWrite(p, s, proposed),
            confirmCommand: (c) => this.confirmCommand(c),
            recordBackup: (p, bytes) => this.recordBackup(p, bytes),
            shell: this.getShell(),
            runAgent: (a, t) => this.runSubAgent(a, t),
            updatePlan: (items) => {
              this.plan = items;
              this.post({ type: "plan", items });
            },
          });
          results.push(res);
          this.post({
            type: "toolResult",
            name: res.name,
            ok: res.ok,
            preview: res.preview,
            // 명령/sub-agent 실행은 사용자도 출력을 볼 수 있게 함께 표시
            output:
              res.name === "run_command" || res.name === "run_agent"
                ? res.output.slice(0, 4000)
                : undefined,
          });
        }

        // 도구 결과를 모델에 다시 전달 (숨김 턴)
        let feedback = results
          .map((r) => `[Tool ${r.name} result]\n${r.output}`)
          .join("\n\n");

        // ④ 편집 성공 시 해당 파일의 진단(오류/경고)을 자동으로 되돌려준다
        const editedPaths = Array.from(
          new Set(
            calls
              .filter(
                (c, idx) =>
                  results[idx]?.ok &&
                  ["edit_file", "apply_bytes", "write_file"].includes(c.name)
              )
              .map((c) => String(c.args?.path ?? ""))
              .filter((p) => p && !p.startsWith(".nemotron"))
          )
        );
        if (editedPaths.length) {
          for (const p of editedPaths) {
            try {
              // 닫힌 파일도 언어 서버가 분석하도록 유도한 뒤 진단 수집
              await ensureAnalyzed(p);
              let diag = formatDiagnostics(p, 30);
              // GDScript: LSP 진단이 비어 있으면 godot CLI 폴백
              if (diag === "(no errors or warnings)" && p.toLowerCase().endsWith(".gd")) {
                const gd = await checkGdScript(p);
                if (gd) {
                  diag = gd;
                }
              }
              feedback += `\n\n[Post-edit diagnostics: ${p}]\n${diag}`;
              const clean =
                diag.includes("no errors or warnings") || diag.includes("no syntax errors");
              if (!clean) {
                this.post({
                  type: "tool",
                  name: "Diagnostics",
                  detail: `${p} still has errors/warnings`,
                });
              }
            } catch {
              /* 진단 실패는 무시 */
            }
          }
        }

        this.history.push({ role: "user", content: feedback, hidden: true });
        // 턴 중간 저장: 강제 종료돼도 직전 도구 작업까지 기록 보존
        void this.autoSaveSession();

        // 중지(■)를 눌렀다면 다음 요청으로 넘어가지 않고 종료
        if (this.abort?.signal.aborted) {
          this.post({ type: "system", text: "⏹ Generation stopped." });
          break;
        }
        // 루프 계속 → 다음 응답 생성
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        if (lastAnswer) {
          this.history.push({ role: "assistant", content: lastAnswer });
        }
        this.post({ type: "botEnd" });
        this.post({ type: "system", text: "⏹ Generation stopped." });
      } else {
        this.post({ type: "botEnd" });
        this.post({ type: "error", text: String(err?.message ?? err) });
      }
    } finally {
      this.busy = false;
      this.liveAnswer = "";
      this.liveReasoning = "";
      this.abort = undefined;
      this.post({ type: "busy", value: false });
      void this.autoSaveSession(); // 세션 자동 저장
    }
  }

  private argSummary(name: string, args: any): string {
    if (name === "list_files") {
      return args?.glob ? String(args.glob) : "**/*";
    }
    if (
      name === "read_file" ||
      name === "write_file" ||
      name === "edit_file" ||
      name === "apply_bytes"
    ) {
      return String(args?.path ?? "");
    }
    if (name === "run_command") {
      return String(args?.command ?? "");
    }
    if (name === "get_diagnostics") {
      return args?.path ? String(args.path) : "all";
    }
    if (name === "search_text") {
      return String(args?.query ?? "");
    }
    if (name === "list_symbols") {
      return args?.path ? String(args.path) : String(args?.query ?? "");
    }
    if (name === "find_definition" || name === "find_references") {
      return String(args?.symbol ?? args?.path ?? "");
    }
    if (name === "update_plan") {
      return "update task plan";
    }
    if (name === "run_agent") {
      return String(args?.agent ?? "");
    }
    return "";
  }

  // ── HTML ──
  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "main.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "media", "main.css")
    );
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `font-src ${webview.cspSource};`;

    // 플러그인 버전·빌드 시각 (창 새로고침 후 새 빌드 적용 여부 확인용)
    const version = (this.ctx.extension.packageJSON as any).version;
    const build = buildTime();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Nemotron Chat</title>
</head>
<body data-version="v${version} · ${build}">
  <div id="topbar">
    <div id="session-title" title="Current session">New chat</div>
    <span id="version-tag" title="Build: ${build}">v${version} · ${build}</span>
    <div id="topbar-actions">
      <button id="btn-auto" class="topbtn" title="Auto-approve mode (/auto)">⚡</button>
      <button id="btn-history" class="topbtn" title="Session history (/history)">🕘</button>
      <button id="btn-new" class="topbtn" title="New session (/new)">➕</button>
    </div>
  </div>
  <div id="plan-panel" class="hidden"></div>
  <div id="chat"></div>
  <div id="input-bar">
    <div id="slash-menu" class="hidden"></div>
    <textarea id="prompt" rows="1"
      placeholder="Type a message…  ( / commands · Enter to send · Shift+Enter for newline)"></textarea>
    <button id="send-btn" title="Send">➤</button>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

/**
 * 응답이 "~하겠습니다" 류의 작업 예고로 끝났는지 감지.
 * (도구 호출 없이 말만 하고 끝낸 경우 → 자동으로 이어가기)
 */
/** 질문으로 끝나는지 (마크다운 기호 제거 후 판정) */
function endsWithQuestion(text: string): boolean {
  return /[??]\s*$/.test(text.trim().replace(/[*_`~\s")\]]+$/g, ""));
}

/** 응답 끝부분에 '작업 완료' 선언이 있는지 (한/영 이중언어) */
function declaresCompletion(text: string): boolean {
  const tail = text.trim().slice(-200);
  // 한국어 패턴
  if (/(작업[^\n]{0,12}완료|완료(하였|했)(습니다|어요)|모두\s*완료)/.test(tail)) {
    return true;
  }
  // 영어 패턴
  return /(task (is )?complete(d)?|all (steps|tasks) (are )?complete(d)?|work (is )?complete(d)?)/i.test(
    tail
  );
}

function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  // 질문으로 끝나면 사용자 응답을 기다리는 것
  if (endsWithQuestion(t)) {
    return false;
  }
  // 한국어: 끝의 마크다운/구두점/이모지 등 한글·영문·숫자가 아닌 문자를 모두 벗겨낸 뒤 종결어 판정
  const cleaned = t.replace(/[^가-힣a-zA-Z0-9]+$/g, "");
  const koTail = cleaned.slice(-60);
  if (
    /(겠습니다|하겠어요|할게요|할께요|볼게요|볼께요|해볼게요|진행합니다|시작합니다|시작하죠|해보죠|예정입니다|하겠음|할것입니다|할 것입니다)$/.test(
      koTail
    )
  ) {
    return true;
  }
  // 영어: 마지막 160자에서 마크다운 기호를 제거한 뒤 작업 예고 의도 패턴 판정
  // (아포스트로피와 .?! 는 패턴에 필요하므로 유지)
  const enTail = t.replace(/[^a-zA-Z0-9'?!.\s]+/g, " ").slice(-160);
  return /(let me|i('| wi)ll( now)?|now i('| wi)ll|going to|proceeding to)\b[^.?!]{0,80}$/i.test(
    enTail
  );
}

/** NVIDIA 가 발행(publisher: nvidia)한 대화형 LLM 인지 판별 */
function isNvidiaChatModel(id: string): boolean {
  if (!id.startsWith("nvidia/")) {
    return false;
  }
  // 채팅용이 아닌 도메인 NIM(임베딩/리랭커/음성/비전 파이프라인 등) 제외
  const nonChat =
    /embed|rerank|retriev|ocr|paddle|asr|tts|riva|parakeet|canary|maxine|studiovoice|eyecontact|background|bio|genmol|molmim|diffdock|corrdiff|fourcastnet|earth2|cuopt|clip|nvclip|vista|guard|safety|aegis|hifigan|fastpitch|megatron/i;
  if (nonChat.test(id)) {
    return false;
  }
  // LLM 계열 키워드
  return /nemotron|llama|instruct|chat|mistral|minitron|openmath|opencode|openreasoning/i.test(
    id
  );
}

/** 발행사와 무관하게 대화형(채팅) 모델인지 판별 (카탈로그 전체 탐색용) */
function isChatModel(id: string): boolean {
  // 비채팅 NIM(임베딩/음성/비전 파이프라인 등) + 이미지 생성 계열 제외
  const nonChat =
    /embed|rerank|retriev|ocr|paddle|asr|tts|riva|parakeet|canary|maxine|studiovoice|eyecontact|background|bio|genmol|molmim|diffdock|corrdiff|fourcastnet|earth2|cuopt|clip|nvclip|vista|guard|safety|aegis|hifigan|fastpitch|megatron|stable-diffusion|sdxl|flux|consistory|sana/i;
  if (nonChat.test(id)) {
    return false;
  }
  // 채팅 LLM 계열 키워드 (발행사 무관)
  return /nemotron|llama|qwen|deepseek|mistral|mixtral|gemma|phi-|granite|command|jamba|arctic|dbrx|instruct|chat|minitron|openmath|opencode|openreasoning/i.test(
    id
  );
}

/** 모델 ID → 짧은 sub-agent 이름 (예: nvidia/llama-3.1-nemotron-ultra-253b-v1 → nemotron-ultra-253b) */
function autoAgentName(id: string): string {
  let s = id.split("/").pop() ?? id;
  s = s
    .replace(/^llama-?3(\.\d+)?-/i, "")
    .replace(/-instruct$/i, "")
    .replace(/-v\d+(\.\d+)?$/i, "");
  return s.toLowerCase();
}

/** 모델 ID 키워드로 전문 분야 설명 추정 (카탈로그 API 는 설명을 제공하지 않음) */
function autoAgentDesc(id: string): string {
  const s = id.toLowerCase();
  if (/usdcode/.test(s)) {
    return "Specialized in OpenUSD (3D) code";
  }
  if (/opencode|coder|code/.test(s)) {
    return "Specialized in code generation, refactoring, and debugging";
  }
  if (/openmath|math/.test(s)) {
    return "Specialized in solving math problems and proofs";
  }
  if (/chatqa/.test(s)) {
    return "Specialized in document-grounded Q&A (RAG)";
  }
  if (/embedqa|nv-embed/.test(s)) {
    return "Embeddings (not for chat)";
  }
  if (/vision|-vl|neva|vila/.test(s)) {
    return "Image + text multimodal";
  }
  if (/openreasoning|reasoning/.test(s)) {
    return "Specialized in step-by-step reasoning (math, science, code)";
  }
  if (/ultra/.test(s)) {
    return "Top performance — hard reasoning and complex tasks (slow)";
  }
  if (/super/.test(s)) {
    return "Balanced — quality/speed tradeoff, general coding and summaries";
  }
  if (/nano|mini|micro|minitron/.test(s)) {
    return "Lightweight and fast — classification, short summaries, simple questions";
  }
  if (/340b|405b/.test(s)) {
    return "Very large general purpose — high quality (slow)";
  }
  if (/70b|49b|51b/.test(s)) {
    return "Mid-large general purpose — solid quality and speed";
  }
  if (/8b|9b|12b|4b/.test(s)) {
    return "Small general purpose — fast responses";
  }
  return "General purpose";
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
