import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const check = args.includes("--check");
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(root, "src/workflows/coiParserContract.ts");
const source = await readFile(sourcePath, "utf8");
const denoSource = source.replace('from "zod"', 'from "npm:zod@3.25.76"');
const targets: Array<[string, string]> = [
  [resolve(root, "supabase/functions/_shared/coiParserContract.ts"), denoSource],
];

const vendorclearDir = valueAfter("--vendorclear-dir");
if (vendorclearDir) {
  const vendorRoot = resolve(root, vendorclearDir);
  targets.push(
    [resolve(vendorRoot, "supabase/functions/_shared/coiParserContract.ts"), denoSource],
    [resolve(vendorRoot, "src/lib/coiParserContract.generated.ts"), source],
  );
}

let stale = false;
for (const [target, content] of targets) {
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch {
    // A missing target is stale in check mode and created in sync mode.
  }
  if (current === content) continue;
  stale = true;
  if (!check) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    console.log(`synced ${target}`);
  } else {
    console.error(`stale ${target}`);
  }
}

if (check && stale) process.exitCode = 1;
