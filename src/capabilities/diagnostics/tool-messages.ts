import { defineMessages } from "#sdk/shared/i18n-definition";
import { createTranslator } from "#sdk/shared/i18n";

/** Model-facing documentation stays with the tool contribution, outside the UI catalog. */
const messages = defineMessages("diagnostics-tools", {
  readConsoleMessagesDescription: {
    "zh-CN": "读取当前标签页最近的 console 日志和 JS 异常。适合调试本地 Web 页面、定位报错、确认点击后前端异常。",
    en: "Read recent console messages and JavaScript exceptions from the current tab. Useful for debugging local web pages, investigating errors, and checking for frontend exceptions after a click.",
  },
  readConsoleMessagesTabId: {
    "zh-CN": "本次调用的目标标签页 ID；省略时使用当前任务工作标签页。",
    en: "Target tab ID for this call. Defaults to the current task’s working tab.",
  },
  readConsoleMessagesReset: {
    "zh-CN": "是否清空已有 console 记录并开始监听，默认 false",
    en: "Whether to clear existing console records and start listening. Default: false.",
  },
  readConsoleMessagesLimit: {
    "zh-CN": "返回数量，默认 50",
    en: "Number of results to return. Default: 50.",
  },
  readConsoleMessagesMaxRecords: {
    "zh-CN": "最多保留记录数，默认 200，范围 20-1000",
    en: "Maximum number of records to retain. Default: 200; range: 20–1000.",
  },
  readConsoleMessagesLevel: {
    "zh-CN": "按级别过滤",
    en: "Filter by log level.",
  },
  readConsoleMessagesType: {
    "zh-CN": "按 CDP console type 过滤，如 log/error/warning/exception",
    en: "Filter by CDP console type, such as log/error/warning/exception.",
  },
  readConsoleMessagesTextPattern: {
    "zh-CN": "按日志文本正则过滤",
    en: "Regular expression to match log text.",
  },
  readConsoleMessagesUrlPattern: {
    "zh-CN": "按来源 URL 正则过滤",
    en: "Regular expression to match the source URL.",
  },
  readConsoleMessagesFlags: {
    "zh-CN": "正则 flags，默认 i",
    en: "Regular expression flags. Default: i.",
  },
  networkWatchDescription: {
    "zh-CN": "在已经打开的当前页面上开启或清空 Network 后置监听，只记录调用之后发生的请求，适合观察点击、搜索、提交、翻页等交互后的接口。它不能补抓页面首屏、重定向或导航期间已经发生的请求；要抓打开/跳转加载期请求，请在 open_tab 或 navigate 中传 watchNetwork:true。只记录请求摘要，response body 通过 network_body 按需获取。",
    en: "Start or reset network monitoring on an already open page. Records only requests made after this call, such as those triggered by clicking, searching, submitting, or paging. Cannot recover requests from the initial page load, redirects, or earlier navigation. To capture requests during opening or navigation, pass watchNetwork:true to open_tab or navigate. Records request summaries only; use network_body to retrieve a response body when needed.",
  },
  networkWatchReset: {
    "zh-CN": "是否清空已有记录，默认 true；清空后只保留后续新发生的请求。",
    en: "Whether to clear existing records. Default: true. After clearing, only new requests are retained.",
  },
  networkWatchMaxRecords: {
    "zh-CN": "最多保留请求数，默认 200，范围 20-1000",
    en: "Maximum number of requests to retain. Default: 200; range: 20–1000.",
  },
  networkRecentDescription: {
    "zh-CN": "查看当前标签页最近的 Network 请求摘要。用于诊断接口状态、权限、频控、下载和 SPA 数据来源。",
    en: "View recent network request summaries for the current tab. Useful for diagnosing API status, permissions, rate limits, downloads, and SPA data sources.",
  },
  networkRecentLimit: {
    "zh-CN": "返回数量，默认 20",
    en: "Number of results to return. Default: 20.",
  },
  networkRecentUrlPattern: {
    "zh-CN": "按 URL 正则过滤",
    en: "Regular expression to match request URLs.",
  },
  networkRecentFlags: {
    "zh-CN": "URL 正则 flags，默认 i",
    en: "URL regular expression flags. Default: i.",
  },
  networkRecentMethod: {
    "zh-CN": "GET/POST 等",
    en: "HTTP method, such as GET or POST.",
  },
  networkRecentStatus: {
    "zh-CN": "精确状态码过滤",
    en: "Filter by an exact HTTP status code.",
  },
  networkRecentFailed: {
    "zh-CN": "只看失败或成功请求",
    en: "Filter for failed requests (true) or successful requests (false).",
  },
  networkRecentResourceType: {
    "zh-CN": "XHR/Fetch/Document/Image 等 CDP resource type",
    en: "CDP resource type, such as XHR/Fetch/Document/Image.",
  },
  networkRecentMimePattern: {
    "zh-CN": "按 mimeType 正则过滤",
    en: "Regular expression to match mimeType.",
  },
  networkBodyDescription: {
    "zh-CN": "读取某条 Network 响应的 body。需要先 network_watch 并从 network_recent / wait_for_response 获取 requestId。",
    en: "Read the body of a network response. First start network_watch, then obtain requestId from network_recent or wait_for_response.",
  },
  networkBodyMaxBytes: {
    "zh-CN": "最多返回字符数，默认 120000",
    en: "Maximum number of characters to return. Default: 120000.",
  },
  waitForResponseDescription: {
    "zh-CN": "等待匹配 URL/状态/method/mimeType 的 Network 响应出现。适合点击、搜索、提交后确认接口结果。",
    en: "Wait for a network response matching URL, status, method, or mimeType. Useful for checking API results after clicking, searching, or submitting.",
  },
  waitForResponseUrlPattern: {
    "zh-CN": "URL 正则，必填",
    en: "Required regular expression to match the URL.",
  },
  waitForResponseStatus: {
    "zh-CN": "精确状态码",
    en: "Exact HTTP status code.",
  },
  waitForResponseMimePattern: {
    "zh-CN": "mimeType 正则",
    en: "Regular expression to match mimeType.",
  },
  waitForResponseTimeout: {
    "zh-CN": "超时秒数，默认 10",
    en: "Timeout in seconds. Default: 10.",
  },
  waitForResponseIncludeBody: {
    "zh-CN": "是否等待加载完成并返回 body，默认 false",
    en: "Whether to wait for loading to finish and return the response body. Default: false.",
  },
  waitForResponseMaxBytes: {
    "zh-CN": "body 最大字符数，默认 120000",
    en: "Maximum number of body characters. Default: 120000.",
  },
  waitForNetworkIdleDescription: {
    "zh-CN": "等待当前标签页 Network 空闲。适合点击、搜索、翻页后替代固定 wait。",
    en: "Wait for network activity in the current tab to become idle. Use after clicking, searching, or paging instead of a fixed delay.",
  },
  waitForNetworkIdleIdleSeconds: {
    "zh-CN": "连续空闲秒数，默认 0.8",
    en: "Required continuous idle period in seconds. Default: 0.8.",
  },
  waitForNetworkIdleTimeout: {
    "zh-CN": "总超时秒数，默认 10",
    en: "Overall timeout in seconds. Default: 10.",
  },
  waitForNetworkIdleUrlPattern: {
    "zh-CN": "只关注匹配 URL 的请求",
    en: "Consider only requests whose URLs match this pattern.",
  },
  networkWatchingBeforeNavigation: {
    "zh-CN": "已在导航前开启 Network 监听；页面加载后可用 network_recent 查看首屏请求。",
    en: "Network monitoring started before navigation. After the page loads, use network_recent to inspect initial requests.",
  },
});

export const toolT = createTranslator(messages);
