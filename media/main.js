// Nemotron 채팅 웹뷰 프런트엔드
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();

  const chat = document.getElementById("chat");
  const promptEl = document.getElementById("prompt");
  const sendBtn = document.getElementById("send-btn");
  const sessionTitleEl = document.getElementById("session-title");
  const planPanel = document.getElementById("plan-panel");

  document.getElementById("btn-new").addEventListener("click", () =>
    vscode.postMessage({ type: "command", name: "new" })
  );
  document.getElementById("btn-history").addEventListener("click", () =>
    vscode.postMessage({ type: "command", name: "history" })
  );
  const btnAuto = document.getElementById("btn-auto");
  btnAuto.addEventListener("click", () =>
    vscode.postMessage({ type: "command", name: "auto" })
  );

  let busy = false;
  let current = null; // 현재 봇 메시지 핸들 {body, thinkEl, thinkBody, answer, reasoning}

  // ── 입력 히스토리 (최근 10개, ↑/↓ 로 탐색) ──
  const HISTORY_MAX = 10;
  let inputHistory = (vscode.getState() || {}).inputHistory || [];
  let histIndex = -1; // -1 = 탐색 중 아님
  let draft = ""; // 탐색 시작 전 작성 중이던 내용

  function pushInputHistory(text) {
    histIndex = -1;
    if (!text.trim()) return;
    if (inputHistory[0] === text) return; // 직전과 같으면 중복 저장 안 함
    inputHistory.unshift(text);
    if (inputHistory.length > HISTORY_MAX) inputHistory.length = HISTORY_MAX;
    vscode.setState(Object.assign({}, vscode.getState() || {}, { inputHistory }));
  }
  function setPromptValue(text) {
    promptEl.value = text;
    promptEl.style.height = "auto";
    promptEl.style.height = Math.min(promptEl.scrollHeight, 160) + "px";
    promptEl.selectionStart = promptEl.selectionEnd = promptEl.value.length;
  }
  function cursorOnFirstLine() {
    return !promptEl.value.slice(0, promptEl.selectionStart).includes("\n");
  }
  function cursorOnLastLine() {
    return !promptEl.value.slice(promptEl.selectionEnd).includes("\n");
  }

  showEmptyHint();

  // ── 유틸 ──
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  function renderMarkdown(text) {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts
      .map((seg) => {
        if (seg.startsWith("```") && seg.endsWith("```")) {
          let inner = seg.slice(3, -3);
          inner = inner.replace(/^[^\n]*\n/, (m) =>
            m.trim().match(/^[a-zA-Z0-9+#.\-]+$/) ? "" : m
          );
          return "<pre><code>" + escapeHtml(inner.replace(/^\n/, "")) + "</code></pre>";
        }
        let h = escapeHtml(seg);
        h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        return h;
      })
      .join("");
  }
  // 스트리밍 중 ```tool 블록(파일 전체 내용 등)을 진행 표시 한 줄로 가린다.
  // 실행 후에는 어차피 🔧 도구 액티비티 라인으로 대체된다.
  function toolPlaceholder(body, done) {
    const lines = body.split(/\r?\n/);
    const name = (lines[0] || "").trim() || "tool";
    const pathM = body.match(/^(?:path|agent|command)\s*:\s*(.+)$/m);
    const target = pathM ? " " + pathM[1].trim() : "";
    const size = body.length.toLocaleString("en-US");
    return (
      "\n`🔧 " +
      name +
      target +
      (done ? "  — ready to call" : "  — writing… (" + size + " chars)") +
      "`\n"
    );
  }
  function maskToolBlocks(text) {
    // 완료된 tool 블록
    let out = text.replace(/```tool[^\S\n]*\r?\n([\s\S]*?)```/g, (m, body) =>
      toolPlaceholder(body, true)
    );
    // 진행 중(아직 닫히지 않은) tool 블록
    out = out.replace(/```tool[^\S\n]*\r?\n([\s\S]*)$/, (m, body) =>
      toolPlaceholder(body, false)
    );
    // 이제 막 시작된 "```tool" 펜스 자체
    out = out.replace(/```tool[^\S\n]*$/, "`🔧 Starting tool call…`");
    return out;
  }

  function scrollDown() {
    chat.scrollTop = chat.scrollHeight;
  }
  function clearEmptyHint() {
    const h = chat.querySelector(".empty-hint");
    if (h) h.remove();
  }
  function showEmptyHint() {
    if (chat.children.length === 0) {
      const d = document.createElement("div");
      d.className = "empty-hint";
      let text = "🤖 Nemotron-3-Ultra\nAsk me anything.";
      // 빌드 확인용: 버전·빌드 시각을 힌트 마지막 줄에 덧붙인다
      const ver = document.body.dataset.version;
      if (ver) text += "\n" + ver;
      d.textContent = text;
      chat.appendChild(d);
    }
  }

  // ── 메시지 추가 ──
  function addUser(text) {
    clearEmptyHint();
    const d = document.createElement("div");
    d.className = "msg user";
    d.innerHTML = '<div class="role">👤 You</div><div class="body"></div>';
    d.querySelector(".body").textContent = text;
    chat.appendChild(d);
    scrollDown();
  }
  function addBot() {
    clearEmptyHint();
    const d = document.createElement("div");
    d.className = "msg bot";
    d.innerHTML =
      '<div class="role">🤖 Nemotron</div>' +
      '<details class="think" open style="display:none;">' +
      '<summary>💭 Thinking</summary><div class="think-body"></div></details>' +
      '<div class="body cursor"></div>';
    chat.appendChild(d);
    current = {
      root: d,
      body: d.querySelector(".body"),
      thinkEl: d.querySelector(".think"),
      thinkBody: d.querySelector(".think-body"),
      answer: "",
      reasoning: "",
    };
    scrollDown();
  }
  function addSys(text) {
    const d = document.createElement("div");
    d.className = "sys-line";
    d.textContent = text;
    chat.appendChild(d);
    scrollDown();
  }
  function addErr(text) {
    clearEmptyHint();
    const d = document.createElement("div");
    d.className = "err-line";
    d.textContent = "❌ " + text;
    chat.appendChild(d);
    scrollDown();
  }
  function addTool(text, cls) {
    clearEmptyHint();
    const d = document.createElement("div");
    d.className = "tool-line" + (cls ? " " + cls : "");
    d.textContent = text;
    chat.appendChild(d);
    scrollDown();
  }
  // 코드블록에 복사/적용/새파일 버튼 바 부착
  function decorateCodeBlocks(root) {
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.parentElement && pre.parentElement.classList.contains("codewrap")) return;
      const codeEl = pre.querySelector("code");
      const codeText = (codeEl ? codeEl.textContent : pre.textContent) || "";
      if (!codeText.trim()) return;
      const wrap = document.createElement("div");
      wrap.className = "codewrap";
      const bar = document.createElement("div");
      bar.className = "codebar";
      [
        ["📋 Copy", "copy"],
        ["📝 Apply to Editor", "apply"],
        ["➕ New File", "newfile"],
      ].forEach(([label, act]) => {
        const b = document.createElement("button");
        b.className = "codebtn";
        b.textContent = label;
        b.addEventListener("click", () =>
          vscode.postMessage({ type: "codeAction", action: act, code: codeText })
        );
        bar.appendChild(b);
      });
      pre.replaceWith(wrap);
      wrap.appendChild(bar);
      wrap.appendChild(pre);
    });
  }

  function addToolOutput(text) {
    const pre = document.createElement("pre");
    pre.className = "tool-output";
    pre.textContent = text;
    chat.appendChild(pre);
    scrollDown();
  }
  // ── 작업 계획 패널 렌더링 ──
  function renderPlan(items) {
    if (!Array.isArray(items) || items.length === 0) {
      planPanel.classList.add("hidden");
      planPanel.innerHTML = "";
      return;
    }
    const done = items.filter((it) => it && it.done).length;
    planPanel.innerHTML = "";
    const header = document.createElement("div");
    header.className = "plan-header";
    header.textContent = "📋 Plan (" + done + "/" + items.length + ")";
    planPanel.appendChild(header);
    const list = document.createElement("div");
    list.className = "plan-list";
    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "plan-item" + (it && it.done ? " done" : "");
      const mark = document.createElement("span");
      mark.className = "plan-mark";
      mark.textContent = it && it.done ? "✅" : "⬜";
      const label = document.createElement("span");
      label.className = "plan-text";
      label.textContent = (it && it.text) || "";
      row.appendChild(mark);
      row.appendChild(label);
      list.appendChild(row);
    });
    planPanel.appendChild(list);
    planPanel.classList.remove("hidden");
  }

  function dropLastBot() {
    const bots = chat.querySelectorAll(".msg.bot");
    const last = bots[bots.length - 1];
    if (last) last.remove();
    current = null;
  }

  function setBusy(v) {
    busy = v;
    if (v) {
      sendBtn.textContent = "■";
      sendBtn.classList.add("stop");
      sendBtn.title = "Stop";
    } else {
      sendBtn.textContent = "➤";
      sendBtn.classList.remove("stop");
      sendBtn.title = "Send";
      promptEl.focus();
    }
  }

  // ── 확장 → 웹뷰 ──
  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "userMessage":
        addUser(m.text);
        break;
      case "botStart":
        addBot();
        break;
      case "reasoning":
        if (!current) addBot();
        current.reasoning += m.text;
        current.thinkEl.style.display = "";
        current.thinkBody.textContent = current.reasoning;
        scrollDown();
        break;
      case "content":
        if (!current) addBot();
        current.answer += m.text;
        current.body.innerHTML = renderMarkdown(maskToolBlocks(current.answer));
        current.body.classList.add("cursor");
        scrollDown();
        break;
      case "botEnd":
        if (current) {
          current.body.classList.remove("cursor");
          if (current.reasoning) current.thinkEl.open = false;
          if (!current.answer && !current.reasoning)
            current.body.textContent = "(empty response)";
          decorateCodeBlocks(current.body);
          current = null;
        }
        break;
      case "system":
        addSys(m.text);
        break;
      case "dropLastBot":
        dropLastBot();
        break;
      case "tool":
        addTool("🔧 " + m.name + (m.detail ? "  " + m.detail : ""), "tool-call");
        break;
      case "toolResult":
        addTool(
          (m.ok ? "  ↳ ✅ " : "  ↳ ⚠️ ") + (m.preview || m.name),
          m.ok ? "" : "tool-fail"
        );
        if (m.output) addToolOutput(m.output);
        break;
      case "error":
        if (current) {
          current.body.classList.remove("cursor");
          if (!current.answer) current.root.remove();
          current = null;
        }
        addErr(m.text);
        break;
      case "busy":
        setBusy(!!m.value);
        break;
      case "sessionTitle":
        sessionTitleEl.textContent = m.text || "New chat";
        sessionTitleEl.title = m.text || "Current session";
        break;
      case "autoMode":
        btnAuto.classList.toggle("auto-on", !!m.value);
        btnAuto.title = m.value
          ? "Auto-approve mode ON — click to turn off (/auto)"
          : "Auto-approve mode OFF — click to turn on (/auto)";
        break;
      case "plan":
        renderPlan(m.items);
        break;
      case "clear":
        chat.innerHTML = "";
        current = null;
        showEmptyHint();
        break;
    }
  });

  // ── 슬래시(/) 명령어 메뉴 ──
  const COMMANDS = [
    { name: "continue", desc: "▶️ Continue the previous task" },
    { name: "new", desc: "Start a new session (current session auto-saved)" },
    { name: "history", desc: "View/restore/delete session history" },
    { name: "init", desc: "Auto-create (AI analysis)/open NEMOTRON.md" },
    { name: "auto", desc: "⚡ Toggle auto-approve mode (skip confirmations)" },
    { name: "agents", desc: "sub-agent (specialized model) list/settings" },
    { name: "model", desc: "Select the model to use" },
    { name: "system", desc: "Edit the system prompt" },
    { name: "temperature", desc: "Adjust temperature (creativity)" },
    { name: "topp", desc: "Adjust top_p (cumulative probability)" },
    { name: "maxtokens", desc: "Maximum tokens to generate" },
    { name: "reasoning", desc: "Reasoning budget (tokens)" },
    { name: "rpm", desc: "Limit requests per minute (RPM)" },
    { name: "iterations", desc: "Set the tool-call limit (round trips)" },
    { name: "thinking", desc: "Toggle thinking process display" },
    { name: "tools", desc: "Toggle file tools" },
    { name: "context", desc: "Toggle auto-attach of active file/selection" },
    { name: "autowrite", desc: "Toggle auto-approve for file writes" },
    { name: "autorun", desc: "Toggle auto-approve for terminal commands" },
    { name: "apikey", desc: "Set the NVIDIA API key" },
    { name: "settings", desc: "Open the settings screen" },
    { name: "usage", desc: "View token usage" },
    { name: "undo", desc: "Undo the last AI file edit" },
    { name: "save", desc: "Save the current conversation" },
    { name: "load", desc: "Load a saved conversation" },
    { name: "diff", desc: "Toggle diff preview on change approval" },
    { name: "shell", desc: "Toggle persistent terminal session" },
    { name: "clear", desc: "Clear the conversation" },
  ];
  const slashMenu = document.getElementById("slash-menu");
  let slashOpen = false;
  let slashItems = [];
  let slashIndex = 0;

  function slashFilter() {
    const v = promptEl.value;
    // 맨 앞이 '/' 이고 공백/줄바꿈이 없을 때만 명령 모드
    if (!v.startsWith("/") || /\s/.test(v)) return null;
    return v.slice(1).toLowerCase();
  }
  function updateSlash() {
    const f = slashFilter();
    if (f === null) {
      closeSlash();
      return;
    }
    slashItems = COMMANDS.filter((c) => c.name.startsWith(f));
    if (slashItems.length === 0) {
      closeSlash();
      return;
    }
    slashIndex = 0;
    renderSlash();
    slashMenu.classList.remove("hidden");
    slashOpen = true;
  }
  function renderSlash() {
    slashMenu.innerHTML = "";
    slashItems.forEach((c, i) => {
      const d = document.createElement("div");
      d.className = "slash-item" + (i === slashIndex ? " active" : "");
      d.innerHTML = '<span class="cmd"></span><span class="desc"></span>';
      d.querySelector(".cmd").textContent = "/" + c.name;
      d.querySelector(".desc").textContent = c.desc;
      d.addEventListener("mousedown", (e) => {
        e.preventDefault();
        runCommand(c.name);
      });
      slashMenu.appendChild(d);
    });
    const active = slashMenu.querySelector(".slash-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  function moveSlash(delta) {
    slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
    renderSlash();
  }
  function closeSlash() {
    slashOpen = false;
    slashMenu.classList.add("hidden");
    slashMenu.innerHTML = "";
  }
  function runCommand(name) {
    closeSlash();
    promptEl.value = "";
    promptEl.style.height = "auto";
    vscode.postMessage({ type: "command", name });
  }

  // ── 웹뷰 → 확장 ──
  function send() {
    const text = promptEl.value.trim();
    if (!text || busy) return;
    pushInputHistory(text);
    promptEl.value = "";
    promptEl.style.height = "auto";
    vscode.postMessage({ type: "send", text });
  }

  sendBtn.addEventListener("click", () => {
    if (busy) vscode.postMessage({ type: "stop" });
    else send();
  });

  promptEl.addEventListener("keydown", (e) => {
    // IME(한글/일본어/중국어 등) 조합 중에는 Enter 가 '조합 확정'이므로 여기서
    // 가로채면 안 된다. 조합 중 Enter 를 send 로 처리하면 마지막 글자가 중복 입력된다.
    if (e.isComposing || e.keyCode === 229) return;
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSlash(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSlash(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        runCommand(slashItems[slashIndex].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlash();
        return;
      }
    }
    // ↑/↓ : 최근 입력 히스토리 탐색 (커서가 첫/마지막 줄일 때만)
    if (e.key === "ArrowUp" && inputHistory.length && cursorOnFirstLine()) {
      if (histIndex === -1) draft = promptEl.value;
      if (histIndex < inputHistory.length - 1) {
        histIndex++;
        setPromptValue(inputHistory[histIndex]);
      }
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" && histIndex >= 0 && cursorOnLastLine()) {
      histIndex--;
      setPromptValue(histIndex === -1 ? draft : inputHistory[histIndex]);
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  promptEl.addEventListener("input", () => {
    promptEl.style.height = "auto";
    promptEl.style.height = Math.min(promptEl.scrollHeight, 160) + "px";
    histIndex = -1; // 직접 수정하면 히스토리 탐색 종료
    updateSlash();
  });
  promptEl.addEventListener("blur", () => setTimeout(closeSlash, 120));

  vscode.postMessage({ type: "ready" });
})();
