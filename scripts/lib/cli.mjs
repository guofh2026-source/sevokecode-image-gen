import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_BASE_URL,
  DEFAULT_EDIT_SIZE,
  DEFAULT_GENERATE_SIZE,
  createImageRequest,
  describeOpenAIError,
  formatOpenAIError,
  isRequestDeliveryUnknown,
  resolveInvocation,
} from "./image-client.mjs";
import {
  buildRenderables,
  assertOutputTargetsWritable,
  resolveOutputTargets,
  saveImageItems,
  stableStringify,
} from "./output.mjs";

const HELP_TEXT = `sevokecode-image-gen

Usage:
  sevokecode-image-gen generate --prompt <text> [options]
  sevokecode-image-gen edit --prompt <text> --image <absolute-path> [--image <absolute-path> ...] [options]
  sevokecode-image-gen run --request-stdin

Commands:
  generate    Generate one image and return one structured JSON result.
  edit        Edit one or more local images and return one structured JSON result.
  run         Compatibility entrypoint for one structured stdin request.

Protocol:
  Every command writes exactly one UTF-8 JSON result to stdout. Configuration
  and credentials are read only from the adjacent config.json. Normal calls
  use generate/edit directly and require no stdin, request/result/status file,
  wrapper script, or additional runtime.

`;

const REQUEST_FIELDS = new Set([
  "version",
  "command",
  "workspace",
  "prompt",
  "output",
  "images",
  "mask",
  "quality",
  "size",
  "model",
  "outputFormat",
  "background",
  "moderation",
  "n",
  "overwrite",
  "timeoutMs",
  "inputFidelity",
  "outputCompression",
  "user",
]);

const DIRECT_OPTION_FIELDS = new Set([
  ...REQUEST_FIELDS,
  "image",
]);

function parseArgumentValue(rawValue) {
  if (rawValue === undefined) {
    return true;
  }

  return rawValue;
}

function toCamelCase(flagName) {
  return flagName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseArgs(argv) {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    return {
      command: null,
      options: {},
      help: true,
    };
  }

  const options = {
    image: [],
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") {
      return {
        command,
        options,
        help: true,
      };
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const trimmed = token.slice(2);
    const [rawName, inlineValue] = trimmed.split("=", 2);
    const optionName = toCamelCase(rawName);

    let value;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const nextToken = rest[index + 1];
      if (nextToken && !nextToken.startsWith("--")) {
        value = nextToken;
        index += 1;
      }
    }

    value = parseArgumentValue(value);

    if (optionName === "image") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error("--image requires a local file path");
      }
      options.image.push(value);
      continue;
    }

    options[optionName] = value;
  }

  return {
    command,
    options,
    help: false,
  };
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildResponse(invocation, targets, savedItems, apiResponse, verboseResponse, timing) {
  const renderables = buildRenderables(savedItems, invocation.command);
  const payload = {
    status: "success",
    command: invocation.command,
    exit_code: 0,
    saved: renderables,
    timing_ms: timing,
    error: null,
    request_id: apiResponse?._request_id ?? null,
    api_request_id: apiResponse?._request_id ?? null,
    client_request_id: invocation.clientRequestId,
    model: invocation.model,
    base_url: invocation.baseURL ?? DEFAULT_BASE_URL,
    size: invocation.size,
    quality: invocation.quality,
    output_format: invocation.outputFormat,
    revised_prompt: apiResponse?.data?.[0]?.revised_prompt ?? null,
  };

  if (verboseResponse) {
    payload.request = {
      prompt: invocation.prompt,
      image_count: invocation.images.length,
      mask: invocation.mask ?? null,
      background: invocation.background,
      moderation: invocation.moderation,
      output_compression: invocation.outputCompression ?? null,
      input_fidelity: invocation.inputFidelity ?? null,
      n: invocation.n,
      output: invocation.output ?? null,
      overwrite: invocation.overwrite,
    };
    payload.response = {
      raw_item_count: Array.isArray(apiResponse?.data) ? apiResponse.data.length : targets.length,
    };
    payload.render_hint =
      "Paste each saved[*].markdown string into the final answer to render the saved images in Codex or compatible VS Code surfaces.";
  }

  return payload;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value for --verbose-response: ${value}`);
}

function resolveVerboseResponse(rawValue) {
  return parseBooleanFlag(rawValue, false);
}

function writeToStream(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeStdout(value) {
  return writeToStream(process.stdout, value);
}

function writeStderr(value) {
  return writeToStream(process.stderr, value);
}

function parseRequestJson(contents, requestSource) {
  // Accept a UTF-8 BOM from compatibility callers.
  const json = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`Invalid JSON request: ${requestSource}`);
  }
}

async function readRequestStdin({ timeoutMs = 5000 } = {}) {
  const maxBytes = 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const candidateIsCompleteJson = (candidate) => {
      try {
        const text = candidate.toString("utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed);
      } catch {
        return false;
      }
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.length;
      if (byteLength > maxBytes) {
        finish(new Error("Request stdin exceeds the 1 MiB limit."));
        return;
      }
      chunks.push(bytes);
      const all = Buffer.concat(chunks);
      const newline = all.indexOf(0x0a);
      if (newline === -1) return;
      const frame = all.subarray(0, newline);
      // v2 is one JSON line. For old pretty-printed v1 JSON, retain the data
      // and allow EOF (still bounded by the input deadline) to complete it.
      if (frame.length > 0 && candidateIsCompleteJson(frame)) {
        // A pipe left open by the caller keeps Node's stdin handle alive even
        // after the request frame has been consumed. Closing our read side is
        // what makes one-frame v2 exit promptly without waiting for EOF.
        process.stdin.pause();
        process.stdin.destroy();
        finish(null, frame.toString("utf8"));
      }
    };
    const onEnd = () => {
      if (byteLength === 0) {
        finish(new Error("Request stdin was empty."));
        return;
      }
      finish(null, Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error) => finish(error);
    const timeout = setTimeout(() => {
      // Match the completed-frame path: an open parent pipe must not keep a
      // timed-out one-frame request alive after its final error is emitted.
      process.stdin.pause();
      process.stdin.destroy();
      finish(new Error(`Request stdin frame timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
}

function normalizedError(error, fallbackCode = "runner_failed") {
  if (error && typeof error === "object" && error.error) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message,
    ...(error?.kind ? { kind: error.kind } : {}),
    ...(error?.event_type ? { event_type: error.event_type } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    retry_safe: false,
  };
}

function lifecyclePayload({ command, status, startedAt, timing, saved = [], error = null, requestId = null, clientRequestId = null, exitCode = null, stage, runId = null, retrySafe = false }) {
  return {
    version: 2,
    run_id: runId,
    command,
    status,
    exit_code: exitCode,
    started_at: startedAt,
    completed_at: status === "running" ? null : new Date().toISOString(),
    saved,
    timing_ms: timing,
    error,
    request_id: requestId,
    api_request_id: requestId,
    client_request_id: clientRequestId,
    ...(stage ? { stage } : {}),
    retry_safe: retrySafe,
  };
}

class StructuredRequestError extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload;
  }
}

function toRequestObject(rawRequest, requestSource) {
  if (!rawRequest || typeof rawRequest !== "object" || Array.isArray(rawRequest)) {
    throw new Error(`Request must contain a JSON object: ${requestSource}`);
  }

  const request = Object.fromEntries(Object.entries(rawRequest).map(([key, value]) => [
    key.replace(/[_-]([a-z])/gi, (_, char) => char.toUpperCase()),
    value,
  ]));
  if (request.apiKey !== undefined || request.config !== undefined || request.baseURL !== undefined || request.statusFile !== undefined) {
    throw new Error("v2 requests cannot contain credentials, config, baseURL, or statusFile.");
  }
  const unsupported = Object.keys(request).find((key) => !REQUEST_FIELDS.has(key));
  if (unsupported) throw new Error(`Unsupported request field: ${unsupported}`);
  if (request.version !== 2) throw new Error("Request version must be 2.");
  if (!["generate", "edit"].includes(request.command)) {
    throw new Error("Request command must be generate or edit.");
  }
  if (request.output !== undefined && (typeof request.output !== "string" || !path.isAbsolute(request.output))) {
    throw new Error("Request output must be an absolute path when provided.");
  }
  if (request.workspace !== undefined && (typeof request.workspace !== "string" || !path.isAbsolute(request.workspace))) {
    throw new Error("Request workspace must be an absolute path when provided.");
  }
  if (request.mask !== undefined && (typeof request.mask !== "string" || !path.isAbsolute(request.mask))) {
    throw new Error("Request mask must be an absolute path.");
  }
  if (request.images !== undefined) {
    const images = Array.isArray(request.images) ? request.images : [request.images];
    if (!images.every((image) => typeof image === "string" && path.isAbsolute(image))) {
      throw new Error("Request images must contain only absolute paths.");
    }
  }

  const { command, version, images, ...options } = request;
  return {
    command,
    options: {
      image: images ?? [],
      ...options,
    },
  };
}

function requestFailurePayload(command, error, startedAt, startedAtPerformance, stage = "input") {
  const payload = lifecyclePayload({
    command,
    status: "failed",
    startedAt,
    timing: { total: Math.round(performance.now() - startedAtPerformance) },
    exitCode: 1,
    stage,
    error: {
      ...normalizedError(error, stage === "input" ? "input_invalid" : "initialization_failed"),
      retry_safe: true,
    },
    retrySafe: true,
  });
  payload.phase = stage;
  return payload;
}

async function prepareOutputTargets(invocation, cwd) {
  const candidates = invocation.explicitOutput
    ? [invocation.output]
    : invocation.outputCandidates;
  let lastError;

  for (const candidate of candidates) {
    try {
      const targets = await resolveOutputTargets({
        command: invocation.command,
        cwd,
        model: invocation.model,
        output: candidate,
        outputFormat: invocation.outputFormat,
        overwrite: invocation.overwrite,
        count: invocation.n,
        outputIsDirectory: !invocation.explicitOutput,
      });
      await assertOutputTargetsWritable(targets);
      invocation.output = candidate;
      invocation.outputIsDirectory = !invocation.explicitOutput;
      return targets;
    } catch (error) {
      lastError = error;
      if (invocation.explicitOutput) throw error;
    }
  }

  const error = new Error(
    `No default image output directory is writable. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
  error.code = "output_permission_denied";
  error.phase = "output";
  throw error;
}

async function runStructuredRequest(argv, { cwd = process.cwd() } = {}) {
  const startedAt = new Date().toISOString();
  const startedAtPerformance = performance.now();
  const runId = randomUUID();
  let command = "run";

  try {
    let rawRequest;
    let requestSource;
    if (argv.length === 1 && argv[0] === "--request-stdin") {
      requestSource = "stdin";
      rawRequest = parseRequestJson(await readRequestStdin(), requestSource);
    } else {
      throw new Error("Usage: sevokecode-image-gen run --request-stdin");
    }
    const request = toRequestObject(rawRequest, requestSource);
    command = request.command;
    const payload = await executeImageCommand(command, request.options, { cwd, runId });
    await writeStdout(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    const message = formatOpenAIError(error);
    const payload = error instanceof StructuredRequestError
      ? error.payload
      : requestFailurePayload(command, error, startedAt, startedAtPerformance);
    payload.run_id ??= runId;
    await writeStderr(`${message}\n`);
    await writeStdout(`${JSON.stringify(payload)}\n`);
    return Number.isInteger(payload.exit_code) && payload.exit_code !== 0 ? payload.exit_code : 1;
  }
}

async function runDirectCommand(command, argv, { cwd = process.cwd() } = {}) {
  const startedAt = new Date().toISOString();
  const startedAtPerformance = performance.now();
  const runId = randomUUID();

  try {
    const parsed = parseArgs([command, ...argv]);
    if (parsed.help) {
      await writeStdout(`${HELP_TEXT}\n`);
      return 0;
    }
    const unsupported = Object.keys(parsed.options).find((key) => !DIRECT_OPTION_FIELDS.has(key));
    if (unsupported) throw new Error(`Unsupported option: --${unsupported.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`);
    const payload = await executeImageCommand(command, parsed.options, { cwd, runId });
    await writeStdout(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (error) {
    const message = formatOpenAIError(error);
    const payload = error instanceof StructuredRequestError
      ? error.payload
      : requestFailurePayload(command, error, startedAt, startedAtPerformance);
    payload.run_id ??= runId;
    await writeStderr(`${message}\n`);
    await writeStdout(`${JSON.stringify(payload)}\n`);
    return Number.isInteger(payload.exit_code) && payload.exit_code !== 0 ? payload.exit_code : 1;
  }
}

export async function executeImageCommand(command, options, { cwd = process.cwd(), runId = randomUUID() } = {}) {
  const cliStartedAt = performance.now();
  const startedAt = new Date().toISOString();
  if (!["generate", "edit"].includes(command)) {
    throw new Error(`Unsupported command: ${command}`);
  }
  if (options.apiKey !== undefined) {
    throw new Error("--api-key is not supported. Set apiKey in config.json.");
  }

  let invocation;
  let requestStarted = false;
  const clientRequestId = randomUUID();
  let phase = "input";
  const progressStartedAt = performance.now();
  const emitProgress = async (event, details = {}) => {
    await writeStderr(`${JSON.stringify({
      event,
      command,
      run_id: runId,
      client_request_id: clientRequestId,
      elapsed_ms: Math.round(performance.now() - progressStartedAt),
      ...details,
    })}\n`);
  };

  try {
    const verboseResponse = false;
    const resolveStartedAt = performance.now();
    invocation = await resolveInvocation(command, options, { cwd });
    invocation.clientRequestId = clientRequestId;
    const resolveDurationMs = Math.round(performance.now() - resolveStartedAt);
    phase = "output";
    const outputStartedAt = performance.now();
    const outputTargets = await prepareOutputTargets(invocation, cwd);
    const outputPrepareMs = Math.round(performance.now() - outputStartedAt);
    requestStarted = true;
    phase = "upload_or_delivery_unknown";
    const {
      response: apiResponse,
      inputPrepareMs,
      apiDurationMs,
      streamFirstByteMs,
      streamCompletedPayloadMs,
      streamCompletedFrameTerminated,
      streamPartialEventCount,
      streamEventCount,
      streamLastEventType,
      streamBytesReceived,
    } = await createImageRequest(invocation, { clientRequestId, onProgress: emitProgress });
    phase = "save";
    await emitProgress("saving", { event_type: streamLastEventType, event_count: streamEventCount, bytes_received: streamBytesReceived });
    const postApiStartedAt = performance.now();
    const saveStartedAt = performance.now();
    const savedItems = await saveImageItems(apiResponse, outputTargets, { overwrite: invocation.overwrite });
    const saveDurationMs = Math.round(performance.now() - saveStartedAt);
    const totalMs = Math.round(performance.now() - cliStartedAt);
    const payload = buildResponse(
      invocation,
      outputTargets,
      savedItems,
      apiResponse,
      verboseResponse,
      {
        http_ms: apiDurationMs,
        save_ms: saveDurationMs,
        total_ms: totalMs,
        wrapper_overhead_ms: totalMs - apiDurationMs,
        time_to_first_byte_ms: streamFirstByteMs,
        completed_payload_ms: streamCompletedPayloadMs,
        stream_completed_frame_terminated: streamCompletedFrameTerminated,
        stream_partial_events: streamPartialEventCount,
        stream_events: streamEventCount,
        stream_last_event_type: streamLastEventType,
        stream_bytes_received: streamBytesReceived,
        input_prepare_ms: inputPrepareMs,
        output_prepare_ms: outputPrepareMs,
        config_resolve_ms: resolveDurationMs,
        post_complete_ms: Math.round(performance.now() - postApiStartedAt),
      },
    );
    payload.version = 2;
    payload.run_id = runId;
    payload.started_at = startedAt;
    payload.completed_at = new Date().toISOString();
    payload.stage = "complete";
    payload.phase = "complete";
    payload.retry_safe = false;
    await emitProgress("succeeded", { saved_count: savedItems.length });

    return payload;
  } catch (error) {
    const describedError = describeOpenAIError(error);
    const failurePhase = error?.phase
      ?? (requestStarted && isRequestDeliveryUnknown(error) ? "upload_or_delivery_unknown" : phase);
    const isTimeout = error?.code === "timeout";
    const failure = lifecyclePayload({
      command: invocation?.command ?? command,
      status: isTimeout ? "timeout" : "failed",
      startedAt,
      timing: { total: Math.round(performance.now() - cliStartedAt) },
      stage: failurePhase,
      error: {
        ...normalizedError(error, requestStarted ? failurePhase : "initialization_failed"),
        code: typeof error?.code === "string"
          ? error.code
          : requestStarted && isRequestDeliveryUnknown(error)
          ? "upload_or_delivery_unknown"
          : failurePhase === "save"
            ? "save_failed"
          : failurePhase === "input"
              ? "input_invalid"
              : failurePhase === "output"
                ? "output_permission_denied"
              : failurePhase === "response_incomplete"
                ? "response_incomplete"
                : "initialization_failed",
        retry_safe: !requestStarted || failurePhase === "input",
        ...(describedError.kind ? { kind: describedError.kind } : {}),
        ...(describedError.transport ? { transport: describedError.transport } : {}),
      },
      clientRequestId: invocation ? clientRequestId : null,
      exitCode: isTimeout ? 124 : 1,
      runId,
      retrySafe: !requestStarted || failurePhase === "input",
    });
    failure.phase = failure.stage;
    failure.api_request_id = error?.request_id ?? failure.api_request_id;
    failure.request_id = error?.request_id ?? failure.request_id;
    if (invocation?.output) {
      const outputExists = await fileExists(invocation.output);
      if (outputExists) {
        await writeStderr(`Output target already exists: ${invocation.output}\n`);
      }
    }
    throw new StructuredRequestError(formatOpenAIError(error), failure);
  }
}

export async function runCli(argv, { cwd = process.cwd() } = {}) {
  if (["generate", "edit"].includes(argv[0])) {
    return runDirectCommand(argv[0], argv.slice(1), { cwd });
  }
  if (argv[0] === "run") {
    return runStructuredRequest(argv.slice(1), { cwd });
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv.length === 0) {
    await writeStdout(`${HELP_TEXT}\n`);
    return 0;
  }
  const startedAt = new Date().toISOString();
  const startedAtPerformance = performance.now();
  const command = typeof argv[0] === "string" ? argv[0] : "unknown";
  const payload = requestFailurePayload(command, new Error(`Unsupported command: ${command}`), startedAt, startedAtPerformance);
  await writeStderr(`${payload.error.message}\n`);
  await writeStdout(`${JSON.stringify(payload)}\n`);
  return 1;
}

export { HELP_TEXT, parseArgs, runDirectCommand, runStructuredRequest, toRequestObject };
