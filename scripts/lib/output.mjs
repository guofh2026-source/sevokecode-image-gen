import path from "node:path";
import { access, link, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";

function formatTimestamp(date = new Date()) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const timeParts = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ];
  return `${parts.join("")}-${timeParts.join("")}`;
}

function extensionForFormat(outputFormat) {
  return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

function isDirectoryHint(rawPath) {
  return /[\\/]$/.test(rawPath);
}

function isRecognizedImageExtension(extension) {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extension.toLowerCase());
}

function applyExpectedExtension(targetPath, outputFormat) {
  const expectedExtension = `.${extensionForFormat(outputFormat)}`;
  const currentExtension = path.extname(targetPath);

  if (!currentExtension) {
    return `${targetPath}${expectedExtension}`;
  }

  if (isRecognizedImageExtension(currentExtension) && currentExtension.toLowerCase() !== expectedExtension) {
    throw new Error(
      `Output extension ${currentExtension} does not match outputFormat=${outputFormat}. ` +
        `Use ${expectedExtension} or omit the extension.`,
    );
  }

  return targetPath;
}

function safeSlug(value) {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function chooseAvailablePath(targetPath, overwrite) {
  if (overwrite || !(await pathExists(targetPath))) {
    return targetPath;
  }

  const directory = path.dirname(targetPath);
  const extension = path.extname(targetPath);
  const baseName = path.basename(targetPath, extension);

  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(directory, `${baseName}_${String(index).padStart(3, "0")}${extension}`);
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  throw new Error(`Could not find an available output filename for ${targetPath}`);
}

export async function resolveOutputTargets({
  command,
  cwd,
  model,
  output,
  outputFormat,
  overwrite,
  count,
  outputIsDirectory = false,
}) {
  const extension = extensionForFormat(outputFormat);
  // Include entropy in automatically chosen names. Timestamp-only names race
  // when two Codex tasks finish in the same second.
  const defaultName = `${safeSlug(model)}-${command}-${formatTimestamp()}-${randomUUID()}.${extension}`;

  let baseTarget;
  if (!output) {
    throw new Error("Output resolution requires a default output directory.");
  } else {
    const resolved = path.resolve(cwd, output);
    const resolvedIsDirectory = outputIsDirectory
      || ((await pathExists(resolved)) && (await stat(resolved).then((entry) => entry.isDirectory()).catch(() => false)));

    if (isDirectoryHint(output) || resolvedIsDirectory) {
      baseTarget = path.join(resolved, defaultName);
    } else {
      baseTarget = applyExpectedExtension(resolved, outputFormat);
    }
  }

  await mkdir(path.dirname(baseTarget), { recursive: true });
  const targets = [];

  const firstTarget = await chooseAvailablePath(baseTarget, overwrite);
  targets.push(firstTarget);

  const extensionName = path.extname(baseTarget);
  const stem = path.basename(baseTarget, extensionName);
  const directory = path.dirname(baseTarget);

  for (let index = 1; index < count; index += 1) {
    const candidate = path.join(directory, `${stem}_${String(index).padStart(3, "0")}${extensionName}`);
    targets.push(await chooseAvailablePath(candidate, overwrite));
  }

  return targets;
}

export async function assertOutputTargetsWritable(targets) {
  const directories = [...new Set(targets.map((target) => path.dirname(target)))];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
    const probePath = path.join(directory, `.sevokecodes-write-probe-${process.pid}-${randomUUID()}`);
    let handle;
    try {
      handle = await open(probePath, "wx", 0o600);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Output directory is not writable: ${directory} (${detail})`);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(probePath, { force: true }).catch(() => undefined);
    }
  }
}

function markdownPath(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
}

function decodeBase64Image(value) {
  // Buffer.from silently accepts malformed Base64. Reject it before writing a
  // file so a successful API event cannot become a corrupt local artifact.
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Image API response contained invalid Base64 image data.");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0 || buffer.toString("base64") !== value) {
    throw new Error("Image API response contained invalid Base64 image data.");
  }
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).equals(Buffer.from("RIFF")) && buffer.subarray(8, 12).equals(Buffer.from("WEBP"));
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error("Image API response did not contain a PNG, JPEG, or WebP image.");
  }
  return { buffer, mimeType: isPng ? "image/png" : isJpeg ? "image/jpeg" : "image/webp" };
}

async function saveImageItem(item, outputPath, { overwrite = false } = {}) {
  if (typeof item?.b64_json !== "string" || item.b64_json.length === 0) {
    throw new Error("Image API response item did not contain b64_json.");
  }

  const { buffer, mimeType } = decodeBase64Image(item.b64_json);
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.part`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (overwrite) {
      await rename(temporaryPath, outputPath);
    } else {
      // link() is atomic and fails with EEXIST instead of replacing a file
      // created by a concurrent invocation after target selection.
      try {
        await link(temporaryPath, outputPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error(`Output file already exists: ${outputPath}`);
        }
        throw error;
      }
      await rm(temporaryPath, { force: true });
    }
    return { absolutePath: outputPath, bytes: buffer.length, mimeType };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveImageItems(apiResponse, outputTargets, { overwrite = false } = {}) {
  const data = Array.isArray(apiResponse?.data) ? apiResponse.data : [];
  if (data.length === 0) {
    throw new Error("Image API response did not contain any data items.");
  }

  if (data.length > outputTargets.length) {
    throw new Error("More response images than resolved output paths.");
  }

  const savedPaths = [];
  for (let index = 0; index < data.length; index += 1) {
    const savedPath = await saveImageItem(data[index], outputTargets[index], { overwrite });
    savedPaths.push({
      absolutePath: savedPath.absolutePath,
      bytes: savedPath.bytes,
      mimeType: savedPath.mimeType,
      revisedPrompt: data[index]?.revised_prompt ?? null,
    });
  }

  return savedPaths;
}

export function buildRenderables(savedItems, command) {
  return savedItems.map((item, index) => ({
    index,
    absolute_path: item.absolutePath,
    bytes: item.bytes,
    mime_type: item.mimeType,
    markdown_path: markdownPath(item.absolutePath),
    markdown: `![${command}-${index + 1}](${markdownPath(item.absolutePath)})`,
    revised_prompt: item.revisedPrompt,
  }));
}

export function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}
