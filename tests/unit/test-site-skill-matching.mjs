import assert from "node:assert/strict";
import { matchSiteSkillsForUrls } from "../../src/shared/skills/skill-utils.js";

const skills = [
  {
    name: "taobao-order",
    description: "订单页操作经验",
    scope: "site",
    domains: ["taobao.com"],
    urlPatterns: ["/order/"],
  },
  {
    name: "taobao-common",
    description: "淘宝通用经验",
    scope: "site",
    domains: ["taobao.com"],
  },
  {
    name: "xiaohongshu-note",
    description: "小红书笔记经验",
    scope: "site",
    domains: ["xiaohongshu.com"],
    urlPatterns: ["/explore/"],
  },
  {
    name: "disabled-skill",
    description: "禁用 skill 不应出现",
    scope: "site",
    status: "disabled",
    domains: ["taobao.com"],
  },
  {
    name: "resident-taobao",
    description: "常驻说明不应参与站点匹配",
    scope: "resident",
    domains: ["taobao.com"],
  },
];

const matched = matchSiteSkillsForUrls(skills, [
  "https://buyer.taobao.com/order/detail?id=1",
  "https://www.xiaohongshu.com/explore/abc",
  "https://buyer.taobao.com/order/detail?id=1",
], { limit: 5 });

assert.deepEqual(matched.map(item => item.name), [
  "xiaohongshu-note",
  "taobao-order",
  "taobao-common",
]);
assert.equal(matched.find(item => item.name === "taobao-order").matchedUrls.length, 1);
assert.ok(!matched.some(item => item.name === "disabled-skill"));
assert.ok(!matched.some(item => item.name === "resident-taobao"));

console.log("site skill multi-url matching ok");
