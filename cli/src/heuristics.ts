// 응답 상태 판정 휴리스틱 (확장 chatView 와 동일 규칙). 한/영 이중언어.

export function endsWithQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text.trim().replace(/[*_`~\s")\]]+$/g, ""));
}

/** 응답 끝부분에 '작업 완료' 선언이 있는지 */
export function declaresCompletion(text: string): boolean {
  const tail = text.trim().slice(-200);
  if (/(작업[^\n]{0,12}완료|완료(하였|했)(습니다|어요)|모두\s*완료)/.test(tail)) {
    return true;
  }
  return /(task (is )?complete(d)?|all (steps|tasks) (are )?complete(d)?|work (is )?complete(d)?)/i.test(
    tail
  );
}

/** '~하겠습니다' 처럼 작업을 예고만 하고 멈춘 미완성 응답인지 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return false;
  }
  if (endsWithQuestion(t)) {
    return false;
  }
  const cleaned = t.replace(/[^가-힣a-zA-Z0-9]+$/g, "");
  const koTail = cleaned.slice(-60);
  if (
    /(겠습니다|하겠어요|할게요|할께요|볼게요|볼께요|해볼게요|진행합니다|시작합니다|시작하죠|해보죠|예정입니다|하겠음|할것입니다|할 것입니다)$/.test(
      koTail
    )
  ) {
    return true;
  }
  const enTail = t.replace(/[^a-zA-Z0-9'?!.\s]+/g, " ").slice(-160);
  return /(let me|i('| wi)ll( now)?|now i('| wi)ll|going to|proceeding to)\b[^.?!]{0,80}$/i.test(
    enTail
  );
}
