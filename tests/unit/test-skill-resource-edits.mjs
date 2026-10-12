import assert from "node:assert/strict";

import {
  normalizeModernSkill,
  normalizeSkillResourcePath,
  skillMatchesName,
} from "../../src/shared/skills/skill-utils.js";
import {
  SKILL_MANIFEST_FORMAT,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/skills/skill-manifest.js";

const storage = {
  _skills: {
    "资源编辑": normalizeModernSkill({
      name: "资源编辑",
      description: "验证 skill resource edit 边界",
      content: "正文",
      scope: "global",
      resources: [
        {
          path: "plugin.json",
          type: "json",
          content: "{}",
        },
        {
          path: "scripts/demo.js",
          type: "script",
          content: [
            "async () => {",
            "  const answer = 1;",
            "  return { answer };",
            "}",
            "",
          ].join("\r\n"),
        },
        {
          path: "references/notes.md",
          type: "markdown",
          content: [
            "alpha sentinel line",
            "same token line",
            "middle",
            "same token line",
            "",
          ].join("\n"),
        },
        {
          path: "references/report.xlsx",
          type: "asset",
          content: "AAEC",
          encoding: "base64",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 3,
        },
      ],
    }),
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storage[key] };
        return { ...storage };
      },
      async set(value) {
        Object.assign(storage, value);
      },
    },
  },
};

const skills = await import("../../src/background/skills/runtime.js");

function storedSkill(name) {
  const skill = Object.values(storage._skills || {}).find(item => skillMatchesName(item, name));
  assert.ok(skill, `expected stored skill ${name}`);
  return skill;
}

assert.equal(normalizeSkillResourcePath("\\plugin.json"), "plugin.json");
assert.equal(normalizeSkillResourcePath("/references//demo.md"), "references/demo.md");
assert.equal(normalizeSkillResourcePath("scripts\\demo.js"), "scripts/demo.js");

const manifestUpdate = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    path: "/plugin.json",
    content: {
      format: SKILL_MANIFEST_FORMAT,
      schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
      id: "resource-edit-demo",
    },
  }],
});
assert.equal(manifestUpdate.updated, true);
assert.equal(manifestUpdate.changes[0].action, "upsert");
assert.deepEqual(
  JSON.parse(storedSkill("资源编辑").resources.find(resource => resource.path === "plugin.json").content),
  {
    format: SKILL_MANIFEST_FORMAT,
    schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION,
    id: "resource-edit-demo",
  },
);

const loadedManifest = await skills.loadSkillResource("资源编辑", "\\plugin.json");
assert.equal(loadedManifest.path, "plugin.json");
assert.equal(loadedManifest.resource.type, "json");

const loadedBinary = await skills.loadSkillResource("资源编辑", "references/report.xlsx");
assert.equal(loadedBinary.resource.encoding, "base64");
assert.equal(loadedBinary.resource.content, "AAEC");
await assert.rejects(
  () => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "replace",
      path: "references/report.xlsx",
      oldText: "AAEC",
      newText: "corrupted",
    }],
  }),
  err => err?.code === "SKILL_BINARY_RESOURCE_TEXT_EDIT_UNSUPPORTED"
    && err.details?.path === "references/report.xlsx",
);
assert.equal(
  (await skills.loadSkillResource("资源编辑", "references/report.xlsx")).resource.content,
  "AAEC",
);

const scriptUpdate = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "replace",
    path: "scripts/demo.js",
    oldText: "const answer = 1;\n  return { answer };",
    newText: "const answer = 2;\n  return { answer, ok: true };",
  }],
});
assert.equal(scriptUpdate.updated, true);
assert.equal(scriptUpdate.changes[0].lineEnding, "\r\n");
assert.equal(scriptUpdate.changes[0].firstChangedLine, 2);
assert.match(scriptUpdate.changes[0].patchPreview, /const answer = 1/);
const updatedScript = storedSkill("资源编辑").resources.find(resource => resource.path === "scripts/demo.js").content;
assert.match(updatedScript, /const answer = 2;\r\n  return \{ answer, ok: true \};/);
assert.match(await skills.loadSkillScript("资源编辑", "scripts\\demo.js"), /ok: true/);

const alreadyApplied = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "replace",
    path: "scripts/demo.js",
    oldText: "const answer = 1;\n  return { answer };",
    newText: "const answer = 2;\n  return { answer, ok: true };",
  }],
});
assert.equal(alreadyApplied.updated, false);
assert.equal(alreadyApplied.diagnostics[0].code, "SKILL_EDIT_ALREADY_APPLIED");
assert.equal(alreadyApplied.diagnostics[0].field, "resources");
assert.equal(alreadyApplied.diagnostics[0].path, "scripts/demo.js");

await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "set",
    path: "plugin.json",
    type: "json",
    content: [
      "{",
      `  \"format\": \"${SKILL_MANIFEST_FORMAT}\",`,
      `  \"schemaVersion\": ${SKILL_MANIFEST_SCHEMA_VERSION},`,
      "  \"id\": \"resource-edit-demo\",",
      "  \"tools\": [",
      "    {",
      "      \"name\": \"list_video_subtitle\",",
      "      \"title\": \"视频字幕\",",
      "      \"description\": \"字幕\",",
      "      \"script\": \"scripts/demo.js\"",
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n"),
  }],
});
const trimmedReplace = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "replace",
    path: "plugin.json",
    oldText: "\"name\": \"list_video_subtitle\",\n\"title\": \"视频字幕\",",
    newText: "\"name\": \"collect_all_author_works\",\n      \"title\": \"全量采集作者视频\",\n      \"script\": \"scripts/demo.js\"\n    },\n    {\n      \"name\": \"list_video_subtitle\",\n      \"title\": \"视频字幕\",",
  }],
});
assert.equal(trimmedReplace.updated, true);
assert.equal(trimmedReplace.changes[0].firstChangedLine, 7);
const trimmedManifest = JSON.parse(storedSkill("资源编辑").resources.find(resource => resource.path === "plugin.json").content);
assert.deepEqual(trimmedManifest.tools.map(tool => tool.name), ["collect_all_author_works", "list_video_subtitle"]);

await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "set",
    path: "scripts/escaped.js",
    type: "script",
    content: "const label = \"ready\";\nreturn label;\n",
  }],
});
const escapedReplace = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "replace",
    path: "scripts/escaped.js",
    oldText: "const label = \\\"ready\\\";\\nreturn label;",
    newText: "const label = \"done\";\nreturn label;",
  }],
});
assert.equal(escapedReplace.updated, true);
assert.match((await skills.loadSkillResource("资源编辑", "scripts/escaped.js")).resource.content, /label = "done"/);

await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "set",
    path: "scripts/nested-anchor.js",
    type: "script",
    content: [
      "function collect() {",
      "  if (ready) {",
      "  }",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  return value;",
      "}",
      "",
    ].join("\n"),
  }],
});
const nestedAnchorReplace = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "replace",
    path: "scripts/nested-anchor.js",
    oldText: [
      "function collect() {",
      "  if (ready) {",
      "    run();",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  return value;",
      "}",
    ].join("\n"),
    newText: "function collect() {\n  return nextValue;\n}",
  }],
});
assert.equal(nestedAnchorReplace.updated, true);
assert.equal(nestedAnchorReplace.changes[0].firstChangedLine, 1);
assert.match((await skills.loadSkillResource("资源编辑", "scripts/nested-anchor.js")).resource.content, /return nextValue/);

await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "set",
    path: "scripts/ambiguous-indent.js",
    type: "script",
    content: [
      "function first() {",
      "  if (ready) {",
      "    run();",
      "  }",
      "}",
      "function second() {",
      "    if (ready) {",
      "        run();",
      "    }",
      "}",
      "",
    ].join("\n"),
  }],
});
await assert.rejects(
  () => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "replace",
      path: "scripts/ambiguous-indent.js",
      oldText: "if (ready) {\nrun();\n}",
      newText: "if (ready) {\n  finish();\n}",
    }],
  }),
  err => err?.code === "SKILL_EDIT_OLD_TEXT_NOT_UNIQUE"
    && err.details?.occurrences === 2
    && err.details?.rankedCandidates?.length === 2,
);
assert.doesNotMatch(
  (await skills.loadSkillResource("资源编辑", "scripts/ambiguous-indent.js")).resource.content,
  /finish/,
);

await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "set",
    path: "scripts/ambiguous-fuzzy.js",
    type: "script",
    content: [
      "function target() {",
      "  alpha();",
      "  actualOne();",
      "  omega();",
      "}",
      "function target() {",
      "  alpha();",
      "  actualTwo();",
      "  omega();",
      "}",
      "",
    ].join("\n"),
  }],
});
await assert.rejects(
  () => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "replace",
      path: "scripts/ambiguous-fuzzy.js",
      oldText: "function target() {\n  alpha();\n  expected();\n  omega();\n}",
      newText: "function target() {\n  return done;\n}",
    }],
  }),
  err => err?.code === "SKILL_EDIT_OLD_TEXT_NOT_UNIQUE"
    && err.details?.occurrences === 2
    && err.details?.candidateLines?.join(",") === "1,6",
);

await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "set",
    path: "references/retry-candidate.md",
    type: "markdown",
    content: "stable opening\nactual middle value\nstable closing\n",
  }],
});
let retryCandidate = "";
await assert.rejects(
  () => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "replace",
      path: "references/retry-candidate.md",
      oldText: "stable opening\ncompletely unrelated expected text\nstable closing",
      newText: "stable opening\nupdated middle value\nstable closing",
    }],
  }),
  err => {
    retryCandidate = err?.details?.bestCandidate?.oldText || "";
    return err?.code === "SKILL_EDIT_OLD_TEXT_NOT_FOUND"
      && retryCandidate === "stable opening\nactual middle value\nstable closing"
      && /bestCandidate\.oldText/.test(err.details?.recommendedAction || "");
  },
);
const retriedCandidateReplace = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "replace",
    path: "references/retry-candidate.md",
    oldText: retryCandidate,
    newText: "stable opening\nupdated middle value\nstable closing",
  }],
});
assert.equal(retriedCandidateReplace.updated, true);

await assert.rejects(
  () => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "replace",
      path: "references/notes.md",
      oldText: "alpha sentinel line\nwrong value",
      newText: "alpha sentinel line\nfixed value",
    }],
  }),
  err => err?.code === "SKILL_EDIT_OLD_TEXT_NOT_FOUND"
    && /load_skill_resource/.test(err.details?.recommendedAction || "")
    && err.details?.candidates?.[0]?.line === 1,
);

await assert.rejects(
  () => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "replace",
      path: "references/notes.md",
      oldText: "same token line",
      newText: "unique line",
    }],
  }),
  err => err?.code === "SKILL_EDIT_OLD_TEXT_NOT_UNIQUE"
    && err.details?.occurrences === 2,
);

await assert.rejects(
  () => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "set",
      path: "references/overlap.txt",
      content: "abcdef",
    }],
  }).then(() => skills.updateSkill("资源编辑", {
    resourceEdits: [{
      action: "replace",
      path: "references/overlap.txt",
      edits: [
        { oldText: "abc", newText: "x" },
        { oldText: "bcd", newText: "y" },
      ],
    }],
  })),
  err => err?.code === "SKILL_EDIT_OVERLAP"
    && err.details?.editIndexes?.join(",") === "0,1",
);

const renameResult = await skills.updateSkill("资源编辑", {
  resourceEdits: [{
    action: "rename",
    path: "references\\notes.md",
    newPath: "/references/archive//notes.md",
  }],
});
assert.equal(renameResult.updated, true);
assert.equal(renameResult.changes[0].newPath, "references/archive/notes.md");
assert.equal((await skills.loadSkillResource("资源编辑", "references/notes.md")).resource, null);
assert.match((await skills.loadSkillResource("资源编辑", "references/archive/notes.md")).resource.content, /alpha sentinel/);

const deleteResult = await skills.updateSkill("资源编辑", {
  resourceEdits: [{ action: "delete", path: "references/archive/notes.md" }],
});
assert.equal(deleteResult.updated, true);
assert.equal((await skills.loadSkillResource("资源编辑", "references/archive/notes.md")).resource, null);

await assert.rejects(
  () => skills.loadSkillScript("资源编辑", "plugin.json"),
  /not executable script/,
);

console.log("skill resource edit tests passed");
