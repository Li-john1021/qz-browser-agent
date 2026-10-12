import { t } from "./i18n.js";
import type { ProviderDefinition } from '#sdk/background/providers';
import { OPENAI_CODEX_DEFAULT_BASE_URL, resolveCodexEndpoint } from './endpoints.js';
import { getCodexAuthStatus, startCodexDeviceLogin, pollCodexDeviceLogin, clearCodexAuth } from './auth.js';
import { listModels, compareModels } from './models.js';
import { modelOptions } from './options.js';

const OPENAI_CODEX_STATIC_MODELS = [
  { id: "gpt-6-astra", ownedBy: "ChatGPT Codex · 272K · image", priority: 800 },
  { id: "gpt-5.6-sol", ownedBy: "ChatGPT Codex · 272K · image", priority: 700 },
  { id: "gpt-5.6-terra", ownedBy: "ChatGPT Codex · 272K · image", priority: 600 },
  { id: "gpt-5.6-luna", ownedBy: "ChatGPT Codex · 272K · image", priority: 500 },
  { id: "gpt-5.5", ownedBy: "ChatGPT Codex · 272K · image", priority: 400 },
  { id: "gpt-5.4", ownedBy: "ChatGPT Codex · 272K · image", priority: 300 },
  { id: "gpt-5.4-mini", ownedBy: "ChatGPT Codex · 272K · image", priority: 250 },
  { id: "gpt-5.3-codex-spark", ownedBy: "ChatGPT Codex · 128K · text", priority: 200 },
];

export default {
  openaicodex: {
    label: "OpenAI Codex",
    group: { id: "all", get label() { return t("allProviders"); }, priority: 100 },
    api: "openai-codex-responses",
    protocol: "openai-codex",
    baseUrl: OPENAI_CODEX_DEFAULT_BASE_URL,
    endpoint: `${OPENAI_CODEX_DEFAULT_BASE_URL}/codex/responses`,
    modelsEndpoint: `${OPENAI_CODEX_DEFAULT_BASE_URL}/codex/models`,
    modelsAuth: false,
    staticModels: OPENAI_CODEX_STATIC_MODELS,
    excludedModelIds: ["codex-auto-review"],
    compareModels, listModels, modelOptions,
    requiresApiKey: false,
    resolveEndpoint: definition => resolveCodexEndpoint(definition.endpoint || definition.baseUrl),
    auth: { label: "Codex", get hint() { return t("signInWithYourChatgptAccountToUseCodex"); }, legacyStatusKey: "codexAuthStatus",
      status: getCodexAuthStatus, start: startCodexDeviceLogin, poll: pollCodexDeviceLogin, clear: clearCodexAuth },
    defaultContextWindow: 272000,
  },
} satisfies Readonly<Record<string, ProviderDefinition>>;
