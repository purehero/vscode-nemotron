// 간단한 라인 단위 diff (LCS). 승인 전 변경 미리보기용.
// 반환: 각 줄 앞에 "+ "(추가) / "- "(삭제) / "  "(공통) 접두. main 에서 색을 입힌다.

export function diffLines(before: string, after: string): string {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;

  // LCS 길이 테이블
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push("  " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push("- " + a[i]);
      i++;
    } else {
      out.push("+ " + b[j]);
      j++;
    }
  }
  while (i < n) out.push("- " + a[i++]);
  while (j < m) out.push("+ " + b[j++]);

  // 변경 없는 큰 공통 구간은 접어서 짧게 (앞뒤 맥락 3줄만)
  return collapse(out, 3);
}

function collapse(lines: string[], ctx: number): string {
  const keep = new Array(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    if (lines[k][0] !== " ") {
      for (let d = -ctx; d <= ctx; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < lines.length) keep[idx] = true;
      }
    }
  }
  const res: string[] = [];
  let skipped = 0;
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) {
      if (skipped > 0) {
        res.push(`  … (${skipped} unchanged line${skipped > 1 ? "s" : ""})`);
        skipped = 0;
      }
      res.push(lines[k]);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) res.push(`  … (${skipped} unchanged line${skipped > 1 ? "s" : ""})`);
  return res.join("\n");
}
