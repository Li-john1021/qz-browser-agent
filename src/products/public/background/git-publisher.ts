import { t } from "../shared/i18n.js";
import { GitSkillPublishError } from '../../../background/skills/git-skill-publish-files.js';
/** Publishing requires an installed platform adapter; reading Git sources remains available. */
export function createGitSkillPublisherService(_options: unknown = {}) {
  return Object.freeze({
    async inspect(_input: unknown = {}, _runtime: unknown = {}) { return { available: false, reason: 'git_publish_unavailable' }; },
    async publish(_input: unknown = {}, _runtime: unknown = {}): Promise<never> {
      throw new GitSkillPublishError('GIT_PUBLISH_UNAVAILABLE', t("thisProductHasNoGitPublishingAdapterExportThe"));
    },
  });
}
