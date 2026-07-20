import { readFile } from "node:fs/promises";
import path from "node:path";

import { accountId, discoverAccountPaths, loadAccount, sha256 } from "./account.js";
import { safeErrorMetadata, writeDiagnostic } from "./diagnostics.js";
import { ErrorCode, isLocalStateError, NotionAgentError } from "./errors.js";
import { atomicWriteJson, modifiedTimeMs } from "./files.js";
import { NotionProvider } from "./provider.js";
import { KeyedMutex } from "./state.js";

export const MAX_ACCOUNTS = 10;
export const MAX_REASONING_EFFORT = "high";
export const TRANSIENT_COOLDOWN_MS = 30_000;
export const DENIAL_COOLDOWN_MS = 300_000;
export const MATCHING_FAILURE_WINDOW_MS = 30_000;
export const MATCHING_FAILURE_THRESHOLD = 3;

export class AccountPoolError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AccountPoolError";
    this.code = options.code ?? "pool_error";
    this.retryAfter = options.retryAfter ?? null;
  }
}

function isolatedThreadDirectory(home, accountPath) {
  return path.join(home, "account-threads", sha256(path.resolve(accountPath)).slice(0, 16));
}

export async function discoverAccounts(home) {
  const paths = await discoverAccountPaths(home);
  const accounts = [];
  const invalid = [];
  const duplicates = [];
  const tokens = new Map();
  const users = new Map();

  for (const candidate of paths) {
    let account;
    try {
      account = await loadAccount(candidate.accountPath);
    } catch (error) {
      invalid.push({
        accountPath: candidate.accountPath,
        ...safeErrorMetadata(error),
      });
      continue;
    }

    const tokenFingerprint = sha256(`${account.token_v2}\0${account.space_id}`);
    const userFingerprint = sha256(`${account.user_id}\0${account.space_id}`);
    const duplicate = tokens.get(tokenFingerprint) ?? users.get(userFingerprint);
    if (duplicate) {
      duplicates.push({
        accountPath: candidate.accountPath,
        duplicateOf: duplicate.accountPath,
        reason: tokens.has(tokenFingerprint) ? "token" : "user",
      });
      continue;
    }

    const entry = {
      slot: accounts.length,
      id: accountId(account),
      account,
      accountPath: candidate.accountPath,
      credentialMtimeMs: await modifiedTimeMs(candidate.accountPath),
      threadStateDirectory: candidate.legacy
        ? path.join(home, "threads")
        : isolatedThreadDirectory(home, candidate.accountPath),
      legacy: candidate.legacy,
    };
    accounts.push(entry);
    tokens.set(tokenFingerprint, entry);
    users.set(userFingerprint, entry);
  }

  if (accounts.length > MAX_ACCOUNTS) {
    throw new AccountPoolError(`At most ${MAX_ACCOUNTS} unique Notion accounts are supported.`, {
      code: "too_many_accounts",
    });
  }

  return {
    accounts,
    discovered: paths.length,
    invalid,
    duplicates,
  };
}

async function loadPoolState(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return null;
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function failureSignature(error) {
  if (!(error instanceof NotionAgentError)) return `unknown:${error?.constructor?.name ?? typeof error}`;
  return [error.code, error.subtype ?? "", error.responseStatus ?? ""].join(":");
}

function retryAfterSeconds(milliseconds) {
  return Math.max(0, Math.ceil(milliseconds / 1000));
}

function isCancellationError(error) {
  return error?.noFailover === true
    || error?.name === "AbortError"
    || error?.code === "ABORT_ERR";
}

export class AccountPool {
  static async create(options = {}) {
    if (!options.home) throw new TypeError("AccountPool requires home.");
    const discovery = await discoverAccounts(options.home);
    const pool = new AccountPool(options, discovery);
    await pool._restore();
    return pool;
  }

  constructor(options, discovery) {
    this.home = options.home;
    this.now = options.now ?? Date.now;
    this.providerFactory = options.providerFactory ?? ((providerOptions) => new NotionProvider(providerOptions));
    this.diagnostic = options.diagnostic ?? ((event, fields) => writeDiagnostic(event, fields));
    this.statePath = options.statePath ?? path.join(this.home, "pool-state.json");
    this.discovery = discovery;
    this.mutex = new KeyedMutex();
    this.waiters = new Set();
    this.failureHistory = new Map();
    this.circuitUntil = 0;
    this.closed = false;
    this.slots = discovery.accounts.map((entry) => ({
      ...entry,
      provider: null,
      providerPromise: null,
      busy: false,
      assignments: 0,
      successes: 0,
      failures: 0,
      lastAssignedAt: null,
      cooldownUntil: 0,
      disabled: false,
    }));
  }

  _time() {
    return finiteNumber(this.now(), Date.now());
  }

  async _restore() {
    const state = await loadPoolState(this.statePath);
    if (!state) return;
    const savedAccounts = state.accounts && typeof state.accounts === "object" ? state.accounts : {};
    for (const slot of this.slots) {
      const saved = savedAccounts[slot.id];
      if (!saved || saved.credential_mtime_ms !== slot.credentialMtimeMs) continue;
      slot.assignments = Math.max(0, finiteNumber(saved.assignments));
      slot.successes = Math.max(0, finiteNumber(saved.successes));
      slot.failures = Math.max(0, finiteNumber(saved.failures));
      slot.lastAssignedAt = Number.isFinite(saved.last_assigned_at) ? saved.last_assigned_at : null;
      slot.cooldownUntil = Math.max(0, finiteNumber(saved.cooldown_until));
      slot.disabled = Boolean(saved.disabled);
    }
    if (Number.isFinite(state.circuit_until)) this.circuitUntil = state.circuit_until;
  }

  async _save() {
    await this.mutex.run("state-save", async () => {
      const accounts = {};
      for (const slot of this.slots) {
        accounts[slot.id] = {
          credential_mtime_ms: slot.credentialMtimeMs,
          assignments: slot.assignments,
          successes: slot.successes,
          failures: slot.failures,
          last_assigned_at: slot.lastAssignedAt,
          cooldown_until: slot.cooldownUntil,
          disabled: slot.disabled,
        };
      }
      await atomicWriteJson(this.statePath, {
        version: 1,
        circuit_until: this.circuitUntil,
        accounts,
      });
    });
  }

  _eligible(slot, now, attempted) {
    return !attempted.has(slot.id) && !slot.disabled && slot.cooldownUntil <= now;
  }

  _wakeWaiters() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  async _acquire(options = {}) {
    const attempted = options.attempted ?? new Set();
    const preferredAccountId = options.preferredAccountId ?? null;

    while (true) {
      let waitPromise = null;
      const selected = await this.mutex.run("pool", async () => {
        if (this.closed) throw new AccountPoolError("Account pool is closed.", { code: "pool_closed" });
        const now = this._time();
        if (this.circuitUntil > now) {
          this.diagnostic("circuit_breaker_active", {
            retry_after: retryAfterSeconds(this.circuitUntil - now),
          });
          throw new AccountPoolError("Account pool circuit breaker is open.", {
            code: "circuit_open",
            retryAfter: retryAfterSeconds(this.circuitUntil - now),
          });
        }
        if (this.slots.length === 0) {
          throw new AccountPoolError("No valid Notion accounts are configured.", {
            code: "no_accounts",
          });
        }

        let candidates = this.slots.filter((slot) => this._eligible(slot, now, attempted));
        const preferred = preferredAccountId
          ? candidates.find((slot) => slot.id === preferredAccountId)
          : null;
        const selection = preferred
          ? "affinity"
          : attempted.size > 0
            ? "failover"
            : "balanced";
        if (preferred) {
          if (preferred.busy) {
            waitPromise = new Promise((resolve) => this.waiters.add(resolve));
            return null;
          }
          candidates = [preferred];
        } else {
          candidates = candidates.filter((slot) => !slot.busy).sort((left, right) => {
            const leftAssigned = left.lastAssignedAt ?? Number.NEGATIVE_INFINITY;
            const rightAssigned = right.lastAssignedAt ?? Number.NEGATIVE_INFINITY;
            return leftAssigned - rightAssigned
              || left.assignments - right.assignments
              || left.slot - right.slot;
          });
        }

        const slot = candidates[0];
        if (!slot) {
          const busyEligible = this.slots.some(
            (candidate) => this._eligible(candidate, now, attempted) && candidate.busy,
          );
          if (busyEligible) {
            waitPromise = new Promise((resolve) => this.waiters.add(resolve));
            return null;
          }
          const retryTimes = this.slots
            .filter((candidate) => !attempted.has(candidate.id) && !candidate.disabled)
            .map((candidate) => candidate.cooldownUntil)
            .filter((value) => value > now);
          const retryAfter = retryTimes.length
            ? retryAfterSeconds(Math.min(...retryTimes) - now)
            : null;
          if (retryAfter === null) {
            this.diagnostic("account_pool_exhausted", {
              attempted: attempted.size,
              configured: this.slots.length,
            });
          } else {
            this.diagnostic("account_pool_cooling_down", {
              retry_after: retryAfter,
              configured: this.slots.length,
            });
          }
          throw new AccountPoolError("No Notion account is currently available.", {
            code: retryAfter === null ? "pool_exhausted" : "pool_cooldown",
            retryAfter,
          });
        }

        slot.busy = true;
        slot.assignments += 1;
        slot.lastAssignedAt = now;
        await this._save();
        this.diagnostic("account_selected", {
          account_id: slot.id,
          slot: slot.slot,
          assignments: slot.assignments,
          selection,
        });
        return slot;
      });
      if (selected) return selected;
      await waitPromise;
    }
  }

  async _providerFor(slot) {
    if (slot.provider) return slot.provider;
    slot.providerPromise ??= Promise.resolve(this.providerFactory({
      account: slot.account,
      accountPath: slot.accountPath,
      accountHome: this.home,
      threadStateDirectory: slot.threadStateDirectory,
      reasoningEffort: MAX_REASONING_EFFORT,
      accountId: slot.id,
      slot: slot.slot,
    }));
    slot.provider = await slot.providerPromise;
    return slot.provider;
  }

  async _release(slot) {
    await this.mutex.run("pool", async () => {
      slot.busy = false;
      this._wakeWaiters();
    });
  }

  _recordMatchingFailure(slot, error, now) {
    const signature = failureSignature(error);
    const recent = (this.failureHistory.get(signature) ?? [])
      .filter((entry) => now - entry.at <= MATCHING_FAILURE_WINDOW_MS && entry.accountId !== slot.id);
    recent.push({ accountId: slot.id, at: now });
    this.failureHistory.set(signature, recent);
    if (new Set(recent.map((entry) => entry.accountId)).size < MATCHING_FAILURE_THRESHOLD) return false;
    this.circuitUntil = now + MATCHING_FAILURE_WINDOW_MS;
    this.diagnostic("account_circuit_opened", {
      failure_signature: sha256(signature).slice(0, 12),
      retry_after: retryAfterSeconds(MATCHING_FAILURE_WINDOW_MS),
    });
    return true;
  }

  async _markFailure(slot, error) {
    const now = this._time();
    slot.failures += 1;
    if (error instanceof NotionAgentError) {
      if (error.code === ErrorCode.AUTH_INVALID || error.code === ErrorCode.PREMIUM_REQUIRED) {
        slot.disabled = true;
        slot.cooldownUntil = 0;
      } else if (error.code === ErrorCode.TRUST_RULE_DENIED || error.retryable === false) {
        slot.cooldownUntil = now + DENIAL_COOLDOWN_MS;
      } else {
        const seconds = Number.isFinite(error.retryAfter)
          ? Math.max(0, error.retryAfter)
          : TRANSIENT_COOLDOWN_MS / 1000;
        slot.cooldownUntil = now + seconds * 1000;
      }
    } else {
      slot.cooldownUntil = now + TRANSIENT_COOLDOWN_MS;
    }
    const circuitOpened = this._recordMatchingFailure(slot, error, now);
    await this._save();
    this.diagnostic("account_request_failed", {
      account_id: slot.id,
      slot: slot.slot,
      ...safeErrorMetadata(error),
      disabled: slot.disabled,
      retry_after: slot.cooldownUntil > now
        ? retryAfterSeconds(slot.cooldownUntil - now)
        : null,
    });
    return circuitOpened;
  }

  async execute(operation, options = {}) {
    if (typeof operation !== "function") throw new TypeError("AccountPool operation must be a function.");
    const attempted = new Set();
    let useRecovery = false;
    let previousError = null;
    let failoverFrom = null;

    while (true) {
      const slot = await this._acquire({
        attempted,
        preferredAccountId: attempted.size === 0 ? options.preferredAccountId : null,
      });
      if (failoverFrom) {
        this.diagnostic("account_failover", {
          failed_account_id: failoverFrom.id,
          from_account_id: failoverFrom.id,
          from_slot: failoverFrom.slot,
          to_account_id: slot.id,
          to_slot: slot.slot,
          attempted: attempted.size,
        });
        failoverFrom = null;
      }
      attempted.add(slot.id);
      const lease = {
        accountId: slot.id,
        accountPath: slot.accountPath,
        slot: slot.slot,
        threadStateDirectory: slot.threadStateDirectory,
      };
      try {
        const provider = await this._providerFor(slot);
        const currentOperation = useRecovery && typeof options.recoveryOperation === "function"
          ? options.recoveryOperation
          : operation;
        const result = await currentOperation(provider, lease, previousError);
        slot.successes += 1;
        await this._save();
        this.diagnostic("account_request_succeeded", {
          account_id: slot.id,
          slot: slot.slot,
        });
        return result;
      } catch (error) {
        if (isCancellationError(error)) {
          this.diagnostic("account_request_cancelled", {
            account_id: slot.id,
            slot: slot.slot,
          });
          throw error;
        }
        if (isLocalStateError(error)) {
          this.diagnostic("account_request_rejected", {
            account_id: slot.id,
            slot: slot.slot,
            ...safeErrorMetadata(error),
          });
          throw error;
        }
        previousError = error;
        const circuitOpened = await this._markFailure(slot, error);
        const failoverAllowed = typeof options.shouldFailover === "function"
          ? await options.shouldFailover(error, lease)
          : options.shouldFailover !== false;
        if (!failoverAllowed) throw error;
        if (circuitOpened) {
          throw new AccountPoolError("Matching failures opened the account pool circuit.", {
            code: "circuit_open",
            retryAfter: retryAfterSeconds(MATCHING_FAILURE_WINDOW_MS),
            cause: error,
          });
        }
        useRecovery = true;
        failoverFrom = { id: slot.id, slot: slot.slot };
      } finally {
        await this._release(slot);
      }
    }
  }

  status() {
    const now = this._time();
    const accounts = this.slots.map((slot) => {
      const cooldown = !slot.disabled && slot.cooldownUntil > now;
      const retryAfter = cooldown ? retryAfterSeconds(slot.cooldownUntil - now) : null;
      return {
        id: slot.id,
        slot: slot.slot,
        busy: slot.busy,
        available: !slot.busy && !slot.disabled && !cooldown,
        cooldown,
        disabled: slot.disabled,
        retryAfter,
        assignments: slot.assignments,
        successes: slot.successes,
        failures: slot.failures,
        lastAssignedAt: slot.lastAssignedAt,
      };
    });
    return {
      configured: accounts.length,
      busy: accounts.filter((entry) => entry.busy).length,
      available: accounts.filter((entry) => entry.available).length,
      cooldown: accounts.filter((entry) => entry.cooldown).length,
      disabled: accounts.filter((entry) => entry.disabled).length,
      discovered: this.discovery.discovered,
      invalid: this.discovery.invalid,
      duplicates: this.discovery.duplicates,
      maximum: MAX_ACCOUNTS,
      globalRetryAfter: this.circuitUntil > now
        ? retryAfterSeconds(this.circuitUntil - now)
        : null,
      accounts,
    };
  }

  async close() {
    this.closed = true;
    this._wakeWaiters();
    const providers = this.slots.map((slot) => slot.provider).filter(Boolean);
    await Promise.all(providers.map(async (provider) => {
      if (typeof provider.close === "function") await provider.close();
      else if (typeof provider.aclose === "function") await provider.aclose();
    }));
  }

  async aclose() {
    await this.close();
  }
}
