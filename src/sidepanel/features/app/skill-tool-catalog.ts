import { setSkillToolUiCatalog } from "../../tools/skill-tool-ui-registry.js";

interface CatalogOptions {
  signal: AbortSignal;
  request(type: string, payload: Record<string, unknown>, timeout: number): Promise<Record<string, unknown>>;
  getCurrentSessionId(): string | null;
  refreshReferences(): void;
}

/** Skill renderer identities belong to the workspace, even without the Skills page. */
export function createSkillToolCatalog(options: CatalogOptions) {
  let plugins: unknown[] = [];
  let revision = 0;

  function apply(value: unknown, reset = false) {
    plugins = Array.isArray(value) ? value : reset ? [] : plugins;
    setSkillToolUiCatalog({ plugins });
    options.refreshReferences();
  }

  async function load() {
    options.signal.throwIfAborted();
    const requestRevision = ++revision;
    const result = await options.request("list_plugin_contributions", { sessionId: options.getCurrentSessionId() }, 5000);
    options.signal.throwIfAborted();
    // A late reconnect reply must not replace a newer accepted registry snapshot.
    if (requestRevision === revision) apply(result.plugins, true);
  }

  function refresh() {
    void load().catch(error => {
      if (!options.signal.aborted) console.warn("[轻舟] load skill tool catalog failed:", error instanceof Error ? error.message : error);
    });
  }

  function handleUpdate(event: Record<string, unknown>) {
    if (options.signal.aborted) return;
    revision += 1;
    const incoming = event.snapshot;
    if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) apply((incoming as Record<string, unknown>).plugins);
    refresh();
  }

  return { load, refresh, handleUpdate };
}
