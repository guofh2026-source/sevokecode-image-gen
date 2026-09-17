import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(".");
const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--platform" || !["macos-arm64", "macos-x64"].includes(args[1])) {
  throw new Error("Usage: node scripts/build-macos-installer.mjs --platform <macos-arm64|macos-x64>");
}

const platform = args[1];
const architecture = platform === "macos-arm64" ? "arm64" : "x86_64";
const compileFlag = platform === "macos-arm64" ? "-DAPPLE_SILICON" : "-DINTEL_MAC";
const version = metadata.version;
const appName = "Sevokecode Image Gen Installer.app";
const buildRoot = path.join(root, "build", `macos-installer-${platform}`);
const appRoot = path.join(buildRoot, appName);
const contents = path.join(appRoot, "Contents");
const executable = path.join(contents, "MacOS", "SevokecodeImageGenInstaller");
const dmgStage = path.join(buildRoot, "dmg");
const releaseDir = path.join(root, "release");
const dmgName = `sevokecode-image-gen-installer-${platform}-v${version}.dmg`;
const dmgPath = path.join(releaseDir, dmgName);

await rm(buildRoot, { recursive: true, force: true });
await mkdir(path.dirname(executable), { recursive: true });
await mkdir(path.join(contents, "Resources"), { recursive: true });
await mkdir(dmgStage, { recursive: true });
await mkdir(releaseDir, { recursive: true });

await execFileAsync("xcrun", [
  "swiftc",
  "-O",
  "-parse-as-library",
  "-target", `${architecture}-apple-macosx13.0`,
  compileFlag,
  "-framework", "AppKit",
  "-framework", "CryptoKit",
  "-o", executable,
  path.join(root, "macos-installer", "InstallerApp.swift"),
], { maxBuffer: 4 * 1024 * 1024 });
await chmod(executable, 0o755);

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
<key>CFBundleDisplayName</key><string>Sevokecode Image Gen Installer</string>
<key>CFBundleExecutable</key><string>SevokecodeImageGenInstaller</string>
<key>CFBundleIdentifier</key><string>org.sevokecodes.image-gen.installer.${platform}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Sevokecode Image Gen Installer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Copyright Sevokecode</string>
</dict></plist>
`;
await writeFile(path.join(contents, "Info.plist"), infoPlist);

const signingIdentity = process.env.MACOS_SIGN_IDENTITY?.trim() || "-";
const signArgs = ["--force", "--sign", signingIdentity];
if (signingIdentity !== "-") signArgs.push("--options", "runtime", "--timestamp");
signArgs.push(appRoot);
await execFileAsync("codesign", signArgs, { maxBuffer: 4 * 1024 * 1024 });

await cp(appRoot, path.join(dmgStage, appName), { recursive: true });
await symlink("/Applications", path.join(dmgStage, "Applications"));
await rm(dmgPath, { force: true });
await execFileAsync("hdiutil", [
  "create", "-volname", "Sevokecode Image Gen Installer",
  "-srcfolder", dmgStage,
  "-ov", "-format", "UDZO", dmgPath,
], { maxBuffer: 4 * 1024 * 1024 });

if (signingIdentity !== "-") {
  await execFileAsync("codesign", ["--force", "--sign", signingIdentity, "--timestamp", dmgPath]);
}

const appleID = process.env.APPLE_ID?.trim();
const appleTeamID = process.env.APPLE_TEAM_ID?.trim();
const applePassword = process.env.APPLE_APP_PASSWORD?.trim();
if (appleID && appleTeamID && applePassword) {
  await execFileAsync("xcrun", [
    "notarytool", "submit", dmgPath,
    "--apple-id", appleID,
    "--team-id", appleTeamID,
    "--password", applePassword,
    "--wait",
  ], { maxBuffer: 8 * 1024 * 1024 });
  await execFileAsync("xcrun", ["stapler", "staple", dmgPath], { maxBuffer: 4 * 1024 * 1024 });
}

const releaseAssets = (await readdir(releaseDir)).filter((name) => name.endsWith(".zip") || name.endsWith(".dmg")).sort();
const checksums = await Promise.all(releaseAssets.map(async (name) => {
  const bytes = await readFile(path.join(releaseDir, name));
  return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`;
}));
await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);

const { stdout: fileDescription } = await execFileAsync("file", [executable]);
if (!fileDescription.includes(architecture)) {
  throw new Error(`Installer architecture verification failed: ${fileDescription.trim()}`);
}
process.stdout.write(`${JSON.stringify({ status: "success", platform, architecture, dmg: dmgPath, signed: signingIdentity !== "-", notarized: Boolean(appleID && appleTeamID && applePassword) })}\n`);
