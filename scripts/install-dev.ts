#!/usr/bin/env bun
import { cp, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const APP = resolve(import.meta.dir, "..");
const DIST = join(APP, "dist");
const vault = process.env.OBSIDIAN_VAULT;

if (!vault) {
  throw new Error("Set OBSIDIAN_VAULT to your vault folder, e.g. OBSIDIAN_VAULT=~/vaults/notes");
}
if (!(await stat(join(vault, ".obsidian")).catch(() => null))) {
  throw new Error(`${vault} has no .obsidian folder — is it a vault?`);
}

const target = join(vault, ".obsidian", "plugins", "youspot");
await mkdir(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await cp(join(DIST, file), join(target, file));
}
console.log(`✓ installed → ${target} (reload Obsidian or toggle the plugin)`);
