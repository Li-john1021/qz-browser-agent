import { defineMessages } from "#sdk/shared/i18n-definition";

/** Package-owned interface text. Identifiers and user content remain untranslated. */
export default defineMessages("bookmarks", {
  "bookmarks": { "zh-CN": "书签", en: "Bookmarks" },
  "history": { "zh-CN": "历史", en: "History" },
  "items": { "zh-CN": "条目", en: "Items" },
  "visits": { "zh-CN": "{count} 次", en: "Visits: {count}" },
  "deleted": { "zh-CN": "已删除 {count}", en: "Deleted {count}" },
  "manageBookmarks": { "zh-CN": "管理书签", en: "Manage bookmarks" },
  "manageBookmarksShort": { "zh-CN": "管理书签", en: "Manage bookmarks" },
  "browsingHistory": { "zh-CN": "浏览历史", en: "Browsing history" },
  "browsingHistoryShort": { "zh-CN": "浏览历史", en: "History" },
  "manageBookmarksSearchRequiresANonEmptyQuery": { "zh-CN": "搜索书签需要非空 query。", en: "Searching bookmarks requires a non-empty query." },
  "manageBookmarksCreateRequiresTitleOrUrl": { "zh-CN": "创建书签需要 title 或 url。", en: "Creating a bookmark requires title or url." },
  "manageBookmarksUpdateRequiresId": { "zh-CN": "更新书签需要 id。", en: "Updating a bookmark requires id." },
  "manageBookmarksUpdateRequiresTitleOrUrlToMove": { "zh-CN": "更新书签需要 title 或 url。移动书签或文件夹时，请使用 action=move 并传入 parentId 或 index。", en: "Updating a bookmark requires title or url. To move a bookmark or folder, use action=move with parentId or index." },
  "manageBookmarksMoveRequiresId": { "zh-CN": "移动书签需要 id。", en: "Moving a bookmark requires id." },
  "manageBookmarksMoveRequiresParentidOrIndex": { "zh-CN": "移动书签需要 parentId 或 index。", en: "Moving a bookmark requires parentId or index." },
  "manageBookmarksDeleteRequiresId": { "zh-CN": "删除书签需要 id。", en: "Deleting a bookmark requires id." },
  "unsupportedManageBookmarksAction": { "zh-CN": "不支持的 manage_bookmarks 操作：{action}", en: "Unsupported manage_bookmarks action: {action}" },
  "browseHistorySearchRequiresANonEmptyQuery": { "zh-CN": "搜索浏览历史需要非空 query。", en: "Searching browsing history requires a non-empty query." },
  "unsupportedBrowseHistoryAction": { "zh-CN": "不支持的 browse_history 操作：{action}", en: "Unsupported browse_history action: {action}" },
}, { historicalLabels: [
  "manageBookmarks", "browsingHistory",
] });
