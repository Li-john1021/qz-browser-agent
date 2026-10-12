from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any

from .acceptance import parse_tool_args, safe_int, unrecovered_tool_calls


BASE_REQUIRED_FAMILIES = frozenset({
    "arrival",
    "collect",
    "operate",
    "process",
    "artifact",
    "document",
    "mcp",
    "confirm",
})


TOOL_TIMELINE_FAMILY = {
    "list_tabs": "arrival",
    "get_working_tab": "arrival",
    "open_tab": "arrival",
    "close_tab": "arrival",
    "use_tab": "arrival",
    "navigate": "arrival",
    "group_tabs": "arrival",
    "wait_for_navigation": "arrival",
    "manage_sessions": "process",
    "manage_goal": "process",
    "manage_settings": "settings",
    "manage_guardrails": "settings",
    "data_store": "process",
    "manage_bookmarks": "collect",
    "browse_history": "collect",
    "read_article": "collect",
    "read_dom": "collect",
    "get_ax_tree": "collect",
    "select_element": "operate",
    "find_elements": "operate",
    "inspect_element": "operate",
    "act_on_element": "operate",
    "click_element": "operate",
    "fill_input": "operate",
    "scroll_page": "operate",
    "highlight_elements": "operate",
    "wait_for_element": "operate",
    "screenshot": "collect",
    "list_images": "collect",
    "collect_images": "artifact",
    "read_image_asset": "collect",
    "read_image": "collect",
    "run_script": "process",
    "run_skill_script": "other",
    "inject_css": "process",
    "modify_dom": "process",
    "save_file": "artifact",
    "list_downloads": "artifact",
    "download_url": "artifact",
    "document_fetch": "document",
    "document_parse": "document",
    "document_read_chunk": "document",
    "document_create": "artifact",
    "document_download": "artifact",
    "document_list_artifacts": "artifact",
    "qingzhou_documents__document_fetch": "document",
    "qingzhou_documents__document_parse": "document",
    "qingzhou_documents__document_read_chunk": "document",
    "qingzhou_documents__document_create": "artifact",
    "qingzhou_documents__document_download": "artifact",
    "qingzhou_documents__document_list_artifacts": "artifact",
    "network_watch": "process",
    "network_recent": "process",
    "network_body": "process",
    "read_console_messages": "process",
    "wait_for_response": "process",
    "wait_for_network_idle": "process",
    "wait_for_user": "confirm",
    "ask_user": "confirm",
    "wait": "confirm",
    "send_alert": "alert",
    "mcp_inspect_server": "mcp",
    "mcp_list_tools": "mcp",
    "mcp_search_tools": "mcp",
    "mcp_call_tool": "mcp",
    "qingzhou_mcp__mcp_inspect_server": "mcp",
    "qingzhou_mcp__mcp_list_tools": "mcp",
    "qingzhou_mcp__mcp_search_tools": "mcp",
    "qingzhou_mcp__mcp_call_tool": "mcp",
    "ask_llm": "process",
    "load_skill": "process",
    "load_skill_resource": "process",
    "create_skill": "process",
    "edit_skill_resource": "process",
    "update_skill": "process",
    "delete_skill": "process",
    "manage_skill": "process",
}


def summarize_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    transcript = snapshot.get("transcript") or []
    tools = [item for item in transcript if item.get("type") == "tool"]
    failed = [item for item in tools if item.get("isError") or str(item.get("phase") or "").lower() in {"error", "failed"}]
    unrecovered = unrecovered_tool_calls(transcript)
    names = Counter(str(item.get("name") or "") for item in tools)
    families = Counter(
        str(item.get("familyId") or "").strip() or timeline_family_for_tool(str(item.get("name") or ""))
        for item in tools
    )
    last_assistant = next((
        str(item.get("content") or "").strip()
        for item in reversed(transcript)
        if item.get("type") == "assistant" and str(item.get("content") or "").strip()
    ), "")
    return {
        "transcriptTotal": len(transcript),
        "toolCallCount": len(tools),
        "failedToolCallCount": len(failed),
        "recoveredToolCallCount": max(0, len(failed) - len(unrecovered)),
        "unrecoveredToolCallCount": len(unrecovered),
        "toolCounts": dict(sorted(names.items())),
        "familyCounts": dict(sorted(families.items())),
        "failedTools": [
            {
                "name": item.get("name"),
                "phase": item.get("phase"),
                "error": summarize_error(item),
            }
            for item in failed
        ],
        "lastAssistantText": compact_report_value(last_assistant, max_chars=800) if last_assistant else "",
    }


def summarize_tool_sequence(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    sequence: list[dict[str, Any]] = []
    for item in snapshot.get("transcript") or []:
        if item.get("type") != "tool":
            continue
        sequence.append({
            "name": str(item.get("name") or ""),
            "args": compact_report_value(parse_tool_args(item)),
            "result": compact_report_value(item.get("result")),
            "phase": str(item.get("phase") or ""),
            "isError": bool(item.get("isError")),
        })
    return sequence


def compact_report_value(value: Any, max_chars: int = 1200) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    except Exception:
        text = str(value or "")
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"…[{len(text) - max_chars} chars omitted]"


def timeline_family_for_tool(name: str) -> str:
    key = str(name or "").strip()
    if key in TOOL_TIMELINE_FAMILY:
        return TOOL_TIMELINE_FAMILY[key]
    if re.match(r"^[a-z0-9_]+__[a-z0-9_]+$", key, flags=re.I):
        return "process"
    return "other"


def summarize_error(tool: dict[str, Any]) -> str:
    for key in ("error", "result", "content"):
        value = tool.get(key)
        if value:
            return str(value)[:300]
    return ""


def format_summary(results: list[dict[str, Any]]) -> str:
    lines = [
        "suite,case,iteration,status,duration_s,tool_calls,failed_calls,recovered_calls,unrecovered_calls,success,reason",
    ]
    for item in results:
        lines.append(
            ",".join([
                item["suite"],
                item["case"],
                str(item.get("iteration") or 1),
                str(item["status"]),
                str(item["durationSeconds"]),
                str(item["toolCallCount"]),
                str(item["failedToolCallCount"]),
                str(item["recoveredToolCallCount"]),
                str(item["unrecoveredToolCallCount"]),
                "yes" if item["success"] else "no",
                quote_csv(item.get("failureReason") or ""),
            ])
        )
    return "\n".join(lines)


def quote_csv(value: str) -> str:
    if not re.search(r'[,"\n]', value):
        return value
    return '"' + value.replace('"', '""') + '"'


def summarize_family_coverage(results: list[dict[str, Any]], *, require_base_families: bool) -> dict[str, Any]:
    covered = Counter()
    for item in results:
        covered.update(item.get("familyCounts") or {})
    covered_families = sorted(family for family, count in covered.items() if count > 0)
    missing = sorted(BASE_REQUIRED_FAMILIES - set(covered_families)) if require_base_families else []
    return {
        "requiredFamilies": sorted(BASE_REQUIRED_FAMILIES) if require_base_families else [],
        "coveredFamilies": covered_families,
        "missingFamilies": missing,
        "familyCounts": dict(sorted(covered.items())),
    }


def summarize_journey_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in results:
        for journey_id in item.get("journeys") or []:
            grouped.setdefault(str(journey_id), []).append(item)
    return {
        journey_id: {
            "success": all(bool(item.get("success")) for item in items),
            "passedCases": [case_result_label(item) for item in items if item.get("success")],
            "failedCases": [case_result_label(item) for item in items if not item.get("success")],
        }
        for journey_id, items in sorted(grouped.items())
    }


def case_result_label(item: dict[str, Any]) -> str:
    name = str(item.get("case") or "")
    iteration = safe_int(item.get("iteration")) or 1
    return f"{name}#{iteration}" if iteration > 1 else name
