<!-- 장기 메모리(자기 학습) MVP 계획·결정 노트 -->
# 장기 메모리(Long-term Memory) MVP

AI가 세션을 넘어 교훈·선호·규약을 스스로 기록/참조/수정하여 같은 실수를 반복하지 않게 하는 기능.

## 설계 결정
- **저장소**: `.nemotron/memory/<id>.md` (프로젝트 스코프). 파일 1개 = 메모리 1개. 프런트매터(`category`, `created`) + 본문.
  - `.nemotron/chats`, `NEMOTRON.md`와 동일한 위치 규약. 전역(사용자) 스코프는 후속 과제.
- **도구**(기존 `update_plan`/`run_agent` 패턴 재사용): `remember`, `update_memory`, `forget`.
  - 파서 수정 불필요 — `<<<CONTENT` 블록 + `key: value`(category/id)를 그대로 사용.
- **자동 주입**: `buildMessages()`에서 `projectDoc` 주입 지점 옆에 `[Long-term memory]` 블록 삽입. id 포함(모델이 update/forget 참조).
- **승인 정책**: 메모리는 `.nemotron/` 내 소형 노트이므로 write_file 같은 diff 모달을 거치지 않고 **즉시 기록 + 채팅에 명시(🧠)** → `forget`으로 즉시 되돌릴 수 있게. (권장했던 "확인 후 저장"의 취지를 모달 없이 "가시성+되돌리기"로 충족)
- **게이트**: 설정 `nemotron.enableMemory`(기본 true), 주입 예산 `nemotron.maxMemoryChars`(기본 8000).

## 체크리스트
- [x] tools.ts: TOOL_NAMES에 remember/update_memory/forget 추가
- [x] tools.ts: 메모리 저장소 헬퍼(listMemories/parseMemory/formatMemoriesForPrompt) + MEMORY_INSTRUCTION
- [x] tools.ts: runTool에 3개 case 추가
- [x] chatView.ts: loadMemories 캐시 + buildMessages 주입 + MEMORY_INSTRUCTION 부착
- [x] package.json: enableMemory / maxMemoryChars 설정 추가
- [x] typecheck + build 통과 (parse/format 로직 node 단위 검증)
- [x] 커밋

## 후속(이번 범위 아님)
- 실수 자동 트리거(/undo·diff 거부·명령 실패 → "기억할까요?")
- 전역 스코프, relevance 필터, 통합/정리 서브에이전트, 메모리 관리 UI
