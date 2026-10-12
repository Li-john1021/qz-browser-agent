import type { ToolContext, ToolErrorConstructor } from '../../sdk/background.js';
export interface MappedKey { key: string; code: string; keyCode: number; text: string; modifiers: number }
interface KeyboardHost {
  sendCdp(tabId: number, method: string, params: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  ToolExecutionError: ToolErrorConstructor;
}
/** Normalizes and dispatches physical CDP keyboard input for page tools. */
export function createCdpKeyboard({ sendCdp, ToolExecutionError }: KeyboardHost) {
  const normalize = (shortcut: string) => normalizeShortcut(shortcut, ToolExecutionError);

  async function press(tabId: number, shortcut: string | MappedKey, context: ToolContext = {}) {
    const mapped = typeof shortcut === "string" ? normalize(shortcut) : shortcut;
    const commands = editingCommands(mapped, context);
    const params = {
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode,
      modifiers: mapped.modifiers,
    };
    // A rejected response may still have delivered keyDown to the page.
    let pressed = true;
    try {
      await sendCdp(tabId, "Input.dispatchKeyEvent", {
        type: mapped.text ? "keyDown" : "rawKeyDown",
        ...params,
        text: mapped.text,
        unmodifiedText: mapped.text,
        ...(commands.length ? { commands } : {}),
      }, context);
      await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params }, context);
      pressed = false;
    } finally {
      if (pressed) {
        try { await sendCdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params }, context); } catch (_error) {}
      }
    }
    return mapped;
  }

  return Object.freeze({ normalize, press });
}

export function primaryModifierForContext(context: ToolContext = {}) {
  const os = String(context?.runProfile?.platform?.os || "").trim().toLowerCase();
  if (os === "mac") return "Meta";
  if (os) return "Control";
  const platform = typeof navigator === "undefined"
    ? ""
    : String((navigator as typeof navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent || "");
  return /mac/i.test(platform) ? "Meta" : "Control";
}

function normalizeShortcut(shortcut: string, ToolExecutionError: ToolErrorConstructor): MappedKey {
  const value = String(shortcut || "").trim();
  const parts = value.length === 1 ? [value] : value.split("+").map(part => part.trim()).filter(Boolean);
  const rawKey = parts.pop() || "";
  let modifiers = 0;
  for (const modifier of parts) {
    const name = modifier.toLowerCase();
    if (["alt", "option"].includes(name)) modifiers |= 1;
    else if (["control", "ctrl"].includes(name)) modifiers |= 2;
    else if (["meta", "command", "cmd"].includes(name)) modifiers |= 4;
    else if (name === "shift") modifiers |= 8;
    else throw new ToolExecutionError("INVALID_ARGUMENTS", `Unsupported key modifier: ${modifier}`, { key: shortcut });
  }
  const named: Record<string, readonly [string, string, number, string]> = {
    Enter: ["Enter", "Enter", 13, "\r"], Escape: ["Escape", "Escape", 27, ""], Esc: ["Escape", "Escape", 27, ""],
    Tab: ["Tab", "Tab", 9, ""], Backspace: ["Backspace", "Backspace", 8, ""], Delete: ["Delete", "Delete", 46, ""],
    Space: [" ", "Space", 32, " "], ArrowUp: ["ArrowUp", "ArrowUp", 38, ""], ArrowDown: ["ArrowDown", "ArrowDown", 40, ""],
    ArrowLeft: ["ArrowLeft", "ArrowLeft", 37, ""], ArrowRight: ["ArrowRight", "ArrowRight", 39, ""],
  };
  const tuple = named[rawKey];
  const upper = rawKey.toUpperCase();
  const mapped = tuple
    ? { key: tuple[0], code: tuple[1], keyCode: tuple[2], text: tuple[3] }
    : {
        key: rawKey,
        code: rawKey.length === 1 && /^[A-Z]$/.test(upper) ? `Key${upper}` : rawKey,
        keyCode: rawKey.length === 1 ? upper.charCodeAt(0) : 0,
        text: rawKey.length === 1 ? rawKey : "",
      };
  return { ...mapped, modifiers, text: modifiers ? "" : mapped.text };
}

function editingCommands(mapped: MappedKey, context: ToolContext) {
  const primaryModifierMask = primaryModifierForContext(context) === "Meta" ? 4 : 2;
  if (Number(mapped?.modifiers) !== primaryModifierMask) return [];
  const commandByKey: Record<string, string> = {
    a: "selectAll",
    c: "copy",
    v: "paste",
    x: "cut",
  };
  const command = commandByKey[String(mapped?.key || "").toLowerCase()];
  return command ? [command] : [];
}
