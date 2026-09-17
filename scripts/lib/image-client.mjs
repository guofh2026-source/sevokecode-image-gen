import { readFile, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Agent, ProxyAgent, fetch } from "undici";

export const DEFAULT_BASE_URL = "https://api.sevoke.com/v1";
export const DEFAULT_GENERATE_SIZE = "1024x1024";
export const DEFAULT_EDIT_SIZE = "auto";
export const DEFAULT_TIMEOUT_MS = 600000;
const MAX_STREAM_BYTES = 100 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_INPUT_IMAGES = 8;
const MAX_INPUT_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 50 * 1024 * 1024;

function normalizeObjectKeys(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key
        .replace(/[_-]([a-z])/gi, (_, char) => char.toUpperCase())
        .replace(/^baseUrl$/, "baseURL"),
      value,
    ]),
  );
}

function mergeDefinedObjects(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(normalizeObjectKeys(source))) {
      if (value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "")) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseInteger(value, fieldName, { min, max, fallback } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) throw new Error(`${fieldName} must be an integer`);
  if (min !== undefined && parsed < min) throw new Error(`${fieldName} must be >= ${min}`);
  if (max !== undefined && parsed > max) throw new Error(`${fieldName} must be <= ${max}`);
  return parsed;
}

function parseString(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim();
}

function parseProxyUrl(value) {
  const proxyUrl = parseString(value, undefined);
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
    return parsed.toString();
  } catch {
    throw new Error('proxyUrl must be a valid http or https URL.');
  }
}

function parsePrompt(value) {
  if (value === undefined || value === null) return undefined;
  const prompt = String(value);
  return prompt.trim() === "" ? undefined : prompt;
}

function parseStringArray(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [String(value)];
}

function validateChoice(value, fieldName, allowedValues) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim();
  if (!allowedValues.includes(normalized)) {
    throw new Error(`${fieldName} must be one of: ${allowedValues.join(", ")}`);
  }
  return normalized;
}

export function resolveSkillRoot() {
  if (process.pkg) {
    return path.resolve(path.dirname(process.execPath), "..");
  }
  if (process.env.SEVOKECODE_IMAGE_GEN_SKILL_DIR) {
    return path.resolve(process.env.SEVOKECODE_IMAGE_GEN_SKILL_DIR);
  }
  const entryPath = process.argv[1];
  if (entryPath && path.basename(entryPath) === "sevokecode-image-gen.mjs") {
    return path.resolve(path.dirname(entryPath), "..");
  }
  return process.cwd();
}

export function resolveConfigPath(configPath, cwd = process.cwd()) {
  return configPath
    ? path.resolve(cwd, String(configPath))
    : path.join(resolveSkillRoot(), "config.json");
}

function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function defaultOutputDirectory({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  // This directory is persistent user application data, not a system temp
  // directory. It is the most reliable fallback when Codex has no workspace.
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "sevokecode-image-gen", "outputs");
  }
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), "sevokecode-image-gen", "outputs");
}

export function legacyPicturesOutputDirectory({ home = os.homedir(), platform = process.platform } = {}) {
  return path.posix.join(home, "Pictures", "sevokecode-image-gen");
}

async function canonicalPath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function systemTemporaryRoots(platform = process.platform, env = process.env) {
  const roots = [os.tmpdir(), env.TMPDIR, env.TMP, env.TEMP].filter(Boolean);
  if (platform === "darwin") roots.push("/tmp", "/private/tmp", "/var/folders", "/private/var/folders");
  if (platform === "linux") roots.push("/tmp", "/var/tmp");
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

async function taskOutputDirectory(cwd, skillRoot) {
  const rawCwd = path.resolve(cwd);
  const resolvedCwd = await canonicalPath(rawCwd);
  const rawSkillRoot = path.resolve(skillRoot);
  const resolvedSkillRoot = await canonicalPath(rawSkillRoot);
  // A packaged executable is normally launched from a Codex task workspace.
  // Never treat the installed skill itself as a task workspace.
  // System temp locations are not durable task workspaces. The caller falls
  // back to a persistent user-owned application directory instead.
  if (isPathWithin(rawSkillRoot, rawCwd) || isPathWithin(resolvedSkillRoot, resolvedCwd)) return undefined;
  for (const temporaryRoot of systemTemporaryRoots()) {
    if (isPathWithin(temporaryRoot, rawCwd) || isPathWithin(await canonicalPath(temporaryRoot), resolvedCwd)) return undefined;
  }
  return path.join(resolvedCwd, "image-outputs", "sevokecode-image-gen");
}

async function workspaceOutputDirectory(workspace) {
  // `workspace` is an explicit request field supplied by Codex. It remains
  // authoritative even when an integration happens to mount a workspace
  // under a temporary root. Only an implicit process CWD is filtered above.
  return path.join(await canonicalPath(path.resolve(workspace)), "image-outputs", "sevokecode-image-gen");
}

function appendUniquePath(paths, candidate, cwd = process.cwd()) {
  if (!candidate) return;
  const resolved = path.resolve(cwd, candidate);
  if (!paths.some((existing) => path.resolve(existing) === resolved)) paths.push(resolved);
}

async function readConfigFile(configPath, cwd) {
  const resolvedPath = resolveConfigPath(configPath, cwd);
  try {
    return normalizeObjectKeys(JSON.parse(await readFile(resolvedPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${resolvedPath}`);
    }
    throw new Error(`Unable to read config file: ${resolvedPath}`);
  }
}

async function assertLocalFile(filePath, inputState) {
  const resolved = path.resolve(filePath);
  try {
    const entry = await stat(resolved);
    if (!entry.isFile()) throw new Error("not a regular file");
    if (entry.size > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`exceeds the ${MAX_INPUT_IMAGE_BYTES} byte per-file limit`);
    }
    if (inputState) {
      inputState.totalBytes += entry.size;
      if (inputState.totalBytes > MAX_TOTAL_INPUT_BYTES) {
        throw new Error(`exceeds the ${MAX_TOTAL_INPUT_BYTES} byte total limit`);
      }
    }
    return resolved;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read image file: ${resolved} (${detail})`);
  }
}

function detectMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

async function readUploadable(filePath, inputState) {
  const resolved = await assertLocalFile(filePath, inputState);
  return {
    bytes: await readFile(resolved),
    filename: path.basename(resolved),
    mimeType: detectMimeType(resolved),
  };
}

function escapeMultipartHeaderValue(value) {
  // A local filename must not be able to inject another multipart header.
  return String(value).replace(/[\r\n"]/g, "_");
}

function multipartTextPart(boundary, key, value) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeaderValue(key)}"\r\n\r\n${String(value)}\r\n`,
    "utf8",
  );
}

function multipartFilePart(boundary, key, file) {
  return [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeaderValue(key)}"; filename="${escapeMultipartHeaderValue(file.filename)}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      "utf8",
    ),
    file.bytes,
    Buffer.from("\r\n", "utf8"),
  ];
}

function trimTrailingSlash(value) {
  return value ? value.replace(/\/+$/, "") : value;
}

function applySharedPayload(invocation) {
  const payload = {
    model: invocation.model,
    prompt: invocation.prompt,
    n: invocation.n,
    quality: invocation.quality,
    size: invocation.size,
    output_format: invocation.outputFormat,
    moderation: invocation.moderation,
  };
  if (invocation.background !== undefined) payload.background = invocation.background;
  if (invocation.outputCompression !== undefined) payload.output_compression = invocation.outputCompression;
  if (invocation.user !== undefined) payload.user = invocation.user;
  return payload;
}

function createRequestLifecycle(timeoutMs) {
  const controller = new AbortController();
  let abortMessage = null;
  let abortCode = null;
  let abortPhase = null;
  let abortListener = null;

  const abort = (message, code = "request_cancelled", phase = "cancelled") => {
    if (abortMessage) return;
    abortMessage = message;
    abortCode = code;
    abortPhase = phase;
    controller.abort();
    abortListener?.();
  };
  const onSignal = (signalName) => abort(`Image request cancelled by ${signalName}.`, "request_cancelled", "cancelled");
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const timeout = setTimeout(() => abort(`Image request timed out after ${timeoutMs}ms.`, "timeout", "request"), timeoutMs);

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    signal: controller.signal,
    addAbortListener(listener) {
      abortListener = listener;
      if (abortMessage) listener();
    },
    throwIfAborted() {
      if (abortMessage) {
        const error = new Error(abortMessage);
        error.code = abortCode ?? "request_cancelled";
        error.phase = abortPhase ?? "cancelled";
        throw error;
      }
    },
    dispose() {
      clearTimeout(timeout);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      abortListener = null;
    },
  };
}

const EVENT_TYPES_BY_COMMAND = {
  generate: {
    partial: "image_generation.partial_image",
    completed: "image_generation.completed",
  },
  edit: {
    partial: "image_edit.partial_image",
    completed: "image_edit.completed",
  },
};

class ImageHttpError extends Error {
  constructor(message, { status, requestId, code, cause, deliveryUnknown = false, phase } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ImageHttpError";
    if (status !== undefined) this.status = status;
    if (requestId) this.request_id = requestId;
    if (code) this.code = code;
    this.deliveryUnknown = deliveryUnknown;
    if (phase) this.phase = phase;
  }
}

function parseJsonPayload(payload) {
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return null;
  }

  return event;
}

function protocolError(message, code, eventType) {
  const error = new Error(message);
  error.code = code;
  error.phase = "response_incomplete";
  if (eventType) error.event_type = eventType;
  return error;
}

function classifyImageFrame(payload, frameEventType, command) {
  const event = parseJsonPayload(payload);
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw protocolError("Image stream returned invalid JSON data.", "invalid_sse_payload");
  }
  const payloadEventType = typeof event.type === "string" ? event.type.trim() : "";
  if (!frameEventType || !payloadEventType || frameEventType !== payloadEventType) {
    throw protocolError("Image stream event field does not match JSON type.", "unexpected_event", frameEventType || payloadEventType);
  }
  const expected = EVENT_TYPES_BY_COMMAND[command];
  if (frameEventType === expected.partial) {
    if (typeof event.b64_json !== "string" || event.b64_json.length === 0) {
      throw protocolError("Image partial event did not contain b64_json.", "invalid_partial_payload", frameEventType);
    }
    return { kind: "partial", eventType: frameEventType };
  }
  if (frameEventType === expected.completed) {
    if (typeof event.b64_json !== "string" || event.b64_json.length === 0) {
      throw protocolError("Image completed event did not contain b64_json.", "invalid_completed_payload", frameEventType);
    }
    return {
      kind: "completed",
      eventType: frameEventType,
      completed: [{ b64_json: event.b64_json, revised_prompt: typeof event.revised_prompt === "string" ? event.revised_prompt : null }],
    };
  }
  throw protocolError(`Image stream returned an unexpected event: ${frameEventType}.`, "unexpected_event", frameEventType);
}

function extractDataPayload(line) {
  if (!line.startsWith("data:")) return null;
  return line.slice(5).replace(/^ /, "");
}

async function consumeImageStream(response, invocation, lifecycle, onProgress) {
  if (!response.body) throw new ImageHttpError("Image API returned an empty response body.", { status: response.status });

  const decoder = new TextDecoder("utf-8");
  const reader = response.body.getReader();
  const dataLines = [];
  let frameEventType = null;
  let pending = "";
  let firstByteMs = null;
  let partialEventCount = 0;
  let byteCount = 0;
  let eventCount = 0;
  let lastEventType = null;

  const inspectFrame = async (payload, frameTerminated) => {
    if (!payload || !frameEventType) {
      throw protocolError("Image stream returned an incomplete SSE frame.", "invalid_sse_frame", frameEventType);
    }
    const classified = classifyImageFrame(payload, frameEventType, invocation.command);
    eventCount += 1;
    lastEventType = classified.eventType;
    if (classified.kind === "completed") {
      const completedPayloadMs = Math.round(performance.now());
      await onProgress?.("completed_received", { event_type: classified.eventType, event_count: eventCount, bytes_received: byteCount });
      return {
        completed: classified.completed,
        firstByteMs,
        completedPayloadMs,
        completedFrameTerminated: frameTerminated,
        partialEventCount,
        eventCount,
        lastEventType,
        byteCount,
      };
    }
    if (classified.kind === "partial") {
      partialEventCount += 1;
      await onProgress?.("partial_received", { event_type: classified.eventType, event_count: eventCount, bytes_received: byteCount });
      return null;
    }
    return null;
  };
  const processLine = async (line) => {
    if (line === "") {
      if (!frameEventType && dataLines.length === 0) return null;
      const payload = dataLines.join("\n");
      const result = await inspectFrame(payload, true);
      dataLines.length = 0;
      frameEventType = null;
      return result;
    }
    if (line.startsWith("event:")) {
      frameEventType = line.slice(6).trim() || null;
      return null;
    }
    const data = extractDataPayload(line);
    if (data !== null) {
      dataLines.push(data);
      return null;
    }
    if (line.startsWith(":")) return null;
    if (line.startsWith("id:") || line.startsWith("retry:")) return null;
    throw protocolError("Image stream returned an unsupported SSE field.", "invalid_sse_frame", frameEventType);
  };

  const inspectUnterminatedCompletedLine = async () => {
    if (frameEventType !== EVENT_TYPES_BY_COMMAND[invocation.command].completed) return null;
    const payload = extractDataPayload(pending);
    if (payload === null || parseJsonPayload(payload) === null) return null;
    pending = "";
    return inspectFrame(payload, false);
  };

  lifecycle.addAbortListener(() => {
    void reader.cancel().catch(() => undefined);
  });

  try {
    for (;;) {
      lifecycle.throwIfAborted();
      const { done, value } = await reader.read();
      lifecycle.throwIfAborted();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Math.round(performance.now());
      byteCount += value.byteLength;
      if (byteCount > MAX_STREAM_BYTES) {
        throw new Error(`Image stream exceeded the ${MAX_STREAM_BYTES} byte limit.`);
      }
      pending += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) !== -1) {
        const rawLine = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const completed = await processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        if (completed) return completed;
      }
      const unterminatedCompleted = await inspectUnterminatedCompletedLine();
      if (unterminatedCompleted) return unterminatedCompleted;
    }

    pending += decoder.decode();
    if (pending) {
      const completed = await processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
      if (completed) return completed;
    }
    const completed = dataLines.length > 0 || frameEventType
      ? await inspectFrame(dataLines.join("\n"), false)
      : null;
    if (completed) return completed;
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  throw protocolError(`Image stream ended before ${EVENT_TYPES_BY_COMMAND[invocation.command].completed}.`, "eof_before_completed");
}

export async function resolveInvocation(command, cliOptions, { cwd = process.cwd() } = {}) {
  const config = await readConfigFile(cliOptions.config, cwd);
  const merged = mergeDefinedObjects(config, cliOptions);
  const defaultSize = command === "generate" ? DEFAULT_GENERATE_SIZE : DEFAULT_EDIT_SIZE;
  const images = parseStringArray(cliOptions.image.length > 0 ? cliOptions.image : merged.image);
  const workspace = cliOptions.workspace === undefined || cliOptions.workspace === null || cliOptions.workspace === ""
    ? undefined
    : String(cliOptions.workspace);
  if (workspace !== undefined && !path.isAbsolute(workspace)) {
    throw new Error("workspace must be an absolute path.");
  }
  const configuredOutput = parseString(config.defaultOutputDir, undefined);
  const skillRoot = resolveSkillRoot();
  const explicitOutput = parseString(merged.output, undefined);
  const outputCandidates = [];
  if (!explicitOutput) {
    if (workspace) appendUniquePath(outputCandidates, await workspaceOutputDirectory(workspace), cwd);
    appendUniquePath(outputCandidates, await taskOutputDirectory(cwd, skillRoot), cwd);
    appendUniquePath(outputCandidates, configuredOutput, cwd);
    // Prefer a visible, user-owned directory when Codex has no workspace.
    // The application-data directory remains the final non-temp fallback.
    appendUniquePath(outputCandidates, legacyPicturesOutputDirectory(), cwd);
    appendUniquePath(outputCandidates, defaultOutputDirectory(), cwd);
  }
  const defaultOutput = outputCandidates[0] ?? defaultOutputDirectory();
  const invocation = {
    command,
    cwd,
    apiKey: parseString(config.apiKey, undefined),
    // Production always uses the fixed provider. The opt-in test mode is only
    // for packaged binaries to exercise the full HTTP lifecycle against a
    // loopback fixture without changing the public protocol.
    baseURL: process.env.NODE_ENV === "test" && process.env.SEVOKECODE_IMAGE_GEN_TEST_MODE === "1"
      ? trimTrailingSlash(parseString(config.baseURL, DEFAULT_BASE_URL))
      : DEFAULT_BASE_URL,
    // Proxy credentials, if any, remain in config.json and are never accepted
    // from the request file or emitted in a result.
    proxyUrl: parseProxyUrl(config.proxyUrl),
    model: parseString(merged.model, "gpt-image-2"),
    prompt: parsePrompt(merged.prompt),
    output: explicitOutput ?? defaultOutput,
    outputIsDirectory: explicitOutput === undefined,
    outputCandidates: explicitOutput ? [path.resolve(cwd, explicitOutput)] : outputCandidates,
    explicitOutput: explicitOutput !== undefined,
    outputFormat: validateChoice(parseString(merged.outputFormat, "png"), "outputFormat", ["png", "jpeg", "webp"]),
    quality: validateChoice(parseString(merged.quality, "auto"), "quality", ["auto", "low", "medium", "high"]),
    size: parseString(merged.size, defaultSize),
    background: validateChoice(parseString(merged.background, "auto"), "background", ["auto", "opaque", "transparent"]),
    moderation: validateChoice(parseString(merged.moderation, "auto"), "moderation", ["auto", "low"]),
    inputFidelity: validateChoice(parseString(merged.inputFidelity, undefined), "inputFidelity", ["low", "high"]),
    outputCompression: parseInteger(merged.outputCompression, "outputCompression", { min: 0, max: 100 }),
    n: parseInteger(merged.n, "n", { min: 1, max: 1, fallback: 1 }),
    // The configured timeout is the actual request deadline. A completed
    // image received before it is always saved and reported, even if that
    // final local write crosses the deadline by a few milliseconds.
    timeoutMs: parseInteger(merged.timeoutMs, "timeoutMs", { min: 1000, max: 600000, fallback: DEFAULT_TIMEOUT_MS }),
    overwrite: parseBoolean(merged.overwrite, false),
    mask: parseString(merged.mask, undefined),
    user: parseString(merged.user, undefined),
    images,
    workspace: workspace ? path.resolve(workspace) : undefined,
  };

  if (!invocation.prompt) throw new Error("Missing prompt. Pass --prompt.");
  if (!invocation.apiKey) throw new Error("Missing apiKey in config.json.");
  const outputPath = path.resolve(cwd, invocation.output);
  if (isPathWithin(resolveSkillRoot(), outputPath)) {
    const error = new Error("Output must be outside the skill directory. Pass an output path in a user-owned location.");
    error.code = "output_permission_denied";
    error.phase = "output";
    throw error;
  }

  if (invocation.outputCompression !== undefined && invocation.outputFormat === "png") {
    throw new Error("outputCompression is only supported with jpeg or webp output.");
  }
  if (command === "generate" && invocation.images.length > 0) throw new Error("generate does not accept --image.");
  if (command === "generate" && invocation.mask) throw new Error("generate does not accept --mask.");
  if (command === "generate" && invocation.inputFidelity) throw new Error("generate does not accept --input-fidelity.");
  if (command === "edit" && invocation.images.length === 0) throw new Error("edit requires at least one --image <local-path>.");
  if (invocation.images.length > MAX_INPUT_IMAGES) {
    throw new Error(`edit supports at most ${MAX_INPUT_IMAGES} input images.`);
  }
  return invocation;
}

function definedJsonPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

async function createRequestBody(invocation) {
  const payload = {
    ...applySharedPayload(invocation),
    // The API emits exactly one final image event. Extra partial previews add
    // image output tokens and do not make the final result available sooner.
    stream: true,
    partial_images: 0,
  };
  if (invocation.command === "generate") {
    return { body: JSON.stringify(definedJsonPayload(payload)), contentType: "application/json" };
  }

  const preparationStartedAt = performance.now();
  const boundary = `----sevokecode-image-gen-${randomBytes(18).toString("hex")}`;
  const chunks = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) chunks.push(multipartTextPart(boundary, key, value));
  }
  const inputState = { totalBytes: 0 };
  for (const filePath of invocation.images) {
    chunks.push(...multipartFilePart(boundary, "image", await readUploadable(path.resolve(invocation.cwd, filePath), inputState)));
  }
  if (invocation.mask) {
    chunks.push(...multipartFilePart(boundary, "mask", await readUploadable(path.resolve(invocation.cwd, invocation.mask), inputState)));
  }
  if (invocation.inputFidelity) chunks.push(multipartTextPart(boundary, "input_fidelity", invocation.inputFidelity));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    inputPrepareMs: Math.round(performance.now() - preparationStartedAt),
  };
}

function requestIdFromResponse(response) {
  return response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? null;
}

async function responseBodyPrefix(response, lifecycle) {
  if (!response.body) return { body: "", incomplete: false };
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  let incomplete = false;
  lifecycle.addAbortListener(() => {
    void reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      lifecycle.throwIfAborted();
      const { done, value } = await reader.read();
      lifecycle.throwIfAborted();
      if (done) break;
      const remaining = MAX_ERROR_BODY_BYTES - byteLength;
      if (remaining <= 0) {
        incomplete = true;
        break;
      }
      chunks.push(value.subarray(0, remaining));
      byteLength += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining || byteLength >= MAX_ERROR_BODY_BYTES) {
        incomplete = true;
        break;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return { body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), incomplete };
}

async function responseError(response, requestId, lifecycle) {
  const contentType = response.headers.get("content-type") ?? "";
  const { body, incomplete } = await responseBodyPrefix(response, lifecycle);
  let message;
  if (contentType.includes("json")) {
    try {
      const parsed = JSON.parse(body);
      message = parsed?.error?.message ?? parsed?.message;
    } catch {
      // The bounded plain-text fallback below is sufficient for invalid JSON.
    }
  }
  message ??= body.trim().slice(0, 1000) || `Image API returned HTTP ${response.status}.`;
  const error = new ImageHttpError(message, { status: response.status, requestId, code: incomplete ? "http_error_body_incomplete" : "http_error" });
  error.phase = "http_status";
  return error;
}

async function createTransport(proxyUrl) {
  // Never use fetch's global dispatcher for a one-shot executable. Its idle
  // keep-alive socket can keep the packaged Node event loop alive long after a
  // completed Base64 image has already been written to disk.
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
  return {
    dispatcher,
    destroy() {
      // Start teardown immediately and never keep a completed image waiting on
      // an upstream EOF or a cleanup deadline.
      void dispatcher.destroy(new Error("Image stream completed or terminated.")).catch(() => undefined);
    },
  };
}

export async function createImageRequest(invocation, { clientRequestId, onProgress } = {}) {
  const transport = await createTransport(invocation.proxyUrl);
  let lifecycle;
  try {
    let requestBody;
    try {
      requestBody = await createRequestBody(invocation);
    } catch (error) {
      error.phase = "input";
      throw error;
    }
    const { body, contentType, inputPrepareMs = 0 } = requestBody;
    // Input validation and local file preparation do not consume the actual
    // configured API deadline. Once fetch begins, the request gets its full
    // ten-minute budget.
    lifecycle = createRequestLifecycle(invocation.timeoutMs);
    lifecycle.throwIfAborted();
    const apiStartedAt = performance.now();
    await onProgress?.("request_sent", { client_request_id: clientRequestId });
    let response;
    try {
      response = await fetch(`${invocation.baseURL}/images/${invocation.command === "generate" ? "generations" : "edits"}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${invocation.apiKey ?? ""}`,
          "X-Niucodes-Client-Request-Id": clientRequestId,
          ...(contentType ? { "Content-Type": contentType } : {}),
        },
        body,
        signal: lifecycle.signal,
        dispatcher: transport.dispatcher,
      });
    } catch (error) {
      lifecycle.throwIfAborted();
      throw new ImageHttpError("Image API connection error.", {
        code: error?.cause?.code ?? error?.code,
        cause: error,
        deliveryUnknown: true,
        phase: "upload_or_delivery_unknown",
      });
    }
    const requestId = requestIdFromResponse(response);
    await onProgress?.("headers_received", { http_status: response.status, api_request_id: requestId });
    if (!response.ok) {
      const error = await responseError(response, requestId, lifecycle);
      throw error;
    }
    const responseContentType = response.headers.get("content-type") ?? "";
    if (!responseContentType.toLowerCase().includes("text/event-stream")) {
      const error = protocolError(`Image API returned unsupported content type: ${responseContentType || "missing"}.`, "unexpected_content_type");
      error.request_id = requestId;
      throw error;
    }
    let consumed;
    try {
      consumed = await consumeImageStream(response, invocation, lifecycle, onProgress);
    } catch (error) {
      error.phase ??= "response_incomplete";
      error.request_id ??= requestId;
      throw error;
    }
    return {
      response: { data: consumed.completed, _request_id: requestId },
      inputPrepareMs,
      apiDurationMs: Math.max(0, consumed.completedPayloadMs - Math.round(apiStartedAt)),
      streamFirstByteMs: consumed.firstByteMs === null ? null : Math.max(0, consumed.firstByteMs - Math.round(apiStartedAt)),
      streamCompletedPayloadMs: Math.max(0, consumed.completedPayloadMs - Math.round(apiStartedAt)),
      streamCompletedFrameTerminated: consumed.completedFrameTerminated,
      streamPartialEventCount: consumed.partialEventCount,
      streamEventCount: consumed.eventCount,
      streamLastEventType: consumed.lastEventType,
      streamBytesReceived: consumed.byteCount,
    };
  } catch (error) {
    try {
      lifecycle?.throwIfAborted();
    } catch (abortError) {
      // Preserve the phase in which cancellation happened. Otherwise an
      // abort while reading a received SSE response looks like a connection
      // failure before upload completed.
      abortError.phase ??= error?.phase ?? "upload_or_delivery_unknown";
      throw abortError;
    }
    throw error;
  } finally {
    lifecycle?.dispose();
    transport.destroy();
  }
}

function transportCause(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const code = typeof current.code === "string" && /^[A-Z0-9_]+$/.test(current.code)
      ? current.code
      : undefined;
    const name = typeof current.name === "string" && /^[A-Za-z0-9_]+$/.test(current.name)
      ? current.name
      : undefined;
    if (code || (depth > 0 && name)) return { ...(name ? { name } : {}), ...(code ? { code } : {}) };
    current = current.cause;
  }
  return undefined;
}

export function isRequestDeliveryUnknown(error) {
  return error?.deliveryUnknown === true;
}

export function describeOpenAIError(error) {
  const transport = transportCause(error);
  return {
    message: formatOpenAIError(error),
    ...(isRequestDeliveryUnknown(error) ? { kind: "request_delivery_unknown" } : {}),
    ...(transport ? { transport } : {}),
  };
}

export function formatOpenAIError(error) {
  if (!error || typeof error !== "object") return String(error);
  const transport = transportCause(error);
  return [error.message, error.code && `code=${error.code}`, error.status && `status=${error.status}`, error.request_id && `request_id=${error.request_id}`, transport?.code && `transport=${transport.code}`]
    .filter(Boolean)
    .join(" | ") || JSON.stringify(error);
}
