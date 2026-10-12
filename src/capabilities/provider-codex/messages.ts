import { defineMessages } from "#sdk/shared/i18n-definition";

/** Package-owned interface text. Identifiers and user content remain untranslated. */
export default defineMessages("provider-codex", {
  allProviders: { "zh-CN": "所有服务商", en: "All providers" },
  "signInWithYourChatgptAccountToUseCodex": { "zh-CN": "使用 ChatGPT 账号登录后即可调用 Codex 模型。", en: "Sign in with your ChatGPT account to use Codex models." },
  "openaiCodexModelsApiReturnedAnEmptyModelList": { "zh-CN": "OpenAI Codex Models API 返回了空模型列表", en: "OpenAI Codex Models API returned an empty model list" },
  "theLoginSessionExpiredStartCodexLoginAgain": { "zh-CN": "登录会话已失效，请重新开始 Codex 登录。", en: "Your sign-in session has expired. Sign in to Codex again." },
  "theCodexLoginCodeExpiredStartLoginAgain": { "zh-CN": "Codex 登录码已过期，请重新开始登录。", en: "Your Codex sign-in code has expired. Start again." },
  "signInToOpenaiCodexInSettingsFirst": { "zh-CN": "请先在设置中完成 OpenAI Codex 登录。", en: "Sign in to OpenAI Codex in Settings first." },
  "openaiCodexLoginIsMissingAnAccessTokenSign": { "zh-CN": "OpenAI Codex 登录缺少 access token，请重新登录。", en: "No access token was received from OpenAI Codex. Sign in again." },
  "openaiCodexLoginExpiredOrLacksPermissionSignIn": { "zh-CN": "OpenAI Codex 登录失效或无权限 ({status})，请重新登录。{detail}", en: "Your OpenAI Codex session has expired or does not have the required permissions ({status}). Sign in again. {detail}" },
  "couldNotReadTheChatgptAccountIdFromThe": { "zh-CN": "无法从 OpenAI Codex token 中读取 ChatGPT account id", en: "Could not read the ChatGPT account ID from the OpenAI Codex token" },
  "loginCanceledStartAgain": { "zh-CN": "登录已取消，请重新开始。", en: "Sign-in canceled. Start again." },
});
