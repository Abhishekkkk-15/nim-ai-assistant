import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"'
  }
});

if (watch) {
  await ctx.watch();
  console.log("[nim-agent] esbuild watching...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
