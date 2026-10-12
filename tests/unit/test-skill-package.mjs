import assert from "node:assert/strict";
import {
  createZip,
  exportSkillsZip,
  importSkillsZip,
  importSkillsFromFileList,
  parseSkillMarkdownFrontmatter,
  skillFromSkillMarkdown,
  skillToSkillMarkdown,
} from "../../src/shared/skills/skill-package.js";
import {
  decodeSkillResourceBytes,
  encodeSkillResourceBytes,
  getSkillDisplayName,
  normalizeModernSkill,
  toAgentSkillName,
} from "../../src/shared/skills/skill-utils.js";

const travelSkillMarkdown = `---
name: travel-booking
description: >
  当用户需要在12306官网、携程、去哪儿、飞猪、各大航空公司官网等交通出行网站
  查询或预订火车票、机票、高铁票时，使用此skill。触发场景包括：查询车次/航班、
  预订车票/机票、筛选时刻、查看余票、扫码登录、下单支付等任何涉及交通出行
  网站的操作。
license: 'MIT'
metadata:
  scope: site
  status: active
  domains:
    - "12306.cn"
    - ctrip.com # inline comment
  urlPatterns: ["/train", "regex:^https://"]
  nested:
    enabled: true
    threshold: 3
  examples:
    - title: 火车票
      path: references/train.md
---
# Travel booking

Use browser tools.
`;

const travel = skillFromSkillMarkdown(travelSkillMarkdown);
assert.equal(travel.name, "travel-booking");
assert.equal(
  travel.description,
  "当用户需要在12306官网、携程、去哪儿、飞猪、各大航空公司官网等交通出行网站 查询或预订火车票、机票、高铁票时，使用此skill。触发场景包括：查询车次/航班、 预订车票/机票、筛选时刻、查看余票、扫码登录、下单支付等任何涉及交通出行 网站的操作。",
);
assert.equal(travel.license, "MIT");
assert.equal(travel.scope, "site");
assert.equal(travel.status, "active");
assert.deepEqual(travel.domains, ["12306.cn", "ctrip.com"]);
assert.deepEqual(travel.urlPatterns, ["/train", "regex:^https://"]);
assert.deepEqual(travel.metadata.nested, { enabled: true, threshold: 3 });
assert.deepEqual(travel.metadata.examples, [{ title: "火车票", path: "references/train.md" }]);
assert.equal(travel.content.trim(), "# Travel booking\n\nUse browser tools.");

const literal = skillFromSkillMarkdown(`---
name: literal-description
description: |
  第一行
  第二行
---
body`);
assert.equal(literal.description, "第一行\n第二行");

const chineseNameSkill = skillFromSkillMarkdown(`---
name: B站视频搜索
description: 在B站搜索视频。
metadata:
  scope: site
  domains:
    - bilibili.com
---
# B站视频搜索

Use browser tools.
`);
assert.equal(chineseNameSkill.name, toAgentSkillName("B站视频搜索"));
assert.equal(getSkillDisplayName(chineseNameSkill), "B站视频搜索");
assert.equal(chineseNameSkill.scope, "site");
assert.deepEqual(chineseNameSkill.domains, ["bilibili.com"]);

const exportedChineseNameSkill = skillToSkillMarkdown(chineseNameSkill);
assert.match(exportedChineseNameSkill, /metadata:\n  displayName: "B站视频搜索"\n  scope: "site"/);
assert.doesNotMatch(exportedChineseNameSkill, /qingzhou:\n\s+displayName/);

assert.throws(
  () => parseSkillMarkdownFrontmatter(`---
name: missing-end
`),
  /缺少结束标记/,
);
assert.throws(
  () => parseSkillMarkdownFrontmatter(`---
- not
- an
- object
---
body`),
  /YAML frontmatter 必须是对象/,
);
assert.throws(
  () => parseSkillMarkdownFrontmatter(`---
name: "unterminated
---
body`),
  /YAMLException|unexpected|incomplete|bad indentation/i,
);
// Empty merge sources must consume the parser budget too (GHSA-2883-xcg3-v3hh).
assert.throws(
  () => parseSkillMarkdownFrontmatter(`---\nsources: &sources [${Array(100).fill("{}").join(",")}]
targets:\n${"  - <<: *sources\n".repeat(101)}---\nbody`),
  /merge keys exceeded maxTotalMergeKeys/,
);
assert.equal(
  skillFromSkillMarkdown("---\nname: after-rejected-import\ndescription: Still usable\n---\nbody").name,
  "after-rejected-import",
  "rejecting excessive YAML merge work must not affect the next import",
);
assert.throws(
  () => skillFromSkillMarkdown(`---
name: invalid-scope
description: bad
metadata:
  scope: sometimes
  status: active
  domains: []
  urlPatterns: []
  excludePatterns: []
---
body`),
  /metadata\.scope 只能是 resident、global 或 site/,
);
assert.throws(
  () => skillFromSkillMarkdown(`---
name: invalid-metadata
description: bad
metadata: []
---
body`),
  /metadata 必须是对象/,
);
assert.throws(
  () => skillFromSkillMarkdown(`---
name: invalid-domains
description: bad
metadata:
  scope: site
  status: active
  domains: bilibili.com
  urlPatterns: []
  excludePatterns: []
---
body`),
  /metadata\.domains 必须是字符串数组/,
);

const imported = await importSkillsFromFileList([
  fakeFile("travel-booking/SKILL.md", travelSkillMarkdown),
  fakeFile("travel-booking/references/train.md", "# Train\n\nCheck station names."),
  fakeFile("travel-booking/references/airlines.md", "# Airlines\n\nCheck official websites."),
  fakeFile("travel-booking/scripts/check-page.js", "return { ok: true };"),
]);
assert.equal(imported.length, 1);
assert.equal(imported[0].name, "travel-booking");
assert.deepEqual(imported[0].resources.map(item => item.path), [
  "references/airlines.md",
  "references/train.md",
  "scripts/check-page.js",
]);
assert.equal(imported[0].resources[1].type, "markdown");
assert.match(imported[0].resources[1].content, /Check station names/);
assert.equal(imported[0].resources.some(item => item.path === "plugin.json"), false);

const directoryDocumentBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7]);
const [directoryDocumentSkill] = await importSkillsFromFileList([
  fakeFile("directory-documents/SKILL.md", `---\nname: directory-documents\ndescription: Directory documents.\n---\n# Directory documents`),
  fakeBinaryFile("directory-documents/references/template.docx", directoryDocumentBytes),
]);
const [directoryDocument] = directoryDocumentSkill.resources;
assert.equal(directoryDocument.encoding, "base64");
assert.equal(directoryDocument.size, directoryDocumentBytes.byteLength);
assert.deepEqual(decodeSkillResourceBytes(directoryDocument), directoryDocumentBytes);

const repositoryZip = await createZip([
  {
    path: "content-main/skills/repository-skill/SKILL.md",
    content: `---\nname: repository-skill\ndescription: Imported from a repository.\n---\n# Repository skill`,
  },
  {
    path: "content-main/skills/repository-skill/references/guide.md",
    content: "# Guide",
  },
  {
    path: "content-main/skills/repository-skill/../escape.md",
    content: "must not be imported",
  },
  {
    path: "content-main/docs/unrelated-large.md",
    content: "x".repeat(2 * 1024 * 1024 + 1),
  },
]);
const repositorySkills = await importSkillsZip(await repositoryZip.arrayBuffer());
assert.equal(repositorySkills.length, 1);
assert.equal(repositorySkills[0].name, "repository-skill");
assert.deepEqual(repositorySkills[0].resources.map(item => item.path), ["references/guide.md"]);

const binaryFixtures = [
  { path: "references/template.docx", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]) },
  { path: "references/data.xlsx", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 2]) },
  { path: "references/manual.pdf", bytes: new TextEncoder().encode("%PDF-1.7 fixture") },
].sort((left, right) => left.path.localeCompare(right.path));
const binarySkillZip = await exportSkillsZip([normalizeModernSkill({
  name: "binary-resources",
  description: "Binary document resource fixture.",
  content: "# Binary resources",
  resources: binaryFixtures.map(item => ({
    path: item.path,
    type: "asset",
    encoding: "base64",
    size: item.bytes.byteLength,
    content: encodeSkillResourceBytes(item.bytes),
  })),
})]);
const [binarySkill] = await importSkillsZip(await binarySkillZip.arrayBuffer());
assert.deepEqual(binarySkill.resources.map(resource => resource.path), binaryFixtures.map(item => item.path));
for (const [index, resource] of binarySkill.resources.entries()) {
  assert.equal(resource.encoding, "base64");
  assert.equal(resource.size, binaryFixtures[index].bytes.byteLength);
  assert.deepEqual(decodeSkillResourceBytes(resource), binaryFixtures[index].bytes);
}

const scopedRepositoryZip = await createZip([
  {
    path: "OpenCLI-main/skills/browser/SKILL.md",
    content: `---\nname: browser-skill\ndescription: Browser directory Skill.\n---\n# Browser`,
  },
  {
    path: "OpenCLI-main/skills/browser/references/guide.md",
    content: "# Browser guide",
  },
  {
    path: "OpenCLI-main/skills/search/SKILL.md",
    content: `---\nname: search-skill\ndescription: Search directory Skill.\n---\n# Search`,
  },
  {
    path: "OpenCLI-main/examples/unrelated/SKILL.md",
    content: `---\nname: unrelated-skill\ndescription: Must stay outside the selection.\n---\n# Unrelated`,
  },
]);
const scopedSkills = await importSkillsZip(await scopedRepositoryZip.arrayBuffer(), { subpath: "skills" });
assert.deepEqual(scopedSkills.map(skill => skill.name), ["browser-skill", "search-skill"]);
assert.deepEqual(scopedSkills[0].resources.map(item => item.path), ["references/guide.md"]);
const nestedScopedSkills = await importSkillsZip(await scopedRepositoryZip.arrayBuffer(), { subpath: "skills/search" });
assert.deepEqual(nestedScopedSkills.map(skill => skill.name), ["search-skill"]);
await assert.rejects(
  importSkillsZip(await scopedRepositoryZip.arrayBuffer(), { subpath: "../skills" }),
  /仓库目录路径无效/,
);

const oversizedResourceZip = await createZip([
  {
    path: "oversized/SKILL.md",
    content: `---\nname: oversized\ndescription: Oversized resource fixture.\n---\n# Oversized`,
  },
  {
    path: "oversized/references/large.md",
    content: "x".repeat(2 * 1024 * 1024 + 1),
  },
]);
await assert.rejects(
  importSkillsZip(await oversizedResourceZip.arrayBuffer()),
  /文件过大/,
);

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return {
          [key]: {
            "travel-booking": normalizeModernSkill(imported[0]),
          },
        };
      },
      async set() {},
    },
  },
};
const { loadSkillResource } = await import("../../src/background/skills/runtime.js");
const loadedResource = await loadSkillResource("travel booking", "/references/train.md");
assert.equal(loadedResource.skill.name, "travel-booking");
assert.equal(loadedResource.path, "references/train.md");
assert.match(loadedResource.resource.content, /Check station names/);
const loadedSkillMarkdown = await loadSkillResource("travel booking", "skill.md");
assert.equal(loadedSkillMarkdown.skill.name, "travel-booking");
assert.equal(loadedSkillMarkdown.path, "skill.md");
assert.equal(loadedSkillMarkdown.resource, null);
assert.equal(await loadSkillResource("missing", "references/train.md"), null);

function fakeFile(path, text) {
  return {
    name: path.split("/").pop(),
    path,
    webkitRelativePath: path,
    size: new TextEncoder().encode(text).length,
    text: async () => text,
  };
}

function fakeBinaryFile(path, bytes) {
  return {
    name: path.split("/").pop(),
    path,
    webkitRelativePath: path,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

console.log("skill package yaml/resource tests passed");
