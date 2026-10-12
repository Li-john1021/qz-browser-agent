import type { ModelCapability, ModelCapabilityContribution, ProviderModelCapabilities } from "#sdk/shared/models";

const K = 1024;
const ONE_MILLION = 1000000;
const ONE_MIB = 1024 * 1024;
const DOMESTIC_PROVIDER_MODEL_CONFIGS: Readonly<Record<string, ProviderModelCapabilities>> = {
  bailian: makeBailianProviderConfig("bailian", "阿里云百炼官方文档"),
  alibabacoding: makeBailianTokenPlanProviderConfig(),
  kimicode: {
    providerId: "kimicode",
    providerLabel: "Kimi Code 官方文档",
    source: "kimi-code-docs",
    models: [
      {
        id: "kimi-for-coding",
        contextWindow: 262144,
        maxOutputTokens: 32768,
        vision: true,
      },
    ],
  },
  minimaxcn: makeMiniMaxProviderConfig(),
  xiaomi: makeMimoProviderConfig("xiaomi", "小米 MiMo 官方文档"),
  xiaomitokenplancn: makeMimoProviderConfig("xiaomitokenplancn", "小米 MiMo Token Plan 国内官方文档"),
  zhipuai: makeGlmProviderConfig("zhipuai", "智谱 GLM 官方文档"),
};

const MODELS_DEV_PROVIDER_IDS: Readonly<Record<string, string>> = {
  fireworks: "fireworks-ai",
  bailian: "alibaba-cn",
  alibabacoding: "alibaba-token-plan-cn",
  zhipuai: "zhipuai",
  minimaxcn: "minimax-cn",
  volcengine: "volcengine",
  xiaomi: "xiaomi",
  xiaomitokenplancn: "xiaomi-token-plan-cn",
  kimicode: "kimi-code-plan-cn",
  deepseek: "deepseek",
  moonshotai: "moonshotai-cn",
  siliconflowcn: "siliconflow-cn",
  stepfun: "stepfun",
  stepfunai: "stepfun-ai-step-plan",
  tencentcoding: "tencent-coding-plan",
  tencenttokenhub: "tencent-tokenhub",
  opencodego: "opencode-go",
  opencodezen: "opencode",
};

export default { official: DOMESTIC_PROVIDER_MODEL_CONFIGS, modelsDev: MODELS_DEV_PROVIDER_IDS } satisfies ModelCapabilityContribution;

function makeGlmProviderConfig(providerId: string, providerLabel: string) {
  return {
    providerId,
    providerLabel,
    source: "bigmodel-docs",
    models: [
      ...makeModels([
        "GLM-5.1",
        "GLM-5",
        "GLM-5-Turbo",
        "GLM-4.7",
        "GLM-4.7-FlashX",
        "GLM-4.6",
        "GLM-4.7-Flash",
      ], 200 * K, 128 * K, false),
      ...makeModels([
        "GLM-4.5-Air",
        "GLM-4.5-AirX",
        "GLM-4.5-Flash",
      ], 128 * K, 96 * K, false),
      ...makeModels([
        "GLM-4-FlashX-250414",
        "GLM-4-Flash-250414",
      ], 128 * K, 16 * K, false),
      ...makeModels(["GLM-4-Long"], ONE_MIB, 4 * K, false),
      ...makeModels(["GLM-5V-Turbo"], 200 * K, 128 * K, true),
      ...makeModels(["GLM-4.6V", "GLM-4.6V-Flash"], 128 * K, 32 * K, true),
      ...makeModels([
        "GLM-4.1V-Thinking-FlashX",
        "GLM-4.1V-Thinking-Flash",
      ], 64 * K, 16 * K, true),
      ...makeModels(["GLM-4V-Flash"], 16 * K, K, true),
    ],
  };
}

function makeBailianProviderConfig(providerId: string, providerLabel: string) {
  return {
    providerId,
    providerLabel,
    source: "aliyun-bailian-docs",
    models: [
      ...makeModels([
        "qwen3.7-max",
        "qwen3.7-max-2026-06-08",
        "qwen3.7-max-2026-05-20",
        "qwen3.7-max-2026-05-17",
        "qwen3.7-max-preview",
      ], ONE_MILLION, 64 * K, false),
      ...makeModels([
        "qwen3.7-plus",
        "qwen3.7-plus-2026-05-26",
        "qwen3.6-plus",
        "qwen3.6-plus-2026-04-02",
        "qwen3.6-flash",
        "qwen3.6-flash-2026-04-16",
        "qwen3.5-plus",
        "qwen3.5-plus-2026-02-15",
        "qwen3.5-flash",
        "qwen3.5-flash-2026-02-23",
      ], ONE_MILLION, 64 * K, true),
      ...makeModels(["qwen3.6-max-preview"], 256 * K, 64 * K, false),
      ...makeModels([
        "qwen3.5-397b-a17b",
        "qwen3.5-122b-a10b",
        "qwen3.5-27b",
        "qwen3.5-35b-a3b",
      ], 256 * K, 64 * K, true),
      ...makeModels(["deepseek-v4-pro", "deepseek-v4-flash"], ONE_MILLION, 384000, false),
      ...makeModels(["glm-5.1"], 198 * K, 128 * K, false),
      ...makeModels(["kimi-k2.6"], 256 * K, 96 * K, true),
      ...makeModels(["MiniMax-M2.5"], 192 * K, 32 * K, false),
      ...makeModels(["mimo-v2.5-pro"], ONE_MILLION, 128 * K, false),
    ],
  };
}

function makeBailianTokenPlanProviderConfig() {
  return {
    providerId: "alibabacoding",
    providerLabel: "阿里云百炼 Token Plan 官方文档",
    source: "aliyun-bailian-token-plan-docs",
    models: [
      ...makeModels(["qwen3.7-max"], ONE_MILLION, 64 * K, false),
      ...makeModels(["qwen3.7-plus", "qwen3.6-plus"], ONE_MILLION, 64 * K, true),
      ...makeModels(["qwen3.6-flash"], ONE_MILLION, 32 * K, true),
      ...makeModels(["deepseek-v4-pro"], 160 * K, 32 * K, false),
      ...makeModels(["deepseek-v4-flash", "deepseek-v3.2"], 160 * K, 16 * K, false),
      ...makeModels(["kimi-k2.6"], 262144, 32 * K, true),
      ...makeModels(["kimi-k2.5"], 262144, 16 * K, true),
      ...makeModels(["glm-5.1", "glm-5"], 198 * K, 16 * K, false),
      ...makeModels(["MiniMax-M2.5"], 200 * K, 128 * K, false),
    ],
  };
}

function makeMiniMaxProviderConfig() {
  return {
    providerId: "minimaxcn",
    providerLabel: "MiniMax 国内官方文档",
    source: "minimax-cn-docs",
    models: [
      ...makeModels(["MiniMax-M3"], ONE_MILLION, null, true),
      ...makeModels([
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2.1-highspeed",
        "MiniMax-M2",
      ], 200 * K, null, false),
    ],
  };
}

function makeMimoProviderConfig(providerId: string, providerLabel: string) {
  return {
    providerId,
    providerLabel,
    source: "xiaomi-mimo-cn-docs",
    models: [
      ...makeModels(["mimo-v2.5-pro", "mimo-v2-pro"], ONE_MIB, 128 * K, false),
      ...makeModels(["mimo-v2.5"], ONE_MIB, 128 * K, true),
      ...makeModels(["mimo-v2-omni"], 256 * K, 128 * K, true),
      ...makeModels(["mimo-v2-flash"], 256 * K, 64 * K, false),
    ],
  };
}

function makeModels(ids: readonly string[], contextWindow: number, maxOutputTokens: number | null, vision: boolean): ModelCapability[] {
  return ids.map(id => ({
    id,
    contextWindow,
    maxOutputTokens,
    vision,
  }));
}
