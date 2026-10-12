import assert from "node:assert/strict";
import test from "node:test";

import {
  filterSkillsForList,
  normalizeSkillListFilter,
  SKILL_LIST_FILTER_BUILTIN,
  SKILL_LIST_FILTER_MINE,
} from "../../src/capabilities/skills/workspace/skill-list-filter.js";

const skills = [
  { name: "builtin-global", description: "系统全局能力", scope: "global", builtin: true },
  { name: "builtin-site", description: "系统站点能力", scope: "site", readOnly: true },
  { name: "my-resident", description: "个人偏好", scope: "resident" },
  { name: "my-global", description: "视频整理", scope: "global" },
  { name: "my-site", description: "站点采集", scope: "site", domains: ["example.com"] },
];

test("mine is the default view and excludes every builtin skill", () => {
  assert.equal(normalizeSkillListFilter("unknown"), SKILL_LIST_FILTER_MINE);
  assert.deepEqual(
    filterSkillsForList(skills).map(skill => skill.name),
    ["my-resident", "my-global", "my-site"],
  );
});

test("builtin is a separate source view regardless of scope", () => {
  assert.equal(normalizeSkillListFilter("builtin"), SKILL_LIST_FILTER_BUILTIN);
  assert.deepEqual(
    filterSkillsForList(skills, { filter: SKILL_LIST_FILTER_BUILTIN }).map(skill => skill.name),
    ["builtin-global", "builtin-site"],
  );
});

test("search stays within the selected source view", () => {
  assert.deepEqual(
    filterSkillsForList(skills, { filter: SKILL_LIST_FILTER_MINE, query: "站点" }).map(skill => skill.name),
    ["my-site"],
  );
  assert.deepEqual(
    filterSkillsForList(skills, { filter: SKILL_LIST_FILTER_BUILTIN, query: "站点" }).map(skill => skill.name),
    ["builtin-site"],
  );
});

test("filtering preserves display order and does not mutate the source", () => {
  const original = skills.map(skill => skill.name);
  filterSkillsForList(skills, { filter: SKILL_LIST_FILTER_MINE });
  assert.deepEqual(skills.map(skill => skill.name), original);
});
