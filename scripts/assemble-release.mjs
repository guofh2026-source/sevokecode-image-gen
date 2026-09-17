import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(".");
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = metadata.version;
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--input-dir") {
  throw new Error("Usage: node scripts/assemble-release.mjs --input-dir <directory-with-platform-assets>");
}

const inputDir = path.resolve(args[1]);
const releaseDir = path.join(root, "release");
const assets = [
  `sevokecode-image-gen-macos-arm64-v${version}.zip`,
  `sevokecode-image-gen-macos-x64-v${version}.zip`,
  `sevokecode-image-gen-installer-macos-arm64-v${version}.dmg`,
  `sevokecode-image-gen-installer-macos-x64-v${version}.dmg`,
];

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
for (const asset of assets) await cp(path.join(inputDir, asset), path.join(releaseDir, asset));
const checksums = await Promise.all(assets.map(async (asset) => {
  const bytes = await readFile(path.join(releaseDir, asset));
  return `${createHash("sha256").update(bytes).digest("hex")}  ${asset}`;
}));
await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
process.stdout.write(`${JSON.stringify({ status: "success", version, release_dir: releaseDir, assets: [...assets, "SHA256SUMS.txt"] })}\n`);
