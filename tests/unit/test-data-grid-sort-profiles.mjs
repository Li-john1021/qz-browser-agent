import { transformSync } from "esbuild";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { getLocale } from "../../src/shared/i18n/index.js";
import { createDataGridSortProfiles } from "../../src/capabilities/data/workspace/data-grid-sort-profiles.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dataFeatureSource = transformSync(readFileSync(join(root, "src/capabilities/data/workspace/data-feature.ts"), "utf8"), { loader: "ts", charset: "utf8" }).code;
let formatCellCalls = 0;
let formattedValues = [];

const sortEngine = createDataGridSortProfiles({
  sampleLimit: 100,
  minParseRatio: 0.85,
  getCurrentTable: () => "sort_profile_test",
  getProfiles: () => new Map(),
  formatCellValue(value) {
    formatCellCalls += 1;
    const formatted = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    formattedValues.push(formatted);
    return formatted;
  },
});

const fallbackContext = { Number, String, getLocale };
vm.createContext(fallbackContext);
vm.runInContext(`
${extractFunction(dataFeatureSource, "isEmptyDataSortValue")}
${extractFunction(dataFeatureSource, "compareDataValues")}
globalThis.compareDataValues = compareDataValues;
`, fallbackContext);

const compareDataValues = fallbackContext.compareDataValues;
const inferDataGridSortProfiles = (records, columns) => sortEngine.inferProfiles(records, columns);
const inferDataGridSortProfile = (field, records) => inferDataGridSortProfiles(records, [field]).get(field);
const createDataGridColumnSorter = profile => sortEngine.createColumnSorter(profile);

function rows(field, values) {
  return values.map(value => ({ [field]: value }));
}

function profileKind(field, values) {
  return inferDataGridSortProfile(field, rows(field, values)).kind;
}

assert.equal(profileKind("销售额", ["2", "10", "1,200", "3.5万"]), "number");
assert.equal(profileKind("金额", ["¥12", "3万元", "$10", "2.5亿元"]), "money");
assert.equal(profileKind("温度", ["30℃", "86°F", "300K", "零下5度"]), "temperature");
assert.equal(profileKind("比例", ["12%", "3.5%", "0.8‰", "42pct"]), "percent");
assert.equal(profileKind("速度", ["10km/h", "3m/s", "60mph", "80公里/小时"]), "speed");
assert.equal(profileKind("文件大小", ["512MB", "1GB", "1024KB", "16G"]), "storage");
assert.equal(profileKind("面积", ["300㎡", "1公顷", "2亩", "0.5平方公里"]), "area");
assert.equal(profileKind("体积", ["500ml", "1L", "2立方米", "300cc"]), "volume");
assert.equal(profileKind("耗时", ["500ms", "2秒", "1.5小时", "3天"]), "duration");
assert.equal(profileKind("重量", ["300g", "1.2kg", "2斤", "0.5吨"]), "weight");
assert.equal(profileKind("英制重量", ["1lb", "16oz", "2磅", "500g"]), "weight");
assert.equal(profileKind("距离", ["300m", "1.2km", "20cm", "5公里"]), "distance");
assert.equal(profileKind("英制距离", ["1英里", "3ft", "10in", "2码"]), "distance");
assert.equal(profileKind("日期", ["2026-07-09", "2026/07/10", "2026年7月8日"]), "datetime");
assert.equal(profileKind("uid", ["001", "010", "2", "100"]), "text");
assert.equal(profileKind("稀疏数字", ["", "  ", null, undefined, "123"]), "number");
assert.equal(profileKind("裸温度", ["30", "-5", "100"]), "number");
assert.equal(profileKind("裸金额", ["100", "200", "3.5万"]), "number");
assert.equal(profileKind("混合", ["1kg", "2km", "abc", "5"]), "text");
assert.equal(inferDataGridSortProfile("金额", [
  { id: "row-1", data: { 金额: "¥12" } },
  { id: "row-2", data: { 金额: "3万元" } },
]).kind, "money", "type inference should sample raw stored records without expanding every row");

// Accepted spellings intentionally differ by dimension: e.g. MB is bytes, while mb is not.
const unitAliases = [
  ["temperature", ["1°C", "1C", "1摄氏度", "1摄氏", "1度C", "1度", "１℃"], 1],
  ["temperature", ["32°F", "32F", "32华氏度", "32华氏", "32度F", "３２℉"], 0],
  ["temperature", ["273.15K", "273.15开尔文"], 0],
  ["temperature", ["零下5度", "−5°C", "－５℃"], -5],
  ["percent", ["1%", "1百分比", "1pct", "1PCT", "１％"], 0.01],
  ["percent", ["1‰"], 0.001],
  ["speed", ["1km/h", "1kph", "1公里/小时", "1公里每小时", "1KM/H"], 1000 / 3600],
  ["speed", ["1m/s", "1米/秒", "1M/S"], 1],
  ["speed", ["1mph", "1mi/h", "1英里/小时"], 0.44704],
  ["storage", ["1B", "1字节"], 1],
  ["storage", ["1KB", "1kB", "1KiB", "1kiB", "1K"], 1024],
  ["storage", ["1MB", "1mB", "1MiB", "1miB", "1M"], 1024 ** 2],
  ["storage", ["1GB", "1gB", "1GiB", "1giB", "1G"], 1024 ** 3],
  ["storage", ["1TB", "1tB", "1TiB", "1tiB", "1T"], 1024 ** 4],
  ["storage", ["1PB", "1pB", "1PiB", "1piB", "1P"], 1024 ** 5],
  ["area", ["1mm2", "1平方毫米", "1MM²"], 0.000001],
  ["area", ["1cm2", "1平方厘米"], 0.0001],
  ["area", ["1m2", "1㎡", "1平方米", "1平米"], 1],
  ["area", ["1km2", "1平方公里", "1平方千米"], 1000000],
  ["area", ["1亩"], 666.6666667],
  ["area", ["1公顷", "1ha", "1HA"], 10000],
  ["volume", ["1ml", "1mL", "1毫升", "1cc", "1cm3", "1立方厘米", "1cm³"], 0.001],
  ["volume", ["1l", "1L", "1升"], 1],
  ["volume", ["1m3", "1立方米"], 1000],
  ["duration", ["1ms", "1毫秒"], 0.001],
  ["duration", ["1s", "1sec", "1second", "1秒"], 1],
  ["duration", ["1min", "1minute", "1分钟", "1MIN"], 60],
  ["duration", ["1h", "1hr", "1hour", "1小时"], 3600],
  ["duration", ["1d", "1day", "1天"], 86400],
  ["duration", ["1week", "1周", "1WEEK"], 604800],
  ["weight", ["1mg", "1MG", "1Mg", "1毫克"], 0.001],
  ["weight", ["1g", "1克"], 1],
  ["weight", ["1kg", "1KG", "1Kg", "1千克", "1公斤"], 1000],
  ["weight", ["1斤", "1市斤"], 500],
  ["weight", ["1t", "1T", "1吨"], 1000000],
  ["weight", ["1oz", "1OZ", "1Oz", "1盎司"], 28.349523125],
  ["weight", ["1lb", "1LB", "1lbs", "1LBS", "1磅"], 453.59237],
  ["distance", ["1mm", "1MM", "1Mm", "1毫米"], 0.001],
  ["distance", ["1cm", "1CM", "1Cm", "1厘米"], 0.01],
  ["distance", ["1m", "1米"], 1],
  ["distance", ["1km", "1KM", "1Km", "1公里", "1千米"], 1000],
  ["distance", ["1里"], 500],
  ["distance", ["1mi", "1MI", "1Mi", "1mile", "1miles", "1英里"], 1609.344],
  ["distance", ["1ft", "1FT", "1Ft", "1feet", "1foot", "1英尺"], 0.3048],
  ["distance", ["1in", "1IN", "1In", "1inch", "1英寸"], 0.0254],
  ["distance", ["1yd", "1YD", "1Yd", "1yard", "1码"], 0.9144],
];
for (const [kind, inputs, expected] of unitAliases) {
  for (const input of inputs) assert.deepEqual(sortEngine.parse[kind](input), { valid: true, key: expected }, `${kind}: ${input}`);
}
for (const [kind, unit] of [
  ["temperature", "C"], ["percent", "%"], ["speed", "m/s"], ["storage", "B"],
  ["area", "m2"], ["volume", "L"], ["duration", "s"], ["weight", "g"], ["distance", "m"],
]) {
  for (const [text, number] of [["0", 0], ["-0", -0], ["+12.25", 12.25], [".5", 0.5], ["-0.5", -0.5], ["1,234,567.5", 1234567.5], ["＋１，２３４．５", 1234.5]]) {
    assert.deepEqual(sortEngine.parse[kind](` ${text}\u00a0${unit} `), { valid: true, key: kind === "percent" ? number / 100 : number }, `${kind} numeric grammar: ${text}`);
  }
  for (const text of ["", " ", ".", "+.5", "-.5", "1.", "1,23", "1,0000", "1e3", "0x10", "Infinity", "NaN", "9".repeat(400)]) {
    assert.deepEqual(sortEngine.parse[kind](`${text}${unit}`), { valid: false, key: 0 }, `${kind} must reject: ${text}`);
  }
  assert.deepEqual(sortEngine.parse[kind]("1"), { valid: false, key: 0 }, `${kind} requires a unit`);
}
for (const [kind, units] of [
  ["temperature", ["c", "°c", "f", "k", "度c"]],
  ["storage", ["b", "kb", "kib", "k", "KIB", "gIB", "mb"]],
  ["volume", ["ML", "Ml", "CC", "CM3", "M3"]],
  ["weight", ["mG", "kG", "G", "Lb", "Lbs", "oZ"]],
  ["distance", ["mM", "cM", "kM", "fT", "iN", "yD", "M", "MILE", "Foot"]],
]) {
  for (const unit of units) assert.deepEqual(sortEngine.parse[kind](`1${unit}`), { valid: false, key: 0 }, `${kind} case restriction: ${unit}`);
}

formatCellCalls = 0;
formattedValues = [];
inferDataGridSortProfiles(rows("value", Array.from({ length: 10_000 }, (_, index) => String(index))), ["value"]);
assert.equal(formatCellCalls, 100, "sampling a large column should inspect only 100 cells");
assert.equal(formattedValues.length, 100, "type inference should sample at most 100 values");
assert.ok(formattedValues.some(value => Number(value) >= 100), "sampling should cover the full column instead of taking the first 100 values");
formatCellCalls = 0;
formattedValues = [];
assert.equal(
  inferDataGridSortProfile("value", rows("value", Array.from({ length: 300 }, (_, index) => index % 2 === 0 ? "  " : String(index)))).kind,
  "number",
  "blank cells should be excluded from the parse ratio",
);
assert.equal(formatCellCalls, 100, "blank cells should not trigger an unbounded replacement scan");
formattedValues = [];
inferDataGridSortProfiles(rows("value", Array.from({ length: 300 }, (_, index) => String(index))), ["value"]);
const firstStableSample = formattedValues.slice();
formattedValues = [];
inferDataGridSortProfiles(rows("value", Array.from({ length: 300 }, (_, index) => String(index))), ["value"]);
assert.deepEqual(formattedValues, firstStableSample, "randomized sampling should remain stable for the same table and column");

const wideColumns = Array.from({ length: 24 }, (_, index) => `metric_${index}`);
const wideRows = Array.from({ length: 10_000 }, (_, rowIndex) => Object.fromEntries(
  wideColumns.map((column, columnIndex) => [column, String(rowIndex + columnIndex)]),
));
formatCellCalls = 0;
formattedValues = [];
inferDataGridSortProfiles(wideRows, wideColumns);
assert.equal(formatCellCalls, 2_400, "24-column inference should inspect 100 cells per column, independent of row count");

const profiles = inferDataGridSortProfiles(rows("销售额", ["2", "10", "1"]), ["销售额"]);
const sorter = createDataGridColumnSorter(profiles.get("销售额"));
assert.deepEqual(["10", "2", "1"].sort((a, b) => sorter(a, b)), ["1", "2", "10"]);

const weightSorter = createDataGridColumnSorter(inferDataGridSortProfile("重量", rows("重量", ["300g", "1.2kg", "2斤"])));
assert.deepEqual(["1.2kg", "300g", "2斤"].sort((a, b) => weightSorter(a, b)), ["300g", "2斤", "1.2kg"]);

const moneySorter = createDataGridColumnSorter(inferDataGridSortProfile("金额", rows("金额", ["¥3", "$10", "2元", "1万元"])));
assert.deepEqual(["$10", "¥3", "1万元", "2元"].sort((a, b) => moneySorter(a, b)), ["2元", "¥3", "$10", "1万元"]);

const tempSorter = createDataGridColumnSorter(inferDataGridSortProfile("温度", rows("温度", ["30℃", "50°F", "300K", "零下5度"])));
assert.deepEqual(["30℃", "50°F", "300K", "零下5度"].sort((a, b) => tempSorter(a, b)), ["零下5度", "50°F", "300K", "30℃"]);

const storageSorter = createDataGridColumnSorter(inferDataGridSortProfile("文件大小", rows("文件大小", ["1GB", "512MB", "2MB"])));
assert.deepEqual(["1GB", "2MB", "512MB"].sort((a, b) => storageSorter(a, b)), ["2MB", "512MB", "1GB"]);

function sortLikeTabulator(values, sorter, direction) {
  return [...values].sort((left, right) => direction === "desc"
    ? sorter(right, left, null, null, null, direction)
    : sorter(left, right, null, null, null, direction));
}

const valuesWithBlanks = ["", "10", null, "2", "  ", "1"];
const numericSorter = createDataGridColumnSorter(inferDataGridSortProfile("数量", rows("数量", valuesWithBlanks)));
const ascendingWithBlanks = sortLikeTabulator(valuesWithBlanks, numericSorter, "asc");
const descendingWithBlanks = sortLikeTabulator(valuesWithBlanks, numericSorter, "desc");
assert.deepEqual(ascendingWithBlanks.slice(0, 3), ["1", "2", "10"], "ascending typed sorts should keep parsed values first");
assert.deepEqual(descendingWithBlanks.slice(0, 3), ["10", "2", "1"], "descending typed sorts should keep parsed values first");
assert.ok(ascendingWithBlanks.slice(3).every(value => !String(value ?? "").trim()), "ascending typed sorts should keep blanks last");
assert.ok(descendingWithBlanks.slice(3).every(value => !String(value ?? "").trim()), "descending typed sorts should keep blanks last");

const fallbackValues = [null, "", "10", "2", " ", "1"];
const fallbackAscending = [...fallbackValues].sort((left, right) => compareDataValues(left, right, "asc"));
const fallbackDescending = [...fallbackValues].sort((left, right) => compareDataValues(left, right, "desc"));
assert.deepEqual(fallbackAscending.slice(0, 3), ["1", "2", "10"], "fallback ascending sorts should keep values before blanks");
assert.deepEqual(fallbackDescending.slice(0, 3), ["10", "2", "1"], "fallback descending sorts should keep values before blanks");
assert.ok(fallbackAscending.slice(3).every(value => !String(value ?? "").trim()), "fallback ascending sorts should keep blanks last");
assert.ok(fallbackDescending.slice(3).every(value => !String(value ?? "").trim()), "fallback descending sorts should keep blanks last");

console.log("data grid sort profile tests passed");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const parenStart = source.indexOf("(", start);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let index = parenStart; index < source.length; index += 1) {
    if (source[index] === "(") parenDepth += 1;
    else if (source[index] === ")" && --parenDepth === 0) {
      parenEnd = index;
      break;
    }
  }
  assert.notEqual(parenEnd, -1, `unterminated signature for ${name}`);
  const braceStart = source.indexOf("{", parenEnd);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${name}`);
}
