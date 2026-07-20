import {
  extractPlannerAction,
  extractWorkflowCall,
  plannerPrompt,
  plannerTool,
} from "./server-protocol.js";

const MAX_PLANNER_ACTIONS = 20;
const MAX_WORKFLOW_TOOLS = 12;
const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_read", "cache_creation"];

function createUsageTotal() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function addCompletionUsage(total, completion) {
  for (const key of USAGE_KEYS) {
    const value = Number(completion?.usage?.[key]);
    if (Number.isFinite(value)) total[key] += value;
  }
}

function withAggregatedUsage(completion, total) {
  return {
    ...completion,
    usage: {
      ...(completion?.usage ?? {}),
      ...total,
    },
  };
}

function completedEntry(kind, name, result) {
  return `${kind}: ${name}\nResult:\n${result}`;
}

export function createAgentOrchestrator({
  accountPool,
  runtimeTools = null,
  workflowId = "",
  codeRoot = process.cwd(),
} = {}) {
  async function callRuntimeTool(name, argumentsValue) {
    if (!runtimeTools) throw new Error("Runtime tools are not configured");
    if (name === "listTools") {
      return JSON.stringify({ tools: runtimeTools.listTools() });
    }
    return runtimeTools.callToolText(name, argumentsValue);
  }

  async function runToolSafely(name, argumentsValue) {
    try {
      return await callRuntimeTool(name, argumentsValue);
    } catch (error) {
      return JSON.stringify({ isError: true, error: error?.message || String(error) });
    }
  }

  async function executeInitial(options, poolOptions = {}) {
    return accountPool.execute(async (provider, lease) => ({
      completion: await provider.complete(options),
      lease,
    }), poolOptions);
  }

  async function executeContinuation(current, continuationOptions, recoveryOptions) {
    const preferredAccountId = current.lease.accountId;
    const recover = async (provider, lease) => ({
      completion: await provider.complete(recoveryOptions),
      lease,
    });
    return accountPool.execute(
      async (provider, lease) => {
        if (lease.accountId !== preferredAccountId) return recover(provider, lease);
        return {
          completion: await provider.complete(continuationOptions),
          lease,
        };
      },
      {
        preferredAccountId,
        recoveryOperation: recover,
      },
    );
  }

  async function runPlanner({ prompt, system, model }) {
    let current = await executeInitial({
      prompt: plannerPrompt(prompt, system, { codeRoot }),
      model,
      webSearch: false,
      workspaceSearch: false,
      askMode: true,
    });
    const usageTotal = createUsageTotal();
    addCompletionUsage(usageTotal, current.completion);
    const completedActions = [];

    for (let index = 0; index < MAX_PLANNER_ACTIONS; index += 1) {
      const action = extractPlannerAction(current.completion.text);
      if (!action) return withAggregatedUsage(current.completion, usageTotal);
      if (action.action === "final") {
        return withAggregatedUsage({
          ...current.completion,
          text: String(action.message ?? "Task completed."),
        }, usageTotal);
      }

      const mapped = plannerTool(action);
      const name = mapped?.name ?? String(action.action);
      const toolResult = mapped
        ? await runToolSafely(mapped.name, mapped.arguments)
        : JSON.stringify({ isError: true, error: "Unknown action" });
      completedActions.push(completedEntry("Action", name, toolResult));

      const continuationPrompt =
        "The local operator executed your recommendation.\n"
        + `${completedActions.at(-1)}\n\n`
        + "Recommend exactly one next action using the same JSON-only format. "
        + "Use final only after the original task is complete and verified.";
      const recoveryTask =
        `${prompt}\n\n`
        + "A previous Notion account failed after the local operator had already "
        + "completed the actions below. Continue from this state and do not repeat them.\n\n"
        + completedActions.join("\n\n");

      current = await executeContinuation(
        current,
        {
          prompt: continuationPrompt,
          model,
          webSearch: false,
          workspaceSearch: false,
          askMode: true,
          threadId: current.completion.thread_id,
        },
        {
          prompt: plannerPrompt(recoveryTask, system, { codeRoot }),
          model,
          webSearch: false,
          workspaceSearch: false,
          askMode: true,
        },
      );
      addCompletionUsage(usageTotal, current.completion);
    }
    throw new Error("The planner exceeded the maximum action-loop depth");
  }

  async function runWorkflow({ prompt, system, model }) {
    let current = await executeInitial({
      prompt,
      system,
      model,
      webSearch: false,
      workspaceSearch: true,
      askMode: false,
      workflowId,
    });
    const usageTotal = createUsageTotal();
    addCompletionUsage(usageTotal, current.completion);
    const completedTools = [];

    for (let index = 0; index < MAX_WORKFLOW_TOOLS; index += 1) {
      const toolCall = extractWorkflowCall(current.completion.text);
      if (!toolCall) return withAggregatedUsage(current.completion, usageTotal);
      const toolResult = await runToolSafely(toolCall.name, toolCall.arguments);
      completedTools.push(completedEntry("Tool", toolCall.name, toolResult));

      const continuationPrompt =
        "The requested runtime tool has completed.\n"
        + `${completedTools.at(-1)}\n\n`
        + "Continue the task. If another runtime tool is needed, emit the same function JSON; "
        + "otherwise provide the final answer to the user.";
      const recoveryPrompt =
        `Original task:\n${prompt}\n\n`
        + "Continue the task on a new account. The runtime tools below already completed; "
        + "do not repeat them.\n\n"
        + completedTools.join("\n\n");

      current = await executeContinuation(
        current,
        {
          prompt: continuationPrompt,
          model,
          askMode: false,
          workflowId,
          threadId: current.completion.thread_id,
        },
        {
          prompt: recoveryPrompt,
          system,
          model,
          webSearch: false,
          workspaceSearch: true,
          askMode: false,
          workflowId,
        },
      );
      addCompletionUsage(usageTotal, current.completion);
    }
    throw new Error("The agent exceeded the maximum tool-call loop depth");
  }

  async function complete({
    prompt,
    system = null,
    plannerMode = false,
    model,
    onTextDelta = null,
    onTextDeltaAsync = null,
  }) {
    if (!accountPool) throw new Error("No valid Notion accounts are configured");
    if (plannerMode && !workflowId) return runPlanner({ prompt, system, model });
    if (workflowId) return runWorkflow({ prompt, system, model });
    const hasStreamingCallback = Boolean(onTextDelta || onTextDeltaAsync);
    let emittedText = false;
    const forwardedTextDelta = onTextDelta
      ? (delta) => {
        onTextDelta(delta);
        if (String(delta ?? "")) emittedText = true;
      }
      : null;
    const forwardedTextDeltaAsync = onTextDeltaAsync
      ? async (delta) => {
        await onTextDeltaAsync(delta);
        if (String(delta ?? "")) emittedText = true;
      }
      : null;
    const result = await executeInitial({
      prompt,
      system,
      model,
      webSearch: false,
      workspaceSearch: true,
      askMode: true,
      onTextDelta: forwardedTextDelta,
      onTextDeltaAsync: forwardedTextDeltaAsync,
    }, hasStreamingCallback ? {
      shouldFailover: () => !emittedText,
    } : {});
    return result.completion;
  }

  return { complete };
}
