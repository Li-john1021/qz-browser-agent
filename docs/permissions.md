# Browser permissions and data access

This guide explains the 19 permissions and host permission in [manifest.json](../src/manifest.json).
All are declared at installation and remain subject to Chrome, operating system, and website
restrictions. The Feature column identifies how each permission is used.

## Permission use

| Permission | Purpose and main callers | Feature |
| --- | --- | --- |
| `sidePanel` | Open the workspace; `background/service-worker.ts` and window commands | Core UI |
| `storage` | Store model settings, Sessions, Skills, and versioned repository records | Core state |
| `unlimitedStorage` | Persist conversations, documents, Data tables, and resources locally; disk space can still run out | Core state |
| `tabs` | Read URLs, titles, and status of task-owned tabs; `background/session/tabs.ts` | Page operations |
| `tabGroups` | Group task tabs; `shared/tab-groups.ts` | Task organization |
| `scripting` | Inject Content features and self-contained functions into task pages; `background/tools/runtime.ts` | Page operations |
| `debugger` | Use CDP to operate pages, capture screenshots, inspect requests, and print PDFs; `background/tools/cdp-runtime.ts` and tools | Page operations |
| `activeTab` | Access a page after user interaction and provide a screenshot fallback for the task's target; `capabilities/media/tools.ts` | Screenshots |
| `offscreen` | Bridge sandboxed scripts, keep background work alive, and convert images; `background/services/offscreen-document.ts` | Scripts and conversion |
| `alarms` | Schedule tasks, reminders, and background maintenance; `background/automation/runtime.ts` | Scheduling |
| `downloads` | Save files, documents, and exports; file tools, Artifacts, and export features | Files |
| `downloads.open` | Open saved files from Artifacts; `capabilities/sessions/artifacts/artifacts-feature.ts` | Files |
| `desktopCapture` | Let the user choose a screen or window when recording a case; `sidepanel/features/chat/case-recording-feature.ts` | Optional recording |
| `geolocation` | Add location context to a task; `sidepanel/features/app/dynamic-context-provider.ts` | Optional context |
| `bookmarks` | Search and manage bookmarks; `capabilities/bookmarks/tools.ts` | Optional tools |
| `history` | Search browsing history; `capabilities/bookmarks/tools.ts` | Optional tools |
| `clipboardWrite` | Copy answers, code, tables, and exported page content | UI actions |
| `notifications` | Show explicit reminders and task completion notifications; `background/services/chrome-notifications.ts` | Optional notifications |
| `declarativeNetRequest` | Apply provider headers and authorized Skill network rules; `rules/` and `background/skills/skill-network.ts` | Network access |
| `<all_urls>` | Run Content Scripts, browse across sites, and access user-configured provider and Skill endpoints | Host access |

Page tools require the Session's working tab or an explicitly authorized target. Tools, navigation,
fetch, MCP, and Skill resources also enforce shared safety checks. File URLs also require Chrome's
**Allow access to file URLs** setting.

Capabilities declare operations and UI; Background and Chrome enforce access. When removing a
feature from a distribution, review its callers, stored data, authorization checks, and manifest
together.

## Denial and recovery

- A location failure lets the task continue with its other context.
- Disabled notifications make the reminder tool return `SEND_ALERT_PERMISSION_DENIED`. Completion notifications leave the task's final state intact.
- Protected pages, closed tabs, and failed CDP attachment return tool errors. Select an authorized target before retrying.
- Chrome controls screen selection. Canceling its picker ends the recording attempt.
- A failed download or file open leaves the artifact in the Session so the user can try again.
- Storage exhaustion returns a persistence failure; report a successful save after the write commits.

## Data flow

Requests to the selected model provider contain user input and any page or file content that tools
read and add to the task context, possibly after compaction. Read location, history, and bookmarks
only for the feature that needs them. Skill network access and MCP connections follow user
configuration; the local MCP HTTP endpoint and extension polling each require pairing credentials.

Diagnostic traces stay local. Lifecycle observers receive frozen, redacted identity and phase
metadata. Users configure model endpoints, Skill sources, and MCP connections explicitly.

For permission semantics, see the [Chrome permission
list](https://developer.chrome.com/docs/extensions/reference/permissions-list) and [Tabs
API](https://developer.chrome.com/docs/extensions/reference/api/tabs). When changing the manifest,
review this table, failure paths, and packaged Chrome tests together. Moving a feature to on-demand
permissions requires request, denial, revocation, and recovery flows.
