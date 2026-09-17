import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function packageDirectory() {
  if (process.platform === "darwin" && process.arch === "arm64") return "sevokecode-image-gen-macos-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "sevokecode-image-gen-macos-x64";
  throw new Error(`Unsupported packaged E2E platform: ${process.platform}-${process.arch}`);
}

const directoryName = packageDirectory();
const releaseDir = path.resolve("release");
const archiveName = (await readdir(releaseDir)).find((name) => name.startsWith(`${directoryName}-v`) && name.endsWith(".zip"));
if (!archiveName) throw new Error(`Release archive was not found for ${directoryName}.`);

const extractRoot = await mkdtemp(path.join(os.tmpdir(), "sevokecodes packaged archive "));
await execFileAsync("tar", [
  "-xf",
  path.join(releaseDir, archiveName),
  "-C",
  extractRoot,
]);
const result = await execFileAsync(process.execPath, [
  "scripts/tests/packaged-e2e.mjs",
  "--package-root",
  path.join(extractRoot, directoryName),
], { maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
