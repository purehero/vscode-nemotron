import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";

const SECRET_KEY = "nemotron.apiKey";
const MOVED_KEY = "nemotron.movedToSecondarySideBar";

/** 채팅 뷰를 우측 보조 사이드바(Secondary Side Bar)로 이동 */
async function moveChatToSecondarySideBar(): Promise<void> {
  // 뷰에 포커스를 준 뒤 '포커스된 뷰 이동' 명령 실행
  await vscode.commands.executeCommand("nemotron.chatView.focus");
  await new Promise((r) => setTimeout(r, 400));
  await vscode.commands.executeCommand(
    "workbench.action.moveViewToSecondarySideBar"
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context);

  // 시작 시 마지막 세션 자동 복원 (nemotron.restoreLastSession)
  void provider.restoreLastSession();

  // 최초 1회: Claude Code 처럼 우측 보조 사이드바에 배치
  // (이후 위치는 VSCode 가 기억하므로 다시 이동하지 않음)
  if (!context.globalState.get<boolean>(MOVED_KEY)) {
    void (async () => {
      try {
        await moveChatToSecondarySideBar();
        await context.globalState.update(MOVED_KEY, true);
      } catch {
        /* 명령 미지원 등 — 좌측 사이드바로 유지 */
      }
    })();
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nemotron.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "NVIDIA API Key",
        prompt: "Enter an API key in the nvapi-... format (get one at build.nvidia.com)",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "nvapi-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      });
      if (key !== undefined) {
        await context.secrets.store(SECRET_KEY, key.trim());
        vscode.window.showInformationMessage("✅ NVIDIA API key saved.");
      }
    }),

    vscode.commands.registerCommand("nemotron.clearApiKey", async () => {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage("NVIDIA API key deleted.");
    }),

    vscode.commands.registerCommand("nemotron.newChat", () => {
      void provider.newSession();
    }),

    vscode.commands.registerCommand("nemotron.showHistory", () => {
      void provider.showHistory();
    }),

    vscode.commands.registerCommand("nemotron.moveToSecondaryBar", async () => {
      try {
        await moveChatToSecondarySideBar();
      } catch (e: any) {
        vscode.window.showWarningMessage(
          "Move failed: " +
            String(e?.message ?? e) +
            " — you can also drag the Nemotron icon to the secondary side bar."
        );
      }
    }),

    vscode.commands.registerCommand("nemotron.openInEditor", () => {
      provider.openInEditor();
    }),

    vscode.commands.registerCommand("nemotron.explainSelection", () =>
      runOnSelection(provider, "Explain the following code in detail:")
    ),
    vscode.commands.registerCommand("nemotron.refactorSelection", () =>
      runOnSelection(
        provider,
        "Refactor the following code to be more readable and efficient, and explain the reasons for the changes:"
      )
    ),
    vscode.commands.registerCommand("nemotron.documentSelection", () =>
      runOnSelection(
        provider,
        "Write the full code with appropriate comments/documentation comments (docstrings) added to the following code:"
      )
    ),

    // 에러 전구(💡) 퀵픽스 → Nemotron 에게 수정 요청
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new NemotronQuickFixProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.commands.registerCommand(
      "nemotron.fixDiagnostic",
      async (uri: vscode.Uri, diag: vscode.Diagnostic) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const rel = vscode.workspace.asRelativePath(uri, false);
        const line = diag.range.start.line;
        const from = Math.max(0, line - 10);
        const to = Math.min(doc.lineCount - 1, line + 10);
        const excerpt = doc.getText(
          new vscode.Range(from, 0, to, doc.lineAt(to).text.length)
        );
        const sev =
          diag.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
        const prompt =
          `File ${rel} has the following ${sev} on line ${line + 1}:\n` +
          `${diag.message}\n\n` +
          `Surrounding code (lines ${from + 1}-${to + 1}):\n` +
          `\`\`\`${doc.languageId}\n${excerpt}\n\`\`\`\n\n` +
          `Diagnose the cause and fix this problem with the edit_file tool.`;
        await provider.sendUserPrompt(prompt);
      }
    )
  );
}

/** 진단이 있는 위치에 "Nemotron으로 수정" 퀵픽스를 제공 */
class NemotronQuickFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      if (diag.severity > vscode.DiagnosticSeverity.Warning) {
        continue;
      }
      const title = `🤖 Fix with Nemotron: ${diag.message.slice(0, 60)}`;
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.command = {
        command: "nemotron.fixDiagnostic",
        title,
        arguments: [document.uri, diag],
      };
      actions.push(action);
    }
    return actions;
  }
}

async function runOnSelection(
  provider: ChatViewProvider,
  instruction: string
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor.");
    return;
  }
  const selected = editor.document.getText(editor.selection);
  const code = selected.trim() ? selected : editor.document.getText();
  if (!code.trim()) {
    vscode.window.showWarningMessage("Select some code or open a file with content.");
    return;
  }
  const lang = editor.document.languageId;
  const prompt = `${instruction}\n\n\`\`\`${lang}\n${code}\n\`\`\``;
  await provider.sendUserPrompt(prompt);
}

export function deactivate(): void {
  /* no-op */
}
