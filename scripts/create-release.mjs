import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import archiver from "archiver";
import path from "node:path";

const root = path.resolve(".");
const releaseDir = path.join(root, "release");
const packageName = "sevokecode-image-gen";
const installedBinary = "sevokecode-image-gen";
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = metadata.version;
const argv = process.argv.slice(2);
const platformFlagIndex = argv.indexOf("--platform");
if (platformFlagIndex !== -1 && (argv.length !== 2 || platformFlagIndex !== 0)) {
  throw new Error("Usage: node scripts/create-release.mjs [--platform <platform-id>]");
}
const requestedPlatform = platformFlagIndex === -1 ? undefined : argv[1];
const sharedFiles = [
  "SKILL.md",
  "config.json",
  path.join("agents", "openai.yaml"),
  path.join(".codex-plugin", "plugin.json"),
  "INSTALL.txt",
];
const platforms = [
  { id: "macos-arm64", binary: "sevokecode-image-gen-macos-arm64" },
  { id: "macos-x64", binary: "sevokecode-image-gen-macos-x64" },
];
const selectedPlatforms = requestedPlatform === undefined
  ? platforms
  : platforms.filter((platform) => platform.id === requestedPlatform);
if (selectedPlatforms.length === 0) throw new Error(`Unsupported release platform: ${requestedPlatform}`);

async function copyFile(relativePath, destinationRoot) {
  const destination = path.join(destinationRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, relativePath), destination);
}

async function copyRuntimeBinary(sourceName, destinationRoot) {
  const source = path.join(root, "bin", sourceName);
  const binDir = path.join(destinationRoot, "bin");
  await mkdir(binDir, { recursive: true });
  // New installers and the installed Skill use the stable entrypoint. Keep the
  // architecture-named symlink only so already-distributed v1.8.0 DMGs can
  // launch the current package they fetch from Gitee Latest. A relative link
  // adds no wrapper process and does not duplicate the large native binary.
  const destination = path.join(binDir, installedBinary);
  await cp(source, destination);
  await chmod(destination, 0o755);
  await symlink(installedBinary, path.join(binDir, sourceName));
}

async function zipDirectory(directoryName, archiveName) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(path.join(releaseDir, archiveName));
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    archive.directory(path.join(releaseDir, directoryName), directoryName);
    archive.finalize();
  });
}

async function writeChecksums() {
  const assets = (await readdir(releaseDir)).filter((name) => name.endsWith(".zip") || name.endsWith(".dmg")).sort();
  const checksums = await Promise.all(assets.map(async (name) => {
    const bytes = await readFile(path.join(releaseDir, name));
    return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`;
  }));
  await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });
const archives = [];
for (const platform of selectedPlatforms) {
  const directoryName = `${packageName}-${platform.id}`;
  const destination = path.join(releaseDir, directoryName);
  for (const relativePath of sharedFiles) await copyFile(relativePath, destination);
  await copyRuntimeBinary(platform.binary, destination);
  const archiveName = `${directoryName}-v${version}.zip`;
  await zipDirectory(directoryName, archiveName);
  archives.push(archiveName);
  await rm(destination, { recursive: true, force: true });
}
await writeChecksums();
process.stdout.write(`${JSON.stringify({ status: "success", version, platform: requestedPlatform ?? "all", release_dir: releaseDir, archives })}\n`);
