import assert from "node:assert/strict";
import { createDataGridLifecycle } from "../../src/capabilities/data/workspace/data-grid-lifecycle.js";
import { createDataGridFilterModel } from "../../src/capabilities/data/workspace/data-grid-filter-model.js";
import { createDataGridSortProfiles } from "../../src/capabilities/data/workspace/data-grid-sort-profiles.js";
import { countDelimiter, downloadDisplayName, inferImportMime, isImportableFilename, parseDelimitedRows, parseImportText, tableNameFromFilename } from "../../src/capabilities/data/workspace/data-import-parser.js";

export function testDataGridLifecycle() {
  const lifecycle = createDataGridLifecycle();
  const values = [];
  const firstGeneration = lifecycle.begin("building");
  const firstCallback = lifecycle.guard(value => values.push(value), firstGeneration);
  assert.equal(lifecycle.transition("ready", firstGeneration), true);
  firstCallback("first");

  const secondGeneration = lifecycle.begin("building");
  assert.equal(lifecycle.isCurrent(firstGeneration), false);
  assert.equal(lifecycle.transition("ready", firstGeneration), false);
  firstCallback("stale");
  lifecycle.guard(value => values.push(value), secondGeneration)("second");
  assert.deepEqual(values, ["first", "second"]);

  lifecycle.invalidate("empty");
  assert.equal(lifecycle.snapshot().state, "empty");
  assert.equal(lifecycle.snapshot().ready, false);
  assert.throws(() => lifecycle.invalidate("unknown"), /Unknown data grid state/);
}

export function testDataSortProfiles() {
  const rows = [
    { price: "¥1,200", temperature: "32°F", distance: "500 m", duration: "2 h", storage: "1 GB", ratio: "12%", id_code: "00123" },
    { price: "800元", temperature: "20°C", distance: "1 km", duration: "30 min", storage: "512 MB", ratio: "8%", id_code: "00009" },
  ];
  let profiles = new Map();
  const engine = createDataGridSortProfiles({
    minParseRatio: 1,
    getCurrentTable: () => "measurements",
    getRows: () => rows,
    getProfiles: () => profiles,
    formatCellValue: value => String(value ?? ""),
    formatCell: (row, column) => String(row?.[column] ?? ""),
  });
  profiles = engine.inferProfiles(rows, Object.keys(rows[0]));
  assert.equal(profiles.get("price").kind, "money");
  assert.equal(profiles.get("temperature").kind, "temperature");
  assert.equal(profiles.get("distance").kind, "distance");
  assert.equal(profiles.get("duration").kind, "duration");
  assert.equal(profiles.get("storage").kind, "storage");
  assert.equal(profiles.get("ratio").kind, "percent");
  assert.equal(profiles.get("id_code").kind, "text", "identifier-looking columns must not become numeric");
  assert.equal(engine.parse.distance("1 km").key, 1000);
  assert.equal(engine.parse.temperature("32°F").key, 0);
  assert.equal(engine.parse.weight("2斤").key, 1000);
  assert.equal(engine.parse.area("1亩").valid, true);
  assert.equal(engine.parse.volume("1m3").key, 1000);
  const sorter = engine.createColumnSorter(profiles.get("distance"));
  assert.ok(sorter("1 km", "500 m", null, null, null, "asc") > 0);
  assert.equal(engine.resolveColumnWidthGrow("distance", { widthGrow: 99 }), 10);
}

export function testDataFilterModel() {
  const rows = [
    { city: "杭州", score: "9.3", category: "景点" },
    { city: "杭州", score: "8.7", category: "寺庙" },
    { city: "苏州", score: "9.1", category: "景点" },
    { city: "", score: "7.0", category: "景点" },
  ];
  const model = createDataGridFilterModel({ getRows: () => rows, formatCellValue: value => String(value ?? "") });
  model.set("city", { values: ["杭州", "杭州"] });
  model.set("score", { text: "9" });
  assert.equal(model.predicate(rows[0]), true);
  assert.equal(model.predicate(rows[1]), false);
  assert.equal(model.predicate(rows[2]), false);
  assert.deepEqual(model.activeFilters().map(item => item.field), ["city", "score"]);

  const options = model.getCategoricalOptions("city", model.get("city"));
  assert.deepEqual(options.options.map(item => [item.value, item.count]), [["杭州", 1], ["苏州", 1]]);
  assert.equal(options.matchedRows, 2);
  assert.equal(model.categoricalValueLabel(""), "(空)");

  model.pruneColumns(["score"]);
  assert.deepEqual(model.activeFilters().map(item => item.field), ["score"]);
  model.set("score", { text: "", values: [] });
  assert.equal(model.activeFilters().length, 0);
}

export function testDelimitedImport() {
  const csv = '\uFEFFname,note\r\nAlice,"hello,\nworld"\r\nBob,"say ""hi"""';
  const rows = parseImportText(csv, "people.csv");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Alice");
  assert.equal(rows[0].note, "hello,\nworld");
  assert.equal(rows[1].note, 'say "hi"');
  assert.equal(rows[0]._sourceRow, 2);
  assert.equal(rows[0]._sourceFile, "people.csv");

  const tsv = parseImportText("name\tcity\nA\t杭州", "people.tsv");
  assert.equal(tsv[0].city, "杭州");
  assert.deepEqual(parseDelimitedRows('a,"b,c"', ","), [["a", "b,c"]]);
  assert.equal(countDelimiter("a,b,c\n1,2,3", ","), 4);
}

export function testJsonImportAndHelpers() {
  const rows = parseImportText('{"rows":[{"name":"A","value":null}]}', "items.json");
  assert.deepEqual(rows, [{ name: "A", value: "", _sourceFile: "items.json" }]);
  assert.equal(tableNameFromFilename("/tmp/结果表.csv"), "结果表");
  assert.equal(isImportableFilename("DATA.XLSX"), true);
  assert.equal(isImportableFilename("notes.txt"), false);
  assert.equal(inferImportMime("table.tsv"), "text/tab-separated-values");
  assert.equal(downloadDisplayName({ url: "https://example.com/a%20b.csv?token=x" }), "a%20b.csv");
  assert.throws(() => parseImportText(" ", "empty.csv"), /导入内容为空/);
  assert.throws(() => parseImportText("{bad", "bad.json"), /JSON 解析失败/);
}
