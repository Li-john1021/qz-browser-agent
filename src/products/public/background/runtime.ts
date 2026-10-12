import type { ProductRuntime, ProductRuntimeHost } from "../../../background/product/runtime-contract.js";

export function createProductRuntime(host: ProductRuntimeHost): ProductRuntime {
  return {
    llm: host.llm, observers: [], onModelChange() {}, removeSession() {},
    async dispatch() { return null; }, async start() {},
  };
}
