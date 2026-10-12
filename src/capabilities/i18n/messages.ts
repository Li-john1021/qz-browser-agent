import { defineMessages } from "#sdk/shared/i18n-definition";

export default defineMessages("language-settings", {
  title: { en: "Language", "zh-CN": "语言" },
  advanced: { en: "Advanced", "zh-CN": "高级" },
  interfaceLanguage: { en: "Interface language", "zh-CN": "界面语言" },
  followBrowser: { en: "Follow browser", "zh-CN": "跟随浏览器" },
  loading: { en: "Loading language preference…", "zh-CN": "正在读取语言设置…" },
  unsavedChanges: { en: "Unsaved changes", "zh-CN": "有未保存修改" },
  saveFailed: { en: "Could not save the language. Try again.", "zh-CN": "语言设置保存失败，请重试。" },
  loadFailed: { en: "Could not load the saved language. Reopen settings to try again.", "zh-CN": "无法读取语言设置，请重新打开设置后重试。" },
  save: { en: "Save", "zh-CN": "保存" },
  saved: { en: "Saved", "zh-CN": "已保存" },
  saving: { en: "Saving…", "zh-CN": "正在保存…" },
});
