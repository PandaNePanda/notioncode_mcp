import assert from "node:assert/strict";
import test from "node:test";
import { shellInvocation } from "./platform.js";

test("uses bash on Unix without changing the command", () => {
  assert.deepEqual(shellInvocation("pwd", { platform: "linux" }), {
    executable: "/bin/bash",
    args: ["-lc", "pwd"],
  });
});

test("uses non-interactive PowerShell on Windows", () => {
  assert.deepEqual(shellInvocation("Get-Location", { platform: "win32" }), {
    executable: "powershell.exe",
    args: [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
      "Bypass", "-Command", "Get-Location",
    ],
  });
});

test("allows an explicit platform shell override", () => {
  assert.equal(
    shellInvocation("echo ok", { platform: "linux", configuredShell: "/usr/bin/bash" }).executable,
    "/usr/bin/bash",
  );
});
