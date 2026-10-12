import assert from "node:assert/strict";
import test from "node:test";

async function withRendererLanguage(language, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { i18n: { getUILanguage: () => language } } });
  try {
    // A browser-language change reloads the extension; each import models a fresh registration.
    const runtime = await import(`../../src/shared/skills/skill-renderers.ts?renderer-language=${language}`);
    return await run(runtime);
  } finally {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else delete globalThis.chrome;
  }
}

test("renderer documentation follows browser language without changing types or result paths", async () => {
  const snapshots = {};
  for (const language of ["zh-CN", "en"]) {
    await withRendererLanguage(language, runtime => {
      const definitions = runtime.listSkillRendererDefinitions();
      snapshots[language] = definitions.map(({ type, defaultPaths, returnShape }) => ({
        type, defaultPaths, returnShape: returnShape.replaceAll(" 或 ", " or "),
      }));
      for (const definition of definitions) {
        const schema = { type: definition.type, valuePath: "payload", totalPath: "totalRows", truncatedPath: "truncated" };
        const documentation = [definition.title, definition.description, definition.returnShape,
          runtime.buildSkillRendererReturnContract({ type: definition.type }),
          runtime.buildSkillRendererReturnContract(schema),
          runtime.buildSkillRendererReturnContract({ ...schema, source: "args", sourcePath: "request" }),
        ].join("\n");
        if (language === "en") assert.doesNotMatch(documentation, /\p{Script=Han}/u, definition.type);
        else assert.match(documentation, /返回格式契约/, definition.type);
      }
    });
  }
  assert.deepEqual(snapshots.en, snapshots["zh-CN"]);
});

test("renderer contract interpolation preserves user paths and distinguishes arguments from results", async () => {
  for (const language of ["zh-CN", "en"]) {
    await withRendererLanguage(language, runtime => {
      const userPath = "原始路径.{type}.<value>";
      const contract = runtime.buildSkillRendererReturnContract({ type: "text", valuePath: userPath });
      assert.ok(contract.includes(userPath), "User paths must not be translated or interpolated again");
      const layout = runtime.buildSkillRendererReturnContract({ layout: { type: "stack", blocks: [
        { type: "summary", sourcePath: "summary", fields: [{ label: "原始标题", path: userPath }] },
        { type: "text", source: "args", sourcePath: "request", valuePath: "query" },
      ] } });
      assert.ok(layout.includes(userPath));
      assert.ok(layout.includes("args.request.query"));
      assert.ok(layout.includes("sourcePath"));
      assert.match(layout, language === "en" ? /outside the script return contract/ : /不属于脚本 return 契约/);
    });
  }
});

test("table renderer metadata remains explicit in each language and in every optional-field combination", async () => {
  for (const language of ["zh-CN", "en"]) {
    await withRendererLanguage(language, runtime => {
      for (const fields of [{}, { totalPath: "totalRows" }, { truncatedPath: "truncated" }, { totalPath: "totalRows", truncatedPath: "truncated" }]) {
        const contract = runtime.buildSkillRendererReturnContract({ type: "table", ...fields });
        if (fields.totalPath) assert.match(contract, language === "en" ? /totalRows is the total result row count/ : /totalRows 表示完整结果行数/);
        if (fields.truncatedPath) assert.match(contract, language === "en" ? /truncated indicates whether the current rows are truncated/ : /truncated 表示当前 rows 是否被截断/);
        assert.doesNotMatch(contract, /undefined/);
        if (fields.totalPath && fields.truncatedPath && language === "zh-CN") {
          assert.ok(contract.includes("- 集合元数据：totalRows 表示完整结果行数；truncated 表示当前 rows 是否被截断。"));
        }
      }
    });
  }
});
