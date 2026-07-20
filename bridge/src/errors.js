export const ErrorCode = Object.freeze({
  UNKNOWN: "unknown",
  AUTH_INVALID: "auth_invalid",
  PREMIUM_REQUIRED: "premium_required",
  NOTION_ERROR: "notion_error",
  TRUST_RULE_DENIED: "trust_rule_denied",
  HTTP_ERROR: "http_error",
  TRANSPORT: "transport",
  EMPTY_PROMPT: "empty_prompt",
  INVALID_CALLBACK: "invalid_callback",
  EMPTY_TEXT: "empty_text",
  ACCOUNT_MISSING: "account_missing",
  ACCOUNT_MALFORMED: "account_malformed",
  ACCOUNT_INVALID: "account_invalid",
  WORKSPACE_AMBIGUOUS: "workspace_ambiguous",
  WORKSPACE_EMPTY: "workspace_empty",
  THREAD_STATE_MISSING: "thread_state_missing",
  THREAD_STATE_MALFORMED: "thread_state_malformed",
});

const RETRY_POLICIES = Object.freeze({
  [ErrorCode.TRUST_RULE_DENIED]: { retryable: false, retryAfter: 300 },
  [ErrorCode.AUTH_INVALID]: { retryable: false, retryAfter: null },
  [ErrorCode.PREMIUM_REQUIRED]: { retryable: false, retryAfter: null },
  [ErrorCode.EMPTY_TEXT]: { retryable: true, retryAfter: 0 },
  [ErrorCode.TRANSPORT]: { retryable: true, retryAfter: 30 },
  [ErrorCode.HTTP_ERROR]: { retryable: true, retryAfter: 30 },
  [ErrorCode.NOTION_ERROR]: { retryable: true, retryAfter: 30 },
});

export function retryPolicyFor(code) {
  return RETRY_POLICIES[code] ?? { retryable: false, retryAfter: null };
}

export class NotionAgentError extends Error {
  constructor(message, options = {}) {
    const code = options.code ?? ErrorCode.UNKNOWN;
    const policy = retryPolicyFor(code);
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NotionAgentError";
    this.code = code;
    this.subtype = options.subtype ?? null;
    this.retryable = options.retryable ?? policy.retryable;
    this.retryAfter = options.retryAfter ?? policy.retryAfter;
    this.responseStatus = options.responseStatus ?? null;
  }

  toJSON() {
    return {
      code: this.code,
      subtype: this.subtype,
      message: this.message,
      retryable: this.retryable,
      retry_after: this.retryAfter,
    };
  }
}

export class AmbiguousWorkspaceError extends NotionAgentError {
  constructor(workspaces) {
    super("Multiple Notion workspaces are available; select one explicitly.", {
      code: ErrorCode.WORKSPACE_AMBIGUOUS,
    });
    this.name = "AmbiguousWorkspaceError";
    this.workspaces = Array.isArray(workspaces) ? workspaces : [];
  }
}

export function isLocalStateError(error) {
  return (
    error instanceof NotionAgentError &&
    new Set([
      ErrorCode.EMPTY_PROMPT,
      ErrorCode.INVALID_CALLBACK,
      ErrorCode.ACCOUNT_MISSING,
      ErrorCode.ACCOUNT_MALFORMED,
      ErrorCode.ACCOUNT_INVALID,
      ErrorCode.WORKSPACE_AMBIGUOUS,
      ErrorCode.WORKSPACE_EMPTY,
      ErrorCode.THREAD_STATE_MISSING,
      ErrorCode.THREAD_STATE_MALFORMED,
    ]).has(error.code)
  );
}

export function exitCodeFor(error) {
  if (!(error instanceof NotionAgentError)) return 1;
  if (error.code === ErrorCode.TRUST_RULE_DENIED) return 75;
  if (error.code === ErrorCode.AUTH_INVALID) return 77;
  return 1;
}
