import assert from "node:assert/strict";
import test from "node:test";

import { createGitSkillSourceRepository } from "../../src/background/skills/git-skill-source-repository.js";
import {
  getGitSkillOrigin,
  gitRepositoryBrowseUrl,
  gitRepositoryIdentity,
  gitRepositoryLocator,
  gitRepositoryProvider,
  gitSkillBelongsToSource,
  gitSkillSourceId,
  normalizeGitRepositoryUrl,
  normalizeGitSkillSources,
  sanitizeGitArchiveUrl,
  withGitSkillOrigin,
  withoutGitSkillOrigin,
} from "../../src/shared/skills/git-skill-sources.js";

const EXAMPLE_REPOSITORY = "https://gitlab.example.com/example-team/browser-skills";
const GITHUB_REPOSITORY = "https://github.com/openai/codex";
const DIGEST = "a".repeat(64);

test("repository URLs normalize page, clone, tree, and SCP forms to one identity", () => {
  const expected = EXAMPLE_REPOSITORY;
  assert.equal(normalizeGitRepositoryUrl(expected), expected);
  assert.equal(normalizeGitRepositoryUrl(`${expected}.git`), expected);
  assert.equal(normalizeGitRepositoryUrl(`${expected}/-/tree/main?spm=test#readme`), expected);
  assert.equal(normalizeGitRepositoryUrl(`${expected}/tree/main/skills/context7-mcp`), expected);
  assert.equal(normalizeGitRepositoryUrl(`${expected}/blob/main/README.md`), expected);
  assert.equal(normalizeGitRepositoryUrl("git@gitlab.example.com:example-team/browser-skills.git"), expected);
  assert.equal(normalizeGitRepositoryUrl("https://gitlab.example.com/example-team/browser-skills.git"), expected);
  assert.equal(normalizeGitRepositoryUrl("https://user:secret@example.com/group/repo"), "");
  assert.equal(normalizeGitRepositoryUrl("https://gitlab.example.com/api/v3/projects/3705939/repository/archive.zip"), "");
  assert.deepEqual(gitRepositoryIdentity(expected), {
    repositoryUrl: expected,
    host: "gitlab.example.com",
    namespace: "example-team",
    name: "browser-skills",
    label: "browser-skills",
  });
  assert.equal(gitSkillSourceId(expected), gitSkillSourceId(`${expected}.git`));
  assert.equal(gitRepositoryProvider(expected), "gitlab");
});

test("GitHub page, clone, and tree URLs normalize to one supported identity", () => {
  assert.equal(normalizeGitRepositoryUrl(GITHUB_REPOSITORY), GITHUB_REPOSITORY);
  assert.equal(normalizeGitRepositoryUrl(`${GITHUB_REPOSITORY}.git`), GITHUB_REPOSITORY);
  assert.equal(normalizeGitRepositoryUrl(`${GITHUB_REPOSITORY}/tree/main/codex-rs`), GITHUB_REPOSITORY);
  assert.equal(normalizeGitRepositoryUrl(`${GITHUB_REPOSITORY}/blob/main/README.md`), GITHUB_REPOSITORY);
  assert.equal(normalizeGitRepositoryUrl("git@github.com:openai/codex.git"), GITHUB_REPOSITORY);
  assert.equal(gitRepositoryProvider(GITHUB_REPOSITORY), "github");
  assert.equal(gitRepositoryProvider("https://example.com/group/repo"), "");
  assert.deepEqual(gitRepositoryIdentity(`${GITHUB_REPOSITORY}/tree/main/codex-rs`), {
    repositoryUrl: GITHUB_REPOSITORY,
    host: "github.com",
    namespace: "openai",
    name: "codex",
    label: "codex",
  });
  assert.deepEqual(gitRepositoryLocator("https://github.com/jackwener/OpenCLI/tree/main/skills"), {
    repositoryUrl: "https://github.com/jackwener/OpenCLI",
    browseUrl: "https://github.com/jackwener/OpenCLI/tree/main/skills",
    provider: "github",
    ref: "main",
    subpath: "skills",
  });
  assert.equal(
    gitRepositoryBrowseUrl("https://github.com/jackwener/OpenCLI", { ref: "main", subpath: "skills/browser tools" }),
    "https://github.com/jackwener/OpenCLI/tree/main/skills/browser%20tools",
  );
  assert.notEqual(
    gitSkillSourceId(GITHUB_REPOSITORY),
    gitSkillSourceId(GITHUB_REPOSITORY, { ref: "main", subpath: "skills" }),
  );
});

test("archive URLs retain only non-secret update parameters on the repository origin", () => {
  assert.equal(
    sanitizeGitArchiveUrl(
      "https://gitlab.example.com/api/v3/projects/3705939/repository/archive.zip?spm=tracking&sha=main&path=&private_token=secret",
      EXAMPLE_REPOSITORY,
    ),
    "https://gitlab.example.com/api/v3/projects/3705939/repository/archive.zip?path=&sha=main",
  );
  assert.equal(sanitizeGitArchiveUrl("https://evil.example/archive.zip?sha=main", EXAMPLE_REPOSITORY), "");
});

test("Git origins round-trip without disturbing unrelated Qingzhou metadata", () => {
  const source = {
    id: gitSkillSourceId(EXAMPLE_REPOSITORY),
    repositoryUrl: EXAMPLE_REPOSITORY,
    ref: "main",
    subpath: "skills/content-supply",
    branch: "main",
    revision: "b".repeat(40),
    archiveDigest: DIGEST,
    importedAt: "2026-07-12 23:30:00",
  };
  const skill = withGitSkillOrigin({
    name: "content-supply",
    description: "test",
    content: "# Test",
    metadata: { qingzhou: { display: { renderer: "markdown" } } },
  }, source);
  assert.equal(gitSkillBelongsToSource(skill, source.id), true);
  assert.deepEqual(getGitSkillOrigin(skill), {
    type: "git",
    sourceId: source.id,
    repositoryUrl: EXAMPLE_REPOSITORY,
    ref: "main",
    subpath: "skills/content-supply",
    branch: "main",
    revision: "b".repeat(40),
    archiveDigest: DIGEST,
    skillName: "content-supply",
    importedAt: "2026-07-12 23:30:00",
  });
  const detached = withoutGitSkillOrigin(skill, source.id);
  assert.equal(getGitSkillOrigin(detached), null);
  assert.deepEqual(detached.metadata.qingzhou.display, { renderer: "markdown" });
});

test("source state normalization drops malformed records and secret archive parameters", () => {
  const id = gitSkillSourceId(EXAMPLE_REPOSITORY);
  const sources = normalizeGitSkillSources({
    [id]: {
      id,
      repositoryUrl: EXAMPLE_REPOSITORY,
      branch: "main",
      archiveUrl: `https://gitlab.example.com/api/v3/projects/3705939/repository/archive.zip?sha=main&token=secret`,
      archiveDigest: DIGEST,
      skillNames: ["one", "one", "two"],
      skillDigests: { one: DIGEST, two: "invalid" },
    },
    broken: { repositoryUrl: "not a URL" },
  });
  assert.deepEqual(Object.keys(sources), [id]);
  assert.deepEqual(sources[id].skillNames, ["one", "two"]);
  assert.deepEqual(sources[id].skillDigests, { one: DIGEST });
  assert.doesNotMatch(sources[id].archiveUrl, /token|secret/u);

  const [treeSource] = Object.values(normalizeGitSkillSources({
    tree: {
      id: "tree",
      repositoryUrl: `${EXAMPLE_REPOSITORY}/tree/main/skills`,
      skillNames: [],
    },
  }));
  assert.equal(treeSource.repositoryUrl, EXAMPLE_REPOSITORY);
  assert.equal(treeSource.name, "browser-skills");
  assert.equal(treeSource.namespace, "example-team");
  assert.equal(treeSource.ref, "main");
  assert.equal(treeSource.subpath, "skills");
});

test("repository commits skill and source records atomically", async () => {
  const state = {};
  const writes = [];
  const storage = {
    async get(keys) {
      return Object.fromEntries(keys.map(key => [key, state[key]]));
    },
    async set(values) {
      writes.push(values);
      Object.assign(state, values);
    },
  };
  const repository = createGitSkillSourceRepository({ storage });
  const id = gitSkillSourceId(EXAMPLE_REPOSITORY);
  await repository.commitSnapshot({
    expected: await repository.readSnapshot(),
    skills: { one: { name: "one" } },
    sources: { [id]: { id, repositoryUrl: EXAMPLE_REPOSITORY, archiveDigest: DIGEST, skillNames: ["one"] } },
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]).sort(), ["_gitSkillSources", "_skills"]);
  assert.equal((await repository.getSource(id)).repositoryUrl, EXAMPLE_REPOSITORY);
  assert.deepEqual((await repository.readSnapshot()).skills, { one: { name: "one" } });
});
