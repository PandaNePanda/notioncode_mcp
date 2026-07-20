#!/usr/bin/env node
import process from "node:process";
import { runCli } from "../src/cli.js";

try {
  process.exitCode = await runCli();
} catch (error) {
  process.stderr.write(`error: ${error?.message || "unexpected failure"}\n`);
  process.exitCode = 1;
}
