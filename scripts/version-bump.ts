#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const APP = resolve(import.meta.dir, "..");

const manifest = JSON.parse(await readFile(join(APP, "manifest.json"), "utf8")) as {
  version: string;
  minAppVersion: string;
};
const versions = JSON.parse(await readFile(join(APP, "versions.json"), "utf8")) as Record<
  string,
  string
>;
const pkg = JSON.parse(await readFile(join(APP, "package.json"), "utf8")) as Record<
  string,
  unknown
>;

versions[manifest.version] = manifest.minAppVersion;
pkg.version = manifest.version;

await writeFile(join(APP, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
await writeFile(join(APP, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`✓ ${manifest.version} (minAppVersion ${manifest.minAppVersion})`);
