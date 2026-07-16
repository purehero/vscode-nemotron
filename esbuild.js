// esbuild 번들 스크립트: src/extension.ts -> out/extension.js
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// 빌드 시각 문자열 (로컬 시간 기준 "MM-DD HH:mm" 형식, 예: "07-16 14:23")
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const buildTime =
  `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}`;

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  // 빌드 시각을 소스에 주입 (chatView.ts 의 __BUILD_TIME__ 로 참조)
  define: { __BUILD_TIME__: JSON.stringify(buildTime) },
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching for changes...");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] build complete -> out/extension.js");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
