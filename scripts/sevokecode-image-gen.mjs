#!/usr/bin/env node

import process from "node:process";

import { runInstaller } from "./lib/installer.mjs";
import { runCli } from "./lib/cli.mjs";

async function main() {
  try {
    if (process.argv[2] === "install") {
      process.stdout.write(`${JSON.stringify(await runInstaller(process.argv.slice(3)))}\n`);
      return;
    }
    const exitCode = await runCli(process.argv.slice(2));
    // Do not force-exit after the write callback. Codex's terminal forwarding
    // can observe a child exit before consuming the final stdout JSON. Let
    // Node drain stdout and close naturally after the completed payload has
    // already cancelled the stream.
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await new Promise((resolve, reject) => {
      process.stderr.write(`${message}\n`, (writeError) => {
        if (writeError) reject(writeError);
        else resolve();
      });
    });
    process.exitCode = 1;
  }
}

main();
