// CLI 번들러: cli/src/main.ts + 공유 코어(../src/nemotron.ts)를 단일 CJS 로 묶는다.
// esbuild 는 저장소 루트 node_modules 에서 해석된다(별도 설치 불필요).
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/nemotron.cjs",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
console.log("[cli] build complete -> dist/nemotron.cjs");
