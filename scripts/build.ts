#!/usr/bin/env bun
import { cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type BuildOptions, build, context } from "esbuild";

const APP = resolve(import.meta.dir, "..");
const DIST = join(APP, "dist");
const watch = process.argv.includes("--watch");

const manifest = JSON.parse(await readFile(join(APP, "manifest.json"), "utf8")) as {
  version: string;
};
const pkg = JSON.parse(await readFile(join(APP, "package.json"), "utf8")) as { version: string };
if (manifest.version !== pkg.version) {
  throw new Error(
    `manifest.json version ${manifest.version} != package.json ${pkg.version}. ` +
      `manifest.json is what Obsidian reads — run \`bun run version\` after editing it.`,
  );
}

const options: BuildOptions = {
  entryPoints: [join(APP, "src/main.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: join(DIST, "main.js"),
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "node:*",
  ],
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  minify: !watch,
};

await mkdir(DIST, { recursive: true });
await cp(join(APP, "manifest.json"), join(DIST, "manifest.json"));
await cp(join(APP, "styles.css"), join(DIST, "styles.css"));

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching src → dist/main.js");
} else {
  await build(options);
  console.log(`✓ build → dist (v${manifest.version})`);
}
