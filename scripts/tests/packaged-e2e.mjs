import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixturePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwIBfuyx5QAAAABJRU5ErkJggg==";

function packageRootArg(argv) {
  const index = argv.indexOf("--package-root");
  if (index === -1 || !argv[index + 1] || argv.length !== 2) throw new Error("Usage: node scripts/tests/packaged-e2e.mjs --package-root <package-root>");
  return path.resolve(argv[index + 1]);
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch { return false; }
}

async function findLegacyScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findLegacyScripts(entryPath));
    else if ([".ps1", ".cmd", ".command"].some((suffix) => entry.name.toLowerCase().endsWith(suffix))) found.push(entryPath);
  }
  return found;
}

async function assertRuntimeOnlyPackage(directory) {
  const allowedRootEntries = new Set([".codex-plugin", "agents", "bin", "config.json", "INSTALL.txt", "SKILL.md"]);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    assert.ok(allowedRootEntries.has(entry.name), `Release package contains a non-runtime entry: ${entry.name}`);
  }
  assert.deepEqual(await findLegacyScripts(directory), [], "Release package must not contain a legacy script runner.");
  assert.equal(await exists(path.join(directory, "scripts")), false, "Release package must not contain source scripts.");
  assert.equal(await exists(path.join(directory, "node_modules")), false, "Release package must not contain Node dependencies.");
  const binEntries = (await readdir(path.join(directory, "bin"))).sort();
  const platform = path.basename(directory).replace("sevokecode-image-gen-", "");
  assert.deepEqual(binEntries, ["sevokecode-image-gen", `sevokecode-image-gen-${platform}`].sort(), "Release package must contain the stable entrypoint and exactly one old-DMG compatibility bootstrap.");
  const compatibilityBootstrap = path.join(directory, "bin", `sevokecode-image-gen-${platform}`);
  assert.equal((await lstat(compatibilityBootstrap)).isSymbolicLink(), true, "Old-DMG compatibility bootstrap must be a symlink, not a duplicate binary or wrapper.");
  assert.equal(await readlink(compatibilityBootstrap), "sevokecode-image-gen");
}

function executableFor(packageRoot) {
  const override = process.env.SEVOKECODE_IMAGE_GEN_E2E_EXECUTABLE;
  if (override) return path.resolve(override);
  return path.join(packageRoot, "bin", "sevokecode-image-gen");
}

async function runNative(executable, command, args) {
  return execFileAsync(executable, [command, ...args], {
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: "test", SEVOKECODE_IMAGE_GEN_TEST_MODE: "1" },
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
  try { await run(`http://127.0.0.1:${port}/v1`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

function complete(response, command) {
  const prefix = command === "generate" ? "image_generation" : "image_edit";
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-request-id": `packaged-${command}` });
  response.write(`event: ${prefix}.partial_image\ndata: ${JSON.stringify({ type: `${prefix}.partial_image`, b64_json: fixturePngBase64, partial_image_index: 0 })}\n\n`);
  response.write(`event: ${prefix}.completed\ndata: ${JSON.stringify({ type: `${prefix}.completed`, b64_json: fixturePngBase64, usage: {} })}\n\n`);
}

function readResult(result) {
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return JSON.parse(result.stdout);
}

const requestedPackageRoot = packageRootArg(process.argv.slice(2));
const sourceExecutable = executableFor(requestedPackageRoot);
// Cross-architecture acceptance supplies an executable override. Its adjacent
// config.json belongs to that package, not to the host-platform package root.
const sourcePackageRoot = process.env.SEVOKECODE_IMAGE_GEN_E2E_EXECUTABLE
  ? path.resolve(path.dirname(sourceExecutable), "..")
  : requestedPackageRoot;
if (!(await exists(sourceExecutable))) throw new Error(`Packaged executable was not found: ${sourceExecutable}`);
await assertRuntimeOnlyPackage(sourcePackageRoot);

const root = await mkdtemp(path.join(os.tmpdir(), "sevokecodes imagegen packaged v2 中文 "));
const packageRoot = path.join(root, path.basename(sourcePackageRoot));
await cp(sourcePackageRoot, packageRoot, { recursive: true });
const executable = path.join(packageRoot, "bin", path.basename(sourceExecutable));
const sourceA = path.join(root, "源图 A.png");
const sourceB = path.join(root, "源图 B.png");
await writeFile(sourceA, Buffer.from(fixturePngBase64, "base64"));
await writeFile(sourceB, Buffer.from(fixturePngBase64, "base64"));

let requestCount = 0;
await withMockImagesApi((request, response, body) => {
  requestCount += 1;
  assert.equal(request.headers.authorization, "Bearer packaged-e2e-key");
  if (request.url === "/v1/images/generations") {
    const payload = JSON.parse(body);
    assert.equal(payload.prompt, '中文生成 prompt with spaces and "quotes"');
    assert.equal(payload.n, 1);
    assert.equal(payload.partial_images, 0);
    complete(response, "generate");
    return;
  }
  assert.equal(request.url, "/v1/images/edits");
  assert.match(request.headers["content-type"], /^multipart\/form-data/);
  const multipart = body.toString("latin1");
  assert.match(body.toString("utf8"), /保留构图，将围巾改为深蓝色/);
  assert.equal((multipart.match(/name="image"/g) ?? []).length, 2);
  assert.match(multipart, /name="partial_images"\r\n\r\n0/);
  complete(response, "edit");
}, async (baseURL) => {
  await writeFile(path.join(packageRoot, "config.json"), JSON.stringify({ apiKey: "packaged-e2e-key", baseURL, timeoutMs: 5000 }));
  const generate = readResult(await runNative(executable, "generate", [
    "--workspace", path.join(root, "workspace 中文"),
    "--prompt", '中文生成 prompt with spaces and "quotes"',
    "--quality", "low",
    "--size", "1024x1024",
  ]));
  assert.equal(generate.status, "success");
  assert.equal(generate.exit_code, 0);
  assert.equal(generate.api_request_id, "packaged-generate");
  assert.equal((await readFile(generate.saved[0].absolute_path)).toString("base64"), fixturePngBase64);
  assert.ok(generate.timing_ms.http_ms >= 0);
  assert.ok(generate.timing_ms.wrapper_overhead_ms >= 0);
  assert.equal(generate.timing_ms.stream_completed_frame_terminated, true);
  assert.equal(generate.timing_ms.stream_events, 2);
  assert.equal(generate.timing_ms.stream_last_event_type, "image_generation.completed");

  const edit = readResult(await runNative(executable, "edit", [
    "--workspace", path.join(root, "workspace edit 中文"),
    "--prompt", "保留构图，将围巾改为深蓝色",
    "--image", sourceA,
    "--image", sourceB,
    "--quality", "low",
    "--size", "1024x1024",
  ]));
  assert.equal(edit.status, "success");
  assert.equal(edit.exit_code, 0);
  assert.equal(edit.api_request_id, "packaged-edit");
  assert.equal((await readFile(edit.saved[0].absolute_path)).toString("base64"), fixturePngBase64);
  assert.equal(edit.timing_ms.stream_completed_frame_terminated, true);
  assert.equal(edit.timing_ms.stream_events, 2);
  assert.equal(edit.timing_ms.stream_last_event_type, "image_edit.completed");
});

assert.equal(requestCount, 2, "one API request per native invocation");
process.stdout.write(`${JSON.stringify({ status: "success", platform: `${process.platform}-${process.arch}`, package_root: packageRoot, executable, generate: true, edit: true })}\n`);
