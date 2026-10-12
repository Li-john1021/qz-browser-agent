import type { ContextCapability } from "#sdk/background/context";
import { taskNoteSource } from "./context-and-observer.js";

const context: ContextCapability = () => [taskNoteSource(async sessionId => `Example note for ${sessionId}`)];
export default context;
