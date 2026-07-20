import assert from "node:assert/strict";
import test from "node:test";

import { runDoctorCommand } from "../src/doctor.js";

function writableBuffer() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value: () => value,
  };
}

function doctorDependencies(overrides = {}) {
  const stdout = writableBuffer();
  const stderr = writableBuffer();
  return {
    stdout,
    stderr,
    dependencies: {
      stdout: stdout.stream,
      stderr: stderr.stream,
      transport: {},
      loadAccountFn: async () => ({
        token_v2: "redacted-token",
        user_id: "user-id",
        user_email: "user@example.invalid",
        space_id: "space-id",
        space_name: "Workspace",
        browser_id: "browser-id",
        client_version: "23.13.20260528.1850",
        user_agent: "test-agent",
      }),
      fetchUserContentFn: async () => ({
        recordMap: { space: { "space-id": { value: {} } } },
      }),
      loadUserModelAliasesFn: async () => ({}),
      ...overrides,
    },
  };
}

test("normal doctor validation does not fetch the live client version", async () => {
  let liveVersionCalls = 0;
  const harness = doctorDependencies({
    fetchLiveClientVersionFn: async () => {
      liveVersionCalls += 1;
      throw new Error("normal doctor must not make this slow request");
    },
  });

  const exitCode = await runDoctorCommand([], harness.dependencies);

  assert.equal(exitCode, 0);
  assert.equal(liveVersionCalls, 0);
  assert.match(harness.stdout.value(), /token_v2 accepted by \/loadUserContent/);
  assert.doesNotMatch(harness.stdout.value(), /client_version freshness/);
});

test("refresh-client-version explicitly fetches and saves the live version", async () => {
  let liveVersionCalls = 0;
  let saved = null;
  const harness = doctorDependencies({
    fetchLiveClientVersionFn: async () => {
      liveVersionCalls += 1;
      return "23.13.20260720.1000";
    },
    saveAccountFn: async (filePath, account) => {
      saved = { filePath, account };
    },
  });

  const exitCode = await runDoctorCommand(
    ["--account", "/tmp/account.json", "--refresh-client-version"],
    harness.dependencies,
  );

  assert.equal(exitCode, 0);
  assert.equal(liveVersionCalls, 1);
  assert.equal(saved.filePath, "/tmp/account.json");
  assert.equal(saved.account.client_version, "23.13.20260720.1000");
  assert.match(harness.stdout.value(), /client_version refreshed/);
});
