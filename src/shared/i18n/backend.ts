import { createTranslator } from "./index.js";
import { backendMessages } from "./backend-messages.js";

export type BackendMessageKey = keyof typeof backendMessages.messages;
export const t = createTranslator(backendMessages);
