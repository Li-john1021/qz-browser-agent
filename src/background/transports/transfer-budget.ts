import { MESSAGE_TRANSFER_BYTES } from "../../shared/transport/message-codec.js";
import { createReceiveBudget, createTransferBudget } from "../../shared/transport/transfer-budget.js";

/** Snapshot admission and receive allocations have independent context-wide bounds. */
export const backgroundTransferBudget = createTransferBudget(2 * MESSAGE_TRANSFER_BYTES);
export const backgroundReceiveBudget = createReceiveBudget();
