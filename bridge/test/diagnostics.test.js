import assert from "node:assert/strict";
import test from "node:test";

import { writeDiagnostic } from "../src/diagnostics.js";

function capture(isTTY = false) {
  let output = "";
  return {
    stream: {
      isTTY,
      write(value) {
        output += String(value);
      },
    },
    output: () => output,
  };
}

function withEnvironment(updates, callback) {
  const previous = new Map(Object.keys(updates).map((key) => [
    key,
    Object.hasOwn(process.env, key) ? process.env[key] : undefined,
  ]));
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("redirected diagnostics remain structured JSON", () => {
  const destination = capture(false);
  writeDiagnostic("request_completed", {
    request_id: "request-1",
    status: 200,
    duration_ms: 12,
  }, destination.stream);

  assert.deepEqual(JSON.parse(destination.output()), {
    event: "request_completed",
    request_id: "request-1",
    status: 200,
    duration_ms: 12,
  });
  assert.doesNotMatch(destination.output(), /\u001b\[/);
});

test("TTY diagnostics use readable Python-like colored output", () => {
  const destination = capture(true);
  writeDiagnostic("account_selected", {
    account_id: "account-a",
    selection: "balanced",
  }, destination.stream, { format: "pretty", color: true });

  const plain = destination.output().replaceAll(/\u001b\[[0-9;]*m/g, "");
  assert.match(plain, /INFO:/);
  assert.match(plain, /\[bridge\] account_selected/);
  assert.match(plain, /account_id=account-a/);
  assert.match(destination.output(), /\u001b\[/);
});

test("pretty diagnostics can disable ANSI colors", () => {
  const destination = capture(true);
  writeDiagnostic("request_failed", {
    status: 500,
  }, destination.stream, { format: "pretty", color: false });

  assert.match(destination.output(), /ERROR:/);
  assert.doesNotMatch(destination.output(), /\u001b\[/);
});

test("redirected pretty diagnostics honor forced launcher colors", () => {
  withEnvironment({ NOTION_COLOR: "1", NO_COLOR: undefined }, () => {
    const destination = capture(false);
    writeDiagnostic("account_selected", {
      account_id: "account-a",
    }, destination.stream, { format: "pretty" });

    assert.match(destination.output(), /INFO:/);
    assert.match(destination.output(), /\u001b\[/);
  });
});

test("color opt-outs override forced launcher colors", () => {
  for (const environment of [
    { NOTION_COLOR: "0", NO_COLOR: undefined },
    { NOTION_COLOR: "1", NO_COLOR: "1" },
  ]) {
    withEnvironment(environment, () => {
      const destination = capture(false);
      writeDiagnostic("request_failed", { status: 500 }, destination.stream, {
        format: "pretty",
      });

      assert.match(destination.output(), /ERROR:/);
      assert.doesNotMatch(destination.output(), /\u001b\[/);
    });
  }
});

test("diagnostics redact sensitive fields in JSON and pretty logs", () => {
  const jsonDestination = capture(false);
  writeDiagnostic("probe", {
    token_v2: "secret-token",
    cookie: "secret-cookie",
    prompt: "secret prompt",
    input_tokens: 42,
  }, jsonDestination.stream);
  const record = JSON.parse(jsonDestination.output());
  assert.equal(record.token_v2, "[redacted]");
  assert.equal(record.cookie, "[redacted]");
  assert.equal(record.prompt, "[redacted]");
  assert.equal(record.input_tokens, 42);
  assert.doesNotMatch(jsonDestination.output(), /secret-token|secret-cookie|secret prompt/);

  const prettyDestination = capture(true);
  writeDiagnostic("probe", {
    authorization: "Bearer secret",
  }, prettyDestination.stream, { format: "pretty", color: false });
  assert.doesNotMatch(prettyDestination.output(), /Bearer secret/);
});
