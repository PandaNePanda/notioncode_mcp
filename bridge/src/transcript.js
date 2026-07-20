import { randomUUID } from "node:crypto";
import { hasJarvisBinding } from "./account.js";

function offsetDateTime(date, timeZone) {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset",
  };
  if (timeZone) options.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  let offset = values.timeZoneName?.replace(/^GMT/, "") || "+00:00";
  if (!offset) offset = "+00:00";
  if (/^[+-]\d{2}$/.test(offset)) offset += ":00";
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond}${offset}`;
}

export function currentDateTime(timeZone, date = new Date()) {
  try {
    return offsetDateTime(date, timeZone);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return offsetDateTime(date);
  }
}

export function newUuid() {
  return randomUUID();
}

export function buildConfigValue({
  notionModel,
  isSubsequentTurn = false,
  useWebSearch = true,
  useWorkspaceSearch = true,
  useReadOnlyMode = false,
  reasoningEffort,
}) {
  const config = {
    type: "workflow",
    modelFromUser: !isSubsequentTurn,
    enableAgentAutomations: true,
    enableAgentIntegrations: true,
    enableCustomAgents: true,
    enableExperimentalIntegrations: false,
    enableAgentDiffs: true,
    enableAgentUpdatePagePatch: true,
    enableCsvAttachmentSupport: true,
    enableDatabaseAgents: true,
    showDatabaseAgentsDiscoverability: true,
    enableAgentThreadTools: false,
    enableCrdtOperations: false,
    enableAgentCardCustomization: true,
    enableSystemPromptAsPage: false,
    enableUserSessionContext: false,
    enableLargeToolResultComputerOffload: false,
    enableScriptAgentAdvanced: false,
    enableScriptAgent: true,
    enableScriptAgentSearchConnectorsInCustomAgent: false,
    enableScriptAgentGoogleDriveInCustomAgent: false,
    enableScriptAgentGoogleDriveOAuthInCustomAgent: false,
    enableScriptAgentSlack: true,
    enableScriptAgentMcpServers: false,
    enableScriptAgentMail: true,
    enableScriptAgentGtm: false,
    enableScriptAgentCustomToolCalling: true,
    enableComputer: false,
    enableCreateAndRunThread: true,
    enableSoftwareFactoryPage: false,
    enableAgentGenerateImage: true,
    enableSpeculativeSearch: false,
    enableQueryCalendar: false,
    enableQueryMail: false,
    enableMailExplicitToolCalls: true,
    enableMailNotificationPreferences: false,
    enableMailAgentMultiProviderSupport: false,
    useRulePrioritization: true,
    availableConnectors: [],
    customConnectorInfo: [],
    searchScopes: [{ type: "everything" }],
    useSearchToolV2: false,
    useWebSearch,
    isHipaa: false,
    yoloMode: false,
    useReadOnlyMode,
    writerMode: false,
    model: notionModel,
    isCustomAgent: false,
    isCustomAgentBuilder: false,
    isAgentResearchRequest: false,
    useCustomAgentDraft: false,
    use_draft_actor_pointer: false,
    enableUpdatePageAutofixer: true,
    enableMarkdownVNext: false,
    updatePageStaleViewGuardEnabled: false,
    enableUpdatePageOrderUpdates: true,
    enableAgentSupportPropertyReorder: true,
    agentShortUpdatePageResult: true,
    enableAgentAskSurvey: true,
    databaseAgentConfigMode: false,
    isOnboardingAgent: false,
    isMobile: false,
  };
  if (reasoningEffort != null) config.reasoningEffort = reasoningEffort;
  if (!useWorkspaceSearch && !useWebSearch) delete config.searchScopes;
  if (isSubsequentTurn) config.isThreadStartedByAdmin = true;
  return config;
}

export function buildContextValue(account, { currentDatetime, workflowId, now } = {}) {
  const context = {
    timezone: account.timezone,
    userName: account.user_name,
    userId: account.user_id,
    userEmail: account.user_email,
    spaceName: account.space_name,
    spaceId: account.space_id,
    spaceViewId: account.space_view_id,
    currentDatetime: currentDatetime || currentDateTime(account.timezone, now),
    surface: workflowId ? "custom_agent" : "ai_module",
  };
  if (workflowId) context.workflowId = workflowId;
  if (hasJarvisBinding(account)) {
    context.agentName = account.agent_name;
    if (account.agent_accessory) context.agentAccessory = account.agent_accessory;
    context.context_page_id = account.agent_context_page_id;
  }
  return context;
}

export function buildFullTranscript(account, {
  userText,
  notionModel,
  reasoningEffort,
  useWebSearch = true,
  useWorkspaceSearch = true,
  useReadOnlyMode = false,
  configId,
  contextId,
  now,
  workflowId,
  uuid = newUuid,
}) {
  const timestamp = typeof now === "string" ? now : currentDateTime(account.timezone, now);
  return [
    {
      id: configId || uuid(),
      type: "config",
      value: buildConfigValue({
        notionModel,
        reasoningEffort,
        useWebSearch,
        useWorkspaceSearch,
        useReadOnlyMode,
      }),
    },
    {
      id: contextId || uuid(),
      type: "context",
      value: buildContextValue(account, { currentDatetime: timestamp, workflowId }),
    },
    {
      id: uuid(),
      type: "user",
      value: [[userText]],
      userId: account.user_id,
      createdAt: timestamp,
    },
  ];
}

export function buildPartialTranscript(account, {
  newUserText,
  notionModel,
  reasoningEffort,
  configId,
  contextId,
  updatedConfigIds,
  useWebSearch = true,
  useWorkspaceSearch = true,
  useReadOnlyMode = false,
  originalDatetime,
  workflowId,
  now,
  uuid = newUuid,
}) {
  const transcript = [
    {
      id: configId,
      type: "config",
      value: buildConfigValue({
        notionModel,
        reasoningEffort,
        isSubsequentTurn: true,
        useWebSearch,
        useWorkspaceSearch,
        useReadOnlyMode,
      }),
    },
    {
      id: contextId,
      type: "context",
      value: buildContextValue(account, { currentDatetime: originalDatetime, workflowId, now }),
    },
  ];
  for (const id of updatedConfigIds) transcript.push({ id, type: "updated-config" });
  transcript.push({
    id: uuid(),
    type: "user",
    value: [[newUserText]],
    userId: account.user_id,
    createdAt: currentDateTime(account.timezone, now),
  });
  return transcript;
}

export function buildInferenceRequest(account, {
  transcript,
  threadId,
  createThread,
  isPartialTranscript,
  asPatchResponse = true,
  generateTitle = true,
  traceId,
  workflowId,
  uuid = newUuid,
}) {
  const body = {
    traceId: traceId || uuid(),
    spaceId: account.space_id,
    transcript,
    threadId,
    createThread,
    isPartialTranscript,
    generateTitle: generateTitle && createThread,
    saveAllThreadOperations: true,
    setUnreadState: true,
    threadType: "workflow",
    asPatchResponse,
    hasHeartbeat: false,
    createdSource: workflowId ? "custom_agent" : "ai_module",
    isUserInAnySalesAssistedSpace: false,
    isSpaceSalesAssisted: false,
    debugOverrides: {
      emitAgentSearchExtractedResults: true,
      cachedInferences: {},
      annotationInferences: {},
      emitInferences: false,
    },
  };
  if (createThread) {
    body.threadParentPointer = {
      table: workflowId ? "workflow" : "space",
      id: workflowId || account.space_id,
      spaceId: account.space_id,
    };
  }
  return body;
}
