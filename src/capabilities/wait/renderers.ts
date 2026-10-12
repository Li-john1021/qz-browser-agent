import { t } from "./i18n.js";
import type { RendererExtension } from "#sdk/sidepanel";
import { createProfileHelpers, resultProfile } from "#sdk/sidepanel/components";
import { createWaitProfiles } from "./browser-content.js";
import { createQuestionProfiles } from "./browser-operations.js";

const contribute: RendererExtension = host => {
  const helpers = createProfileHelpers(host);
  const waits = createWaitProfiles(helpers);
  const questions = createQuestionProfiles(helpers);
  const contribution = {
    renderers: [
      host.project("sendAlert", resultProfile((parent, tool, result) => waits.renderSendAlert(parent, tool.args, result)), { showRawData: false }),
      host.project("wait", resultProfile((parent, tool, result) => waits.renderWait(parent, tool.name, tool.args, result))),
      host.project("askUser", resultProfile((parent, tool, result) => questions.renderAskUser(parent, tool.args, result))),
      host.project("askLlm", resultProfile((parent, tool, result) => questions.renderAskLlm(parent, tool.args, result))),
    ],
    presentations: [{ id: "wait", timelineVisibility: "standalone" as const },
      ...["wait_for_user", "send_alert", "ask_user"].map(id => ({ id, timelineGroupTitle: () => ({ label: t("userConfirmation"), order: 0 }) })),
    ],
  };
  for (const definition of contribution.presentations) host.registerPresentation(definition);
  for (const renderer of contribution.renderers) host.registerRenderer(renderer);
};
export default contribute;
