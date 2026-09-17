import { access, chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { legacyPicturesOutputDirectory, resolveSkillRoot } from "./image-client.mjs";

const SKILL_NAME = "sevokecode-image-gen";
const LEGACY_SERVER_NAME = "sevokecodes_image_gen";

export function installedExecutablePath(skillRoot) {
  return path.join(skillRoot, "bin", "sevokecode-image-gen");
}

export function defaultInstallDir(home = os.homedir()) {
  return path.join(home, ".codex", "skills", SKILL_NAME);
}

export function defaultConfigPath(home = os.homedir()) {
  return path.join(home, ".codex", "config.toml");
}

export function removeLegacyMcpServerConfig(configText) {
  const headerPattern = new RegExp(`^\\[mcp_servers\\.${LEGACY_SERVER_NAME}\\][^\\n]*(?:\\n|$)`, "m");
  const match = configText.match(headerPattern);
  if (!match || match.index === undefined) return configText;
  const blockStart = match.index;
  const afterHeaderStart = blockStart + match[0].length;
  const nextHeaderMatch = configText.slice(afterHeaderStart).match(/^\[[^\n]+\][^\n]*(?:\n|$)/m);
  const blockEnd = nextHeaderMatch?.index === undefined
    ? configText.length
    : afterHeaderStart + nextHeaderMatch.index;
  const retained = `${configText.slice(0, blockStart)}${configText.slice(blockEnd)}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return retained ? `${retained}\n` : "";
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(source, target) {
  if (await exists(source)) {
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
}

async function copyRuntimePackage(packageRoot, installDir, existingConfigPath) {
  const staticFiles = [
    "SKILL.md",
    path.join("agents", "openai.yaml"),
    path.join(".codex-plugin", "plugin.json"),
  ];
  for (const relativePath of staticFiles) {
    await copyIfPresent(path.join(packageRoot, relativePath), path.join(installDir, relativePath));
  }
  // Only the stable entrypoint is installed. Release ZIPs also contain one
  // architecture-named bootstrap for old DMGs, but it must never become a
  // Skill-visible executable that Codex could select.
  await rm(path.join(installDir, "bin"), { recursive: true, force: true });
  await copyIfPresent(installedExecutablePath(packageRoot), installedExecutablePath(installDir));
  const sourceConfig = path.join(packageRoot, "config.json");
  const targetConfig = path.join(installDir, "config.json");
  await copyIfPresent(sourceConfig, targetConfig);
  // Preserve the existing local credential/configuration, never the release
  // template. The release package itself contains no usable API key.
  if (existingConfigPath) await copyIfPresent(existingConfigPath, targetConfig);
}

async function replaceRuntimePackage(packageRoot, installDir) {
  const existingConfigPath = path.join(installDir, "config.json");
  const parentDir = path.dirname(installDir);
  const baseName = path.basename(installDir);
  const stagingDir = path.join(parentDir, `.${baseName}.staging-${process.pid}-${randomUUID()}`);
  const backupDir = path.join(parentDir, `.${baseName}.backup-${process.pid}-${randomUUID()}`);
  let previousMoved = false;

  await mkdir(parentDir, { recursive: true });
  try {
    await copyRuntimePackage(packageRoot, stagingDir, existingConfigPath);
    if (await exists(installDir)) {
      await rename(installDir, backupDir);
      previousMoved = true;
    }
    await rename(stagingDir, installDir);
    if (previousMoved) await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (previousMoved && !(await exists(installDir)) && await exists(backupDir)) {
      await rename(backupDir, installDir).catch(() => undefined);
    }
    throw error;
  }
}

export async function setInstalledApiKey(installDir, apiKey) {
  if (!apiKey) throw new Error("An API key is required.");
  const configPath = path.join(installDir, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.apiKey = apiKey;
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
}

async function ensureOutputConfig(installDir, { home, platform }) {
  const configPath = path.join(installDir, "config.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(`Unable to read installed config file: ${configPath}`);
  }
  const configuredOutputDir = typeof config.defaultOutputDir === "string" && config.defaultOutputDir.trim()
    ? path.resolve(config.defaultOutputDir)
    : undefined;
  const outputDir = configuredOutputDir
    ?? path.resolve(legacyPicturesOutputDirectory({ home, platform }));
  config.defaultOutputDir = outputDir;
  // v1.4.x used 570 seconds internally to reserve a local save window. The
  // native v2 runner saves after the completed event, so migrate only that old
  // default to the documented full ten-minute request deadline. Respect any
  // user-selected value.
  if (config.timeoutMs === undefined || Number(config.timeoutMs) === 570000) {
    config.timeoutMs = 600000;
  }
  delete config.baseURL;
  delete config.waitingHeadersTimeoutMs;
  delete config.waitingCompletedTimeoutMs;
  delete config.cleanupTimeoutMs;
  await mkdir(outputDir, { recursive: true });
  await access(outputDir, fsConstants.W_OK);
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600);
  return outputDir;
}

async function removeLegacyCodexConfig(configPath) {
  let currentConfig = "";
  let existed = false;
  if (await exists(configPath)) {
    currentConfig = await readFile(configPath, "utf8");
    existed = true;
  }
  const withoutLegacy = removeLegacyMcpServerConfig(currentConfig);
  if (withoutLegacy === currentConfig) return { changed: false, backupPath: null, removedLegacyMcpConfig: false };

  await mkdir(path.dirname(configPath), { recursive: true });
  let backupPath = null;
  if (existed) {
    backupPath = `${configPath}.sevokecode-image-gen.${Date.now()}.bak`;
    await writeFile(backupPath, currentConfig, { mode: 0o600 });
  }
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, withoutLegacy, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  return {
    changed: true,
    backupPath,
    removedLegacyMcpConfig: withoutLegacy !== currentConfig,
  };
}

function promptForApiKey() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("API key input requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const input = process.stdin;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    const finish = () => {
      cleanup();
      process.stdout.write("\n");
      if (!value) reject(new Error("An API key is required."));
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          cleanup();
          reject(new Error("API key input cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };

    process.stdout.write("请输入 sevokecode 的 API Key（在你的 new-api 后台生成）：");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function removeLegacyRunners(installDir) {
  // Installed skills are native-only. Remove the entire legacy directory so a
  // previous shell runner cannot survive an in-place upgrade.
  await rm(path.join(installDir, "scripts"), { recursive: true, force: true });
  await Promise.all([
    "sevokecode-image-gen-macos-arm64",
    "sevokecode-image-gen-macos-x64",
  ].map((name) => rm(path.join(installDir, "bin", name), { force: true })));
}

export async function installSkill({
  packageRoot = resolveSkillRoot(),
  installDir = defaultInstallDir(),
  configPath = defaultConfigPath(),
  platform = process.platform,
  home = os.homedir(),
} = {}) {
  const sourceRoot = path.resolve(packageRoot);
  const targetRoot = path.resolve(installDir);
  if (sourceRoot !== targetRoot) {
    await replaceRuntimePackage(sourceRoot, targetRoot);
  }
  await removeLegacyRunners(targetRoot);
  const executable = installedExecutablePath(targetRoot);
  if (!(await exists(executable))) {
    throw new Error(`Installed executable was not found: ${executable}`);
  }
  const defaultOutputDir = await ensureOutputConfig(targetRoot, { home, platform });
  await chmod(executable, 0o755);
  const codexConfig = await removeLegacyCodexConfig(path.resolve(configPath));
  return {
    status: "success",
    skill_dir: targetRoot,
    config_path: path.resolve(configPath),
    executable,
    protocol: "native-direct-v4-single-deadline",
    removed_legacy_mcp_config: codexConfig.removedLegacyMcpConfig,
    codex_config_updated: codexConfig.changed,
    config_backup_path: codexConfig.backupPath,
    default_output_dir: defaultOutputDir,
    restart_required: true,
  };
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.`);
  return value;
}

export async function runInstaller(argv) {
  const installDir = readFlag(argv, "--install-dir");
  const configPath = readFlag(argv, "--config-path");
  const promptApiKey = argv.includes("--prompt-api-key");
  const unsupported = argv.filter((value) => value.startsWith("--") && !["--install-dir", "--config-path", "--prompt-api-key"].includes(value));
  if (unsupported.length > 0) throw new Error(`Unsupported install option: ${unsupported[0]}`);
  const apiKey = promptApiKey ? await promptForApiKey() : undefined;
  const result = await installSkill({ installDir, configPath });
  if (apiKey !== undefined) await setInstalledApiKey(result.skill_dir, apiKey);
  return { ...result, api_key_configured: apiKey !== undefined };
}
