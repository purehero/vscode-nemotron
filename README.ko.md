# Nemotron Chat — VSCode 확장

NVIDIA **Nemotron-3-Ultra** 모델을 VSCode 안에서 사용하는 AI 채팅 & 코드 도우미 확장입니다.
익스텐션 호스트(Node.js)에서 API를 직접 호출하므로 CORS 문제가 없습니다.

## 기능

- **채팅 사이드바** — 좌측 활동 표시줄의 Nemotron 아이콘. 실시간 스트리밍 응답, 문맥 기억, `💭 사고 과정(reasoning)` 접이식 표시
- **코드 명령** — 편집기에서 코드 선택 후 우클릭:
  - `Nemotron: 선택 코드 설명`
  - `Nemotron: 선택 코드 리팩터링`
  - `Nemotron: 선택 코드 주석/문서화`
- **파일 도구(에이전트)** — AI가 워크스페이스 파일을 직접 다룹니다:
  - `list_files` — 파일 목록 조회
  - `read_file` — 파일 내용 읽기
  - `edit_file` — 파일의 일부만 교체(부분 수정, 전체 재작성 방지). 내용은 JSON 이 아니라 `<<<OLD/<<<NEW/<<<END` 블록으로 원문 그대로 전달
  - `apply_bytes` — 변경 전/후 내용을 담은 파일명을 받아 **바이트 단위**로 부분 수정 (특수문자/대용량용, 디코딩·이스케이프 없음)
  - `write_file` — 새 파일 생성/전체 교체 (기본적으로 쓰기 시 확인창)
  - `run_command` — 터미널 명령 실행 후 출력 확인 (디버깅; 승인 필요). 예: "실행해보고 에러 고쳐줘". 지속 셸에서 cd/venv 를 유지한 채 실행하며, 타임아웃 없이 **명령이 끝날 때까지 기다립니다**(대기 중 경과 시간이 채팅에 1초마다 갱신). `background: true` 는 스스로 종료되지 않는 프로세스(개발 서버 등)를 기다리지 않고 시작할 때만 사용
  - `get_diagnostics` — 편집기의 오류/경고(Problems) 목록 확인 (실행 없이 문법/타입 오류 진단)
  - `search_text` — 파일 내용 텍스트/정규식 검색 (grep). 큰 프로젝트에서 위치 탐색용
  - `run_agent` — **특화 모델(sub-agent)에게 하위 작업 위임**. 기본 제공: `coder`(코드 특화), `reasoner`(추론 특화), `fast`(빠른 범용). `nemotron.agents` 설정에서 자유롭게 추가/변경, `/agents`로 목록 확인
- **코딩 컨텍스트 자동 첨부** — 메시지를 보낼 때 **활성 파일·선택 영역·커서 위치**가 자동으로 전달됩니다 (`/context`로 on/off). 메시지에 `@파일명.py` 처럼 쓰면 해당 파일이 첨부됩니다 (최대 5개).
- **편집 후 자동 검증** — AI가 파일을 수정하면 해당 파일의 진단(오류/경고)이 자동으로 AI에게 전달되어 스스로 후속 수정합니다.
- **diff 승인** — 파일 변경 승인 시 네이티브 diff 뷰로 전/후를 비교하고 허용/거부 (`/diff`로 on/off)
- **/undo** — 마지막 AI 파일 편집 되돌리기 (최근 20개 백업)
- **세션 관리** — `/new` 새 세션 시작(이전 세션 자동 저장), `/history` 세션 목록에서 복원/삭제. 매 응답 후 자동 저장되어 창을 닫아도 유지됩니다 (확장 전용 저장소).
- **/save, /load** — 대화를 `.nemotron/chats/`에 파일로 내보내기·가져오기 (팀 공유용)
- **코드블록 버튼** — 응답 코드블록마다 📋 복사 / 📝 편집기에 적용 / ➕ 새 파일
- **퀵픽스(💡)** — 에러 밑줄에서 `Ctrl+.` → "🤖 Nemotron으로 수정" 선택 시 자동 진단·수정
- **NEMOTRON.md** — 워크스페이스 루트에 두면 프로젝트 지침으로 시스템 프롬프트에 자동 포함
- **지속 터미널** — run_command 사이에 cd/가상환경 유지 (`/shell`로 on/off)
- **컨텍스트 길이 관리** — 대화가 길어지면 오래된 메시지를 자동 생략 (`nemotron.maxContextChars`)
  - 예: "src 폴더 구조 보여줘", "extension.ts 읽고 요약해줘", "README에 사용법 추가해줘"
  - 설정: `nemotron.enableTools`(사용), `nemotron.autoApproveWrites`(쓰기 자동 승인)
  - 신뢰된 워크스페이스(Trusted)에서만 동작합니다.
- **별도 창** — 채팅 사이드바 상단 ⧉ 버튼 → 편집기 탭 → 드래그로 새 창 분리
- **API 키 안전 저장** — VSCode **SecretStorage**(암호화)에 보관. 명령 `Nemotron: API 키 설정`
- **설정** — `settings.json` 의 `nemotron.*` (model, systemPrompt, temperature, topP, maxTokens, reasoningBudget, enableThinking)

## 개발/실행 방법

```bash
cd vscode-nemotron
npm install          # 의존성 설치
npm run build        # out/extension.js 생성 (esbuild)
```

그런 다음 이 폴더를 VSCode로 열고 **F5**(Run Extension)를 누르면 확장이 로드된 새 창이 뜹니다.

1. 좌측 활동 표시줄에서 **Nemotron** 아이콘 클릭
2. 명령 팔레트(Ctrl+Shift+P) → `Nemotron: API 키 설정` 으로 `nvapi-...` 키 입력
3. 채팅창에 메시지 입력 후 Enter

## 패키징(.vsix 설치 파일 만들기)

```bash
npm install -g @vscode/vsce
vsce package
```

생성된 `nemotron-chat-0.1.0.vsix` 를 VSCode 확장 뷰 → `...` → `VSIX에서 설치`로 설치할 수 있습니다.

## API 참고

- 엔드포인트: `https://integrate.api.nvidia.com/v1/chat/completions` (OpenAI 호환)
- 모델: `nvidia/nemotron-3-ultra-550b-a55b`
- 스트리밍 SSE 에서 `delta.reasoning_content`(사고) 와 `delta.content`(답변) 를 구분해 표시
