import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_TIMEOUT_MS, defaultOutputDirectory, legacyPicturesOutputDirectory, resolveInvocation } from "../lib/image-client.mjs";
import { installSkill, installedExecutablePath } from "../lib/installer.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "sevokecode-image-gen.mjs");
const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwIBfuyx5QAAAABJRU5ErkJggg==";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "sevokecodes imagegen v2 "));
}

async function runWithStdin(request, { env = process.env, cwd = repoRoot, keepStdinOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "run", "--request-stdin"], {
      cwd,
      env: { ...env, NODE_ENV: "test", SEVOKECODE_IMAGE_GEN_TEST_MODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = { code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`runner exited with ${code ?? signal}`), result));
    });
    child.stdin.write(`\uFEFF${JSON.stringify(request)}\n`, "utf8");
    if (!keepStdinOpen) child.stdin.end();
  });
}

async function withMockImagesApi(handler, run) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function completed(response, command, { close = false } = {}) {
  const prefix = command === "generate" ? "image_generation" : "image_edit";
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-request-id": `mock-${command}` });
  response.write(`event: ${prefix}.partial_image\ndata: ${JSON.stringify({ type: `${prefix}.partial_image`, b64_json: fixturePngBase64, partial_image_index: 0 })}\n\n`);
  response.write(`event: ${prefix}.completed\ndata: ${JSON.stringify({ type: `${prefix}.completed`, b64_json: fixturePngBase64, usage: {} })}\n\n`);
  if (close) response.end();
}

async function writeConfig(root, baseURL, extras = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "config.json"), JSON.stringify({ apiKey: "test-api-key", baseURL, ...extras }));
}

function parseOneJson(result) {
  assert.equal(result.stdout.trim().split("\n").length, 1, "stdout must contain exactly one JSON line");
  return JSON.parse(result.stdout);
}

test("skill documentation uses direct native commands and preserves nested terminal results", async () => {
  const skill = await readFile(path.join(repoRoot, "SKILL.md"), "utf8");
  const agentMetadata = await readFile(path.join(repoRoot, "agents", "openai.yaml"), "utf8");
  assert.match(skill, /generate --prompt/);
  assert.match(skill, /edit --prompt/);
  assert.match(skill, /Open the installed `SKILL\.md` exactly once/i);
  assert.match(skill, /Do not inspect memory, config, the source image/);
  assert.match(skill, /functions\.exec/);
  assert.match(skill, /tools\.exec_command/);
  assert.match(skill, /while \(result\.session_id\)/);
  assert.match(skill, /tools\.write_stdin/);
  assert.match(skill, /output\.push\(result\.output/);
  assert.match(skill, /functions\.wait/);
  assert.match(skill, /direct `shell_command`-style tool/);
  assert.match(skill, /Never call `tools\.exec_command` or `tools\.write_stdin` when those functions are not exposed/);
  assert.match(skill, /client_request_id/);
  assert.match(skill, /Do not create a shell wrapper/i);
  assert.match(skill, /bin\/sevokecode-image-gen`/);
  assert.match(skill, /Do not detect, infer, or select a CPU architecture/);
  assert.doesNotMatch(skill, /sevokecode-image-gen-macos-(?:arm64|x64)/);
  assert.doesNotMatch(skill, /request-file/i);
  assert.doesNotMatch(skill, /status-file/i);
  assert.match(agentMetadata, /\$sevokecode-image-gen/);
  assert.match(agentMetadata, /prompt verbatim/i);
  assert.doesNotMatch(agentMetadata, /prompt rewriting/i);
});

test("direct generate command preserves Chinese spaces and quotes in one structured result", async () => {
  const root = await tempDir();
  const workspace = path.join(root, "direct workspace 中文 空格");
  let requests = 0;
  await withMockImagesApi((request, response, body) => {
    requests += 1;
    assert.equal(request.url, "/v1/images/generations");
    assert.equal(JSON.parse(body).prompt, '直接参数：猫咪说 "hello world"');
    completed(response, "generate");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill direct");
    await writeConfig(skillRoot, baseURL);
    const result = await execFileAsync(process.execPath, [
      scriptPath,
      "generate",
      "--prompt", '直接参数：猫咪说 "hello world"',
      "--workspace", workspace,
      "--quality", "low",
      "--size", "1024x1024",
    ], { cwd: root, env: { ...process.env, NODE_ENV: "test", SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot, SEVOKECODE_IMAGE_GEN_TEST_MODE: "1" } });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.equal(payload.command, "generate");
    assert.equal(payload.exit_code, 0);
    assert.equal(payload.saved.length, 1);
  });
  assert.equal(requests, 1);
});

test("direct edit command accepts repeated image paths and returns strict JSON", async () => {
  const root = await tempDir();
  const sourceA = path.join(root, "source A 中文.png");
  const sourceB = path.join(root, "source B 中文.png");
  await writeFile(sourceA, Buffer.from(fixturePngBase64, "base64"));
  await writeFile(sourceB, Buffer.from(fixturePngBase64, "base64"));
  await withMockImagesApi((request, response, body) => {
    assert.equal(request.url, "/v1/images/edits");
    assert.equal((body.toString("latin1").match(/name="image"/g) ?? []).length, 2);
    assert.match(body.toString("utf8"), /只把围巾改成蓝色/);
    completed(response, "edit");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill direct edit");
    await writeConfig(skillRoot, baseURL);
    const result = await execFileAsync(process.execPath, [
      scriptPath,
      "edit",
      "--prompt", "只把围巾改成蓝色",
      "--image", sourceA,
      "--image", sourceB,
      "--workspace", path.join(root, "edit workspace"),
    ], { cwd: root, env: { ...process.env, NODE_ENV: "test", SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot, SEVOKECODE_IMAGE_GEN_TEST_MODE: "1" } });
    assert.equal(parseOneJson(result).status, "success");
  });
});

test("CLI entrypoint drains the terminal result instead of force-exiting", async () => {
  const entrypoint = await readFile(path.join(repoRoot, "scripts", "sevokecode-image-gen.mjs"), "utf8");
  assert.match(entrypoint, /process\.exitCode = exitCode/);
  assert.match(entrypoint, /process\.exitCode = 1/);
  assert.doesNotMatch(entrypoint, /process\.exit\(/);
});

test("v2 generate preserves Chinese prompt and returns one strict JSON result", async () => {
  const root = await tempDir();
  const workspace = path.join(root, "工作区 中文 空格");
  let requests = 0;
  await withMockImagesApi((request, response, body) => {
    requests += 1;
    assert.equal(request.url, "/v1/images/generations");
    const payload = JSON.parse(body);
    assert.equal(payload.prompt, '一只橙色猫，带“红色围巾”，window light');
    assert.equal(payload.n, 1);
    assert.equal(payload.partial_images, 0);
    completed(response, "generate");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL);
    const result = await runWithStdin({ version: 2, command: "generate", workspace, prompt: '一只橙色猫，带“红色围巾”，window light', quality: "low", size: "1024x1024" }, {
      env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot },
      keepStdinOpen: true,
    });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.equal(payload.exit_code, 0);
    assert.equal(payload.phase, "complete");
    assert.equal(payload.request_id, "mock-generate");
    assert.equal(payload.api_request_id, "mock-generate");
    assert.equal(payload.saved.length, 1);
    assert.match(payload.saved[0].absolute_path, /工作区 中文 空格[\\/]image-outputs[\\/]sevokecode-image-gen/);
    assert.equal((await readFile(payload.saved[0].absolute_path)).toString("base64"), fixturePngBase64);
    assert.equal(typeof payload.timing_ms.http_ms, "number");
    assert.equal(typeof payload.timing_ms.wrapper_overhead_ms, "number");
    assert.equal(typeof payload.timing_ms.post_complete_ms, "number");
  });
  assert.equal(requests, 1);
});

test("v2 edit uploads multiple absolute input images without shell argument parsing", async () => {
  const root = await tempDir();
  const sourceA = path.join(root, "输入 图片 A.png");
  const sourceB = path.join(root, "输入 图片 B.png");
  await writeFile(sourceA, Buffer.from(fixturePngBase64, "base64"));
  await writeFile(sourceB, Buffer.from(fixturePngBase64, "base64"));
  await withMockImagesApi((request, response, body) => {
    assert.equal(request.url, "/v1/images/edits");
    assert.match(request.headers["content-type"], /^multipart\/form-data/);
    assert.match(body.toString("utf8"), /保持构图，将围巾改为深蓝色/);
    const multipart = body.toString("latin1");
    assert.equal((multipart.match(/name="image"/g) ?? []).length, 2);
    assert.match(multipart, /name="partial_images"\r\n\r\n0/);
    assert.match(multipart, /name="output_format"\r\n\r\npng/);
    completed(response, "edit");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL);
    const result = await runWithStdin({ version: 2, command: "edit", workspace: path.join(root, "workspace"), prompt: "保持构图，将围巾改为深蓝色", images: [sourceA, sourceB], size: "1024x1024", quality: "low" }, {
      env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.equal(payload.saved.length, 1);
  });
});

test("v2 edit accepts eight input images in one bounded stdin request", async () => {
  const root = await tempDir();
  const images = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const imagePath = path.join(root, `多图输入 ${index + 1}.png`);
    await writeFile(imagePath, Buffer.from(fixturePngBase64, "base64"));
    return imagePath;
  }));
  await withMockImagesApi((request, response, body) => {
    assert.equal(request.url, "/v1/images/edits");
    assert.equal((body.toString("latin1").match(/name="image"/g) ?? []).length, 8);
    completed(response, "edit");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL);
    const result = await runWithStdin({
      version: 2,
      command: "edit",
      workspace: path.join(root, "workspace"),
      prompt: "将八张参考图统一为同一产品系列",
      images,
    }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } });
    assert.equal(parseOneJson(result).status, "success");
  });
});

test("invalid edit input is rejected before an API request and remains retry-safe", async () => {
  const root = await tempDir();
  let requests = 0;
  await withMockImagesApi((_request, response) => {
    requests += 1;
    completed(response, "edit");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL);
    let failure;
    try {
      await runWithStdin({
        version: 2,
        command: "edit",
        workspace: path.join(root, "workspace"),
        prompt: "保留构图",
        images: [path.join(root, "不存在的图片.png")],
      }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const payload = JSON.parse(failure.stdout);
    assert.equal(payload.phase, "input");
    assert.equal(payload.error.code, "input_invalid");
    assert.equal(payload.retry_safe, true);
  });
  assert.equal(requests, 0);
});

test("v2 rejects intermediate-file and endpoint fields before any API request", async () => {
  const root = await tempDir();
  const skillRoot = path.join(root, "skill");
  await writeConfig(skillRoot, "http://127.0.0.1:1/v1");
  let failure;
  try {
    await runWithStdin({ version: 2, command: "generate", prompt: "test", statusFile: path.join(root, "old.json") }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const payload = JSON.parse(failure.stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.phase, "input");
  assert.match(payload.error.message, /statusFile/);
});

test("v2 validates an unwritable-like output before attempting the image API", async () => {
  const root = await tempDir();
  const skillRoot = path.join(root, "skill");
  await writeConfig(skillRoot, "http://127.0.0.1:1/v1");
  let failure;
  try {
    await runWithStdin({ version: 2, command: "generate", prompt: "test", output: path.join(skillRoot, "forbidden.png") }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  const payload = JSON.parse(failure.stdout);
  assert.equal(payload.phase, "output");
  assert.equal(payload.error.code, "output_permission_denied");
  assert.match(payload.error.message, /outside the skill directory/);
});

test("completed Base64 returns before upstream SSE EOF and closes the socket", async () => {
  const root = await tempDir();
  let clientClosed = false;
  await withMockImagesApi((_request, response) => {
    response.once("close", () => { clientClosed = true; });
    completed(response, "generate");
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    const started = Date.now();
    const result = await runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "complete immediately" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } });
    assert.equal(parseOneJson(result).status, "success");
    assert.ok(Date.now() - started < 2000);
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(clientClosed, true);
});

test("completed JSON returns without an SSE delimiter or upstream EOF", async () => {
  const root = await tempDir();
  let clientClosed = false;
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.once("close", () => { clientClosed = true; });
    response.write("event: image_generation.completed\n");
    response.write(`data: ${JSON.stringify({ type: "image_generation.completed", b64_json: fixturePngBase64 })}`);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    const started = Date.now();
    const result = await runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "unterminated completed frame" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.equal(payload.timing_ms.stream_completed_frame_terminated, false);
    assert.ok(Date.now() - started < 2000);
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(clientClosed, true);
});

test("SSE comments and transport metadata do not create business event branches", async () => {
  const root = await tempDir();
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": keepalive\n\nid: 7\nretry: 1000\n");
    response.write(`event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: fixturePngBase64 })}\n\n`);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    const payload = parseOneJson(await runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "transport keepalive" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }));
    assert.equal(payload.status, "success");
    assert.equal(payload.timing_ms.stream_events, 1);
  });
});

test("edit rejects a generation event instead of adding a cross-protocol branch", async () => {
  const root = await tempDir();
  const source = path.join(root, "source.png");
  await writeFile(source, Buffer.from(fixturePngBase64, "base64"));
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: fixturePngBase64 })}\n\n`);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    await assert.rejects(
      runWithStdin({ version: 2, command: "edit", workspace: path.join(root, "workspace"), prompt: "change one detail", images: [source] }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.error.code, "unexpected_event");
        assert.equal(payload.error.event_type, "image_generation.completed");
        return true;
      },
    );
  });
});

test("completed without partial succeeds immediately", async () => {
  const root = await tempDir();
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: fixturePngBase64 })}\n\n`);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    const payload = parseOneJson(await runWithStdin(
      { version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "wait for completed" },
      { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } },
    ));
    assert.equal(payload.status, "success");
    assert.equal(payload.timing_ms.stream_partial_events, 0);
  });
});

test("non-SSE success response is rejected immediately", async () => {
  const root = await tempDir();
  await withMockImagesApi((_request, response) => {
    response.end(JSON.stringify({ data: [{ b64_json: fixturePngBase64 }] }));
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    await assert.rejects(
      runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "JSON response" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }),
      (error) => JSON.parse(error.stdout).error.code === "unexpected_content_type",
    );
  });
});

test("partial images are progress and do not terminate before completed", async () => {
  const root = await tempDir();
  const partialBase64 = Buffer.from("not the final image").toString("base64");
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: image_generation.partial_image\ndata: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: partialBase64 })}\n\n`);
    response.write(`event: image_generation.partial_image\ndata: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: partialBase64 })}\n\n`);
    response.write(`event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: fixturePngBase64 })}\n\n`);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    const payload = parseOneJson(await runWithStdin({
      version: 2,
      command: "generate",
      workspace: path.join(root, "workspace"),
      prompt: "wait for final image",
    }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }));
    assert.equal(payload.status, "success");
    assert.equal(payload.timing_ms.stream_partial_events, 2);
    assert.equal((await readFile(payload.saved[0].absolute_path)).toString("base64"), fixturePngBase64);
  });
});

test("one total timeout covers an open SSE response without completed", async () => {
  const root = await tempDir();
  let clientClosed = false;
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    response.once("close", () => { clientClosed = true; });
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 1000 });
    let failure;
    try {
      await runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "wait for timeout" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const payload = JSON.parse(failure.stdout);
    assert.equal(payload.status, "timeout");
    assert.equal(payload.exit_code, 124);
    assert.equal(payload.phase, "request");
    assert.equal(payload.error.code, "timeout");
    assert.equal(payload.retry_safe, false);
    assert.match(payload.error.message, /timed out after 1000ms/i);
  });
  assert.equal(clientClosed, true);
});

test("the same total timeout covers waiting for response headers", async () => {
  const root = await tempDir();
  await withMockImagesApi(() => {}, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 1000 });
    const started = Date.now();
    await assert.rejects(
      runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "wait for headers" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.status, "timeout");
        assert.equal(payload.phase, "request");
        assert.equal(payload.error.code, "timeout");
        assert.ok(Date.now() - started < 3000);
        return true;
      },
    );
  });
});

test("legacy phase timeout config cannot abort a valid slow completed response", async () => {
  const root = await tempDir();
  await withMockImagesApi((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      setTimeout(() => {
        response.write(`event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: fixturePngBase64 })}\n\n`);
      }, 1100);
    }, 1100);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, {
      timeoutMs: 5000,
      waitingHeadersTimeoutMs: 1000,
      waitingCompletedTimeoutMs: 1000,
      cleanupTimeoutMs: 100,
    });
    const payload = parseOneJson(await runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "valid slow response" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }));
    assert.equal(payload.status, "success");
    assert.ok(payload.timing_ms.http_ms >= 2000);
  });
});

test("invalid completed Base64 fails without creating an output file or retry", async () => {
  const root = await tempDir();
  let requests = 0;
  const output = path.join(root, "result.png");
  await withMockImagesApi((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: "bm90LWEtcG5n" })}\n\n`);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    await assert.rejects(
      runWithStdin({ version: 2, command: "generate", prompt: "invalid image", output }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.phase, "save");
        assert.equal(payload.error.code, "save_failed");
        assert.equal(payload.retry_safe, false);
        return true;
      },
    );
  });
  assert.equal(requests, 1);
  await assert.rejects(readFile(output));
});

test("EOF before completed fails immediately", async () => {
  const root = await tempDir();
  await withMockImagesApi((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: image_generation.partial_image\ndata: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: fixturePngBase64 })}\n\n`);
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 5000 });
    await assert.rejects(
      runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "EOF" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }),
      (error) => JSON.parse(error.stdout).error.code === "eof_before_completed",
    );
  });
});

test("HTTP error returns immediately and preserves status", async () => {
  const root = await tempDir();
  await withMockImagesApi((_request, response) => {
    response.writeHead(502, { "content-type": "application/json" });
    response.end('{"error":{"message":"upstream unavailable"}}');
  }, async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { timeoutMs: 10000 });
    const started = Date.now();
    await assert.rejects(
      runWithStdin({ version: 2, command: "generate", workspace: path.join(root, "workspace"), prompt: "HTTP error" }, { env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot } }),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.phase, "http_status");
        assert.equal(payload.api_request_id, null);
        assert.equal(payload.error.code, "http_error");
        assert.match(payload.error.message, /upstream unavailable/);
        assert.equal(payload.error.status, 502);
        assert.ok(Date.now() - started < 4000);
        return true;
      },
    );
  });
});

test("system temp working directory falls back to configured persistent output", async () => {
  const root = await tempDir();
  const configPath = path.join(root, "config.json");
  const persistent = path.join(root, "Pictures", "sevokecode-image-gen");
  await writeFile(configPath, JSON.stringify({ apiKey: "test-key", defaultOutputDir: persistent }));
  const invocation = await resolveInvocation("generate", { config: configPath, prompt: "test", image: [] }, { cwd: path.join(os.tmpdir(), "codex-ephemeral-task") });
  assert.equal(invocation.output, persistent);
  assert.equal(DEFAULT_TIMEOUT_MS, 600000);
});

test("unwritable implicit workspace candidate falls through to the configured persistent output", async () => {
  const root = await tempDir();
  const configPath = path.join(root, "config.json");
  const workspaceFile = path.join(root, "not-a-workspace-file");
  const persistent = path.join(root, "persistent-output");
  await writeFile(workspaceFile, "not a directory");
  await writeFile(configPath, JSON.stringify({ apiKey: "test-key", defaultOutputDir: persistent }));
  const invocation = await resolveInvocation("generate", {
    config: configPath,
    prompt: "test",
    image: [],
    workspace: workspaceFile,
  }, { cwd: path.join(os.tmpdir(), "sevokecode-image-gen-non-workspace") });
  assert.match(invocation.output, /not-a-workspace-file[\\/]image-outputs[\\/]sevokecode-image-gen$/);
  assert.equal(invocation.outputCandidates.length, 4);
  assert.equal(invocation.outputCandidates[1], persistent);
  assert.equal(invocation.outputCandidates[2], legacyPicturesOutputDirectory());
  assert.equal(invocation.outputCandidates[3], defaultOutputDirectory());
});

test("native request uses the next implicit output directory when workspace output is unavailable", async () => {
  const root = await tempDir();
  const workspaceFile = path.join(root, "workspace-is-a-file");
  const persistent = path.join(root, "persistent-output");
  const taskCwd = path.join(os.tmpdir(), "sevokecode-image-gen-non-workspace");
  await writeFile(workspaceFile, "not a directory");
  await mkdir(taskCwd, { recursive: true });
  await withMockImagesApi((_request, response) => completed(response, "generate"), async (baseURL) => {
    const skillRoot = path.join(root, "skill");
    await writeConfig(skillRoot, baseURL, { defaultOutputDir: persistent });
    const result = await runWithStdin({
      version: 2,
      command: "generate",
      workspace: workspaceFile,
      prompt: "fallback output",
    }, {
      cwd: taskCwd,
      env: { ...process.env, SEVOKECODE_IMAGE_GEN_SKILL_DIR: skillRoot },
    });
    const payload = parseOneJson(result);
    assert.equal(payload.status, "success");
    assert.ok(payload.saved[0].absolute_path.startsWith(`${persistent}${path.sep}`));
  });
});

test("macOS /private/tmp alias is never treated as a task workspace", { skip: process.platform !== "darwin" }, async () => {
  const root = await tempDir();
  const configPath = path.join(root, "config.json");
  const persistent = path.join(root, "persistent-output");
  await writeFile(configPath, JSON.stringify({ apiKey: "test-key", defaultOutputDir: persistent }));
  const invocation = await resolveInvocation("generate", { config: configPath, prompt: "test", image: [] }, { cwd: "/private/tmp/sevokecode-image-gen-test" });
  assert.equal(invocation.output, persistent);
});

test("missing workspace uses Pictures first and persistent application data as a non-temp fallback", () => {
  assert.equal(
    legacyPicturesOutputDirectory({ home: "/Users/example", platform: "darwin" }),
    "/Users/example/Pictures/sevokecode-image-gen",
  );
  assert.equal(
    defaultOutputDirectory({ home: "/Users/example", platform: "darwin" }),
    "/Users/example/Library/Application Support/sevokecode-image-gen/outputs",
  );
  assert.equal(
    defaultOutputDirectory({ home: "/home/example", platform: "linux", env: {} }),
    "/home/example/.local/share/sevokecode-image-gen/outputs",
  );
});

test("production invocation ignores a configurable Base URL", async () => {
  const root = await tempDir();
  await writeFile(path.join(root, "config.json"), JSON.stringify({
    apiKey: "test-key",
    baseURL: "https://unexpected-provider.example/v1",
    defaultOutputDir: path.join(path.dirname(root), `${path.basename(root)}-outputs`),
  }));
  const previousSkillRoot = process.env.SEVOKECODE_IMAGE_GEN_SKILL_DIR;
  const previousTestMode = process.env.SEVOKECODE_IMAGE_GEN_TEST_MODE;
  try {
    process.env.SEVOKECODE_IMAGE_GEN_SKILL_DIR = root;
    delete process.env.SEVOKECODE_IMAGE_GEN_TEST_MODE;
    const invocation = await resolveInvocation("generate", { prompt: "fixed endpoint", image: [] }, { cwd: root });
    assert.equal(invocation.baseURL, "https://sevoke.duckdns.org/v1");
  } finally {
    if (previousSkillRoot === undefined) delete process.env.SEVOKECODE_IMAGE_GEN_SKILL_DIR;
    else process.env.SEVOKECODE_IMAGE_GEN_SKILL_DIR = previousSkillRoot;
    if (previousTestMode === undefined) delete process.env.SEVOKECODE_IMAGE_GEN_TEST_MODE;
    else process.env.SEVOKECODE_IMAGE_GEN_TEST_MODE = previousTestMode;
  }
});

test("installer preserves the credential, removes phase deadlines, and fixes local permissions", async () => {
  const root = await tempDir();
  const packageRoot = path.join(root, "native package");
  const installDir = path.join(root, "installed skill");
  const packageConfig = path.join(packageRoot, "config.json");
  const packageExecutable = installedExecutablePath(packageRoot);
  await mkdir(path.dirname(packageExecutable), { recursive: true });
  await writeFile(packageConfig, JSON.stringify({ apiKey: "", timeoutMs: 600000, defaultOutputDir: "" }));
  // npm test intentionally runs before binary packaging in CI. Keep this
  // installer unit test self-contained rather than depending on ignored bin/.
  await writeFile(packageExecutable, "test native executable");
  await writeFile(path.join(packageRoot, "bin", "sevokecode-image-gen-macos-arm64"), "compatibility bootstrap");
  await writeFile(path.join(packageRoot, "bin", "sevokecode-image-gen-macos-x64"), "compatibility bootstrap");
  await mkdir(installDir, { recursive: true });
  await mkdir(path.join(installDir, "scripts"), { recursive: true });
  await writeFile(path.join(installDir, "scripts", "obsolete-runner.ps1"), "legacy");
  await mkdir(path.join(installDir, "bin"), { recursive: true });
  await writeFile(path.join(installDir, "bin", "sevokecode-image-gen-macos-x64"), "obsolete architecture entrypoint");
  await writeFile(path.join(installDir, "config.json"), JSON.stringify({
    apiKey: "preserved",
    baseURL: "https://old-provider.example/v1",
    timeoutMs: 570000,
    waitingHeadersTimeoutMs: 300000,
    waitingCompletedTimeoutMs: 120000,
    cleanupTimeoutMs: 2000,
    defaultOutputDir: path.join(root, "Pictures", "sevokecode-image-gen"),
  }));
  const codexConfigPath = path.join(root, "config.toml");
  const codexConfig = `sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n\n[sandbox_workspace_write]\nnetwork_access = false\nwritable_roots = ["/preserved"]\n\n[mcp_servers.sevokecodes_image_gen]\ncommand = "obsolete"\n`;
  await writeFile(codexConfigPath, codexConfig);
  await installSkill({
    packageRoot,
    installDir,
    configPath: codexConfigPath,
    home: root,
  });
  const config = JSON.parse(await readFile(path.join(installDir, "config.json"), "utf8"));
  assert.equal(config.apiKey, "preserved");
  assert.equal(config.timeoutMs, 600000);
  assert.equal("baseURL" in config, false);
  assert.equal("waitingHeadersTimeoutMs" in config, false);
  assert.equal("waitingCompletedTimeoutMs" in config, false);
  assert.equal("cleanupTimeoutMs" in config, false);
  assert.equal(config.defaultOutputDir, legacyPicturesOutputDirectory({ home: root, platform: process.platform }));
  assert.equal((await stat(path.join(installDir, "config.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(installedExecutablePath(installDir))).mode & 0o777, 0o755);
  const updatedCodexConfig = await readFile(codexConfigPath, "utf8");
  assert.match(updatedCodexConfig, /sandbox_mode = "workspace-write"/);
  assert.match(updatedCodexConfig, /approval_policy = "on-request"/);
  assert.match(updatedCodexConfig, /network_access = false/);
  assert.match(updatedCodexConfig, /writable_roots = \["\/preserved"\]/);
  assert.doesNotMatch(updatedCodexConfig, /mcp_servers\.sevokecodes_image_gen/);
  await assert.rejects(readFile(path.join(installDir, "scripts", "obsolete-runner.ps1"), "utf8"));
  assert.deepEqual(await readdir(path.join(installDir, "bin")), ["sevokecode-image-gen"]);
});
