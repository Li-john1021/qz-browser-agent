import { ensureOffscreenDocument, type OffscreenOptions } from "./offscreen-document.js";

export function createOffscreenKeepalive({
  offscreen = globalThis.chrome?.offscreen,
  runtime = globalThis.chrome?.runtime,
  clients = (globalThis as { clients?: OffscreenOptions["clients"] }).clients,
  documentPath = "offscreen.html",
}: OffscreenOptions = {}) {
  async function ensure() {
    if (!offscreen?.createDocument) return false;
    await ensureOffscreenDocument({ offscreen, runtime, clients, documentPath });
    return true;
  }
  return Object.freeze({ ensure });
}
