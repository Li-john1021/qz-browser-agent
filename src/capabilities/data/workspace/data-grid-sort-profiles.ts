import { getLocale } from "#sdk/shared/i18n";
import { t } from "../i18n.js";
import type { DataColumnMeta } from '#sdk/shared/data';

type Row = Record<string, unknown>;
interface ParsedSortValue { valid: boolean; key: number }
export interface DataSortProfile { kind: string; label: string; parse: ((value: string) => ParsedSortValue) | null }
interface SortKey { empty: boolean; valid: boolean; key: string | number }
type SortCache = Map<string, SortKey>;
interface SortOptions<T> {
  sampleLimit?: number; minParseRatio?: number; widthSampleRows?: number;
  formatCellValue(value: unknown): string; formatCell(record: T, column: string): string;
  getRows?(): T[]; getCurrentTable?(): string | null; getProfiles?(): Map<string, DataSortProfile>;
}
export function createDataGridSortProfiles<T>(options: SortOptions<T>) {
  const sampleLimit = Math.max(1, Number(options.sampleLimit) || 100);
  const minParseRatio = Math.max(0, Math.min(1, Number(options.minParseRatio) || 0.85));
  const widthSampleRows = Math.max(1, Number(options.widthSampleRows) || 10);
  const DATA_GRID_TEXT_SORT_PROFILE: DataSortProfile = Object.freeze({
    kind: "text",
    label: t("text"),
    parse: null,
  });
  const DATA_GRID_SORTER_PARAMS = Object.freeze({ alignEmptyValues: "bottom" });

  const DATA_GRID_SORT_PARSERS = [
    { kind: "money", label: t("money"), parse: parseDataGridMoneySortValue },
    { kind: "temperature", label: t("temperature"), parse: createUnitSortParser([
      ["°C|C|摄氏度|摄氏|度C|度", 1],
      ["°F|F|华氏度|华氏|度F", number => (number - 32) * 5 / 9],
      ["K|开尔文", number => number - 273.15],
    ], "", text => text.replace(/^零下/, "-")) },
    { kind: "percent", label: t("percentage"), parse: createUnitSortParser([
      ["%|百分比|pct", number => number / 100],
      ["‰", number => number / 1000],
    ], "i") },
    { kind: "speed", label: t("speed"), parse: createUnitSortParser([
      ["km/h|kph|公里/小时|公里每小时", 1000 / 3600],
      ["m/s|米/秒", 1],
      ["mph|mi/h|英里/小时", 0.44704],
    ], "i") },
    { kind: "storage", label: t("storage"), parse: createUnitSortParser([
      ["B|字节", 1],
      ["[Kk]B|[Kk]iB|K", 1024],
      ["[Mm]B|[Mm]iB|M", 1024 ** 2],
      ["[Gg]B|[Gg]iB|G", 1024 ** 3],
      ["[Tt]B|[Tt]iB|T", 1024 ** 4],
      ["[Pp]B|[Pp]iB|P", 1024 ** 5],
    ]) },
    { kind: "area", label: t("area"), parse: createUnitSortParser([
      ["mm2|平方毫米", 0.000001],
      ["cm2|平方厘米", 0.0001],
      ["m2|㎡|平方米|平米", 1],
      ["km2|平方公里|平方千米", 1000000],
      ["亩", 666.6666667],
      ["公顷|ha", 10000],
    ], "i") },
    { kind: "volume", label: t("volume"), parse: createUnitSortParser([
      ["ml|mL|毫升|cc|cm3|立方厘米", 0.001],
      ["l|L|升", 1],
      ["m3|立方米", 1000],
    ]) },
    { kind: "duration", label: t("duration"), parse: createUnitSortParser([
      ["ms|毫秒", 0.001],
      ["s|sec|second|秒", 1],
      ["min|minute|分钟", 60],
      ["h|hr|hour|小时", 3600],
      ["d|day|天", 86400],
      ["week|周", 604800],
    ], "i") },
    { kind: "weight", label: t("weight"), parse: createUnitSortParser([
      ["mg|MG|Mg|毫克", 0.001],
      ["g|克", 1],
      ["kg|KG|Kg|千克|公斤", 1000],
      ["斤|市斤", 500],
      ["t|T|吨", 1000000],
      ["oz|OZ|Oz|盎司", 28.349523125],
      ["lb|LB|lbs|LBS|磅", 453.59237],
    ]) },
    { kind: "distance", label: t("distance"), parse: createUnitSortParser([
      ["mm|MM|Mm|毫米", 0.001],
      ["cm|CM|Cm|厘米", 0.01],
      ["m|米", 1],
      ["km|KM|Km|公里|千米", 1000],
      ["里", 500],
      ["mi|MI|Mi|mile|miles|英里", 1609.344],
      ["ft|FT|Ft|feet|foot|英尺", 0.3048],
      ["in|IN|In|inch|英寸", 0.0254],
      ["yd|YD|Yd|yard|码", 0.9144],
    ]) },
    { kind: "datetime", label: t("date"), parse: parseDataGridDateSortValue },
    { kind: "number", label: t("number"), parse: parseDataGridNumberSortValue },
  ];

  function inferDataGridSortProfiles(rows: Row[] = [], columns: string[] = []) {
    const profiles = new Map<string, DataSortProfile>();
    for (const column of columns || []) {
      profiles.set(column, inferDataGridSortProfile(column, rows));
    }
    return profiles;
  }

  function inferDataGridSortProfile(column: string, rows: Row[] = []) {
    const sampleValues = sampleDataGridSortValues(rows, column);
    if (!sampleValues.length) return DATA_GRID_TEXT_SORT_PROFILE;
    for (const parser of DATA_GRID_SORT_PARSERS) {
      if (parser.kind === "number" && shouldForceTextDataGridSort(column)) continue;
      const parsedCount = sampleValues.reduce((count, value) => count + (parser.parse(value).valid ? 1 : 0), 0);
      if (parsedCount / sampleValues.length >= minParseRatio) {
        return parser;
      }
    }
    return DATA_GRID_TEXT_SORT_PROFILE;
  }

  function sampleDataGridSortValues(rows: Row[] = [], column = "") {
    return sampleDataGridSortRows(rows, column)
      .map(row => options.formatCellValue(dataGridSortCellValue(row, column)).trim())
      .filter(Boolean);
  }

  function dataGridSortCellValue(row: Row, column = "") {
    if (!row || typeof row !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(row, column)) return row[column];
    if (column === "_rowId") return row.id;
    const data = row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Row : null;
    return data?.[column];
  }

  function sampleDataGridSortRows(rows: Row[] = [], column = "") {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length <= sampleLimit) return list;
    const pickedIndexes = new Set<number>();
    let seed = hashDataGridSortSeed(`${options.getCurrentTable?.() || ""}\n${column}\n${list.length}`);
    const nextIndex = (upperBound: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return Math.floor((seed / 0x100000000) * upperBound);
    };
    for (let index = list.length - sampleLimit; index < list.length; index += 1) {
      const candidate = nextIndex(index + 1);
      pickedIndexes.add(pickedIndexes.has(candidate) ? index : candidate);
    }
    return Array.from(pickedIndexes, index => list[index]);
  }

  function hashDataGridSortSeed(value = "") {
    let hash = 2166136261;
    for (const char of String(value || "")) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function shouldForceTextDataGridSort(column = "") {
    return /(^|[_\s:：-])(id|uid|uuid|guid|sku|code|hash|phone|mobile|tel|url|链接|编号|编码|代码|号码|手机|电话|邮编|身份证)([_\s:：-]|$)/i
      .test(String(column || ""));
  }

  function getDataGridSortProfile(column: string) {
    return options.getProfiles?.().get(column) || DATA_GRID_TEXT_SORT_PROFILE;
  }

  function getDataGridSortProfileLabel(column: string) {
    return getDataGridSortProfile(column).label || DATA_GRID_TEXT_SORT_PROFILE.label;
  }

  function createDataGridColumnSorter(profile = DATA_GRID_TEXT_SORT_PROFILE) {
    if (!profile || profile.kind === "text" || typeof profile.parse !== "function") return "string";
    const cache: SortCache = new Map();
    return (a: unknown, b: unknown, _aRow: unknown, _bRow: unknown, _column: unknown, direction = "asc") => (
      compareDataGridTypedSortValues(a, b, profile, cache, direction)
    );
  }

  function compareDataGridTypedSortValues(a: unknown, b: unknown, profile: DataSortProfile, cache: SortCache, direction = "asc") {
    const left = getDataGridSortKey(a, profile, cache);
    const right = getDataGridSortKey(b, profile, cache);
    if (left.empty !== right.empty) {
      const order = left.empty ? -1 : 1;
      return direction === "asc" ? -order : order;
    }
    if (left.valid && right.valid) {
      if (left.key < right.key) return -1;
      if (left.key > right.key) return 1;
      return compareDataGridTextSortValues(a, b);
    }
    if (left.valid !== right.valid) return left.valid ? -1 : 1;
    return compareDataGridTextSortValues(a, b);
  }

  function getDataGridSortKey(value: unknown, profile: DataSortProfile, cache: SortCache): SortKey {
    const raw = options.formatCellValue(value).trim();
    const cached = cache.get(raw);
    if (cached) return cached;
    const parsed = profile.parse?.(raw);
    const key = !raw
      ? { empty: true, valid: false, key: "" }
      : parsed?.valid
        ? { empty: false, valid: true, key: parsed.key }
        : { empty: false, valid: false, key: raw };
    cache.set(raw, key);
    return key;
  }

  function compareDataGridTextSortValues(a: unknown, b: unknown) {
    return options.formatCellValue(a).localeCompare(options.formatCellValue(b), getLocale(), {
      numeric: true,
      sensitivity: "base",
    });
  }

  function normalizeDataGridSortText(value: unknown) {
    return String(value || "").trim()
      .replace(/\u00a0/g, " ")
      .replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
      .replace(/，/g, ",")
      .replace(/[．。]/g, ".")
      .replace(/％/g, "%")
      .replace(/＋/g, "+")
      .replace(/[－−–—]/g, "-")
      .replace(/℃/g, "°C")
      .replace(/℉/g, "°F")
      .replace(/μ/g, "u")
      .replace(/²/g, "2")
      .replace(/³/g, "3");
  }

  function parseDataGridSortNumber(value: unknown) {
    const text = normalizeDataGridSortText(value).replace(/,/g, "").trim();
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function parseDataGridMoneySortValue(value: unknown) {
    let text = normalizeDataGridSortText(value);
    if (!text) return { valid: false, key: 0 };
    let multiplier = 1;
    let hasMoneyMarker = false;

    text = text.replace(/^(?:￥|¥|\$|€|£|rmb|cny|usd|eur|gbp|jpy|hkd)\s*/i, () => {
      hasMoneyMarker = true;
      return "";
    }).trim();
    text = text.replace(/\s*(?:人民币|美元|美金|欧元|英镑|日元|日币|港币|港元)$/i, () => {
      hasMoneyMarker = true;
      return "";
    }).trim();

    const suffix = text.match(/(万元|亿元|元|块|角|毛|分|万|亿|k|K|m|M|b|B)$/);
    if (suffix) {
      const unit = suffix[1];
      if (unit === "万元") {
        multiplier *= 10000;
        hasMoneyMarker = true;
      } else if (unit === "亿元") {
        multiplier *= 100000000;
        hasMoneyMarker = true;
      } else if (unit === "元" || unit === "块") {
        hasMoneyMarker = true;
      } else if (unit === "角" || unit === "毛") {
        multiplier *= 0.1;
        hasMoneyMarker = true;
      } else if (unit === "分") {
        multiplier *= 0.01;
        hasMoneyMarker = true;
      } else if (hasMoneyMarker) {
        multiplier *= unit === "亿" || unit === "b" || unit === "B"
          ? 100000000
          : unit === "万"
            ? 10000
            : unit === "m" || unit === "M"
              ? 1000000
              : 1000;
      }
      if (hasMoneyMarker) text = text.slice(0, -unit.length).trim();
    }
    if (!hasMoneyMarker) return { valid: false, key: 0 };
    const number = parseDataGridSortNumber(text);
    return number == null ? { valid: false, key: 0 } : { valid: true, key: number * multiplier };
  }

  /** One numeric grammar; each unit group preserves its own spelling and conversion. */
  function createUnitSortParser(
    groups: readonly (readonly [string, number | ((value: number) => number)])[],
    flags = "",
    normalize = (text: string) => text,
  ) {
    const numberPattern = String.raw`([+-]?(?:\d+(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)`;
    const pattern = new RegExp(`^${numberPattern}\\s*(?:${groups.map(([units]) => `(${units})`).join("|")})$`, flags);
    return (value: unknown): ParsedSortValue => {
      const match = normalize(normalizeDataGridSortText(value)).match(pattern);
      if (!match) return { valid: false, key: 0 };
      const number = parseDataGridSortNumber(match[1]);
      if (number == null) return { valid: false, key: 0 };
      const groupIndex = match.findIndex((unit, index) => index > 1 && unit !== undefined) - 2;
      const conversion = groups[groupIndex][1];
      return { valid: true, key: typeof conversion === "function" ? conversion(number) : number * conversion };
    };
  }

  function parseDataGridDateSortValue(value: unknown) {
    const text = normalizeDataGridSortText(value);
    if (/^\d+(?:\.\d+)?$/.test(text)) return { valid: false, key: 0 };
    const cnMatch = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (cnMatch) {
      const [, y, m, d, hh = "0", mm = "0", ss = "0"] = cnMatch;
      const time = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
      return Number.isFinite(time) ? { valid: true, key: time } : { valid: false, key: 0 };
    }
    if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)) return { valid: false, key: 0 };
    const time = Date.parse(text.replace(/\//g, "-"));
    return Number.isFinite(time) ? { valid: true, key: time } : { valid: false, key: 0 };
  }

  function parseDataGridNumberSortValue(value: unknown) {
    let text = normalizeDataGridSortText(value);
    if (!text) return { valid: false, key: 0 };
    let multiplier = 1;
    if (/%$/.test(text)) {
      multiplier = 0.01;
      text = text.replace(/%$/, "");
    }
    const suffix = text.match(/([万亿])$/);
    if (suffix) {
      multiplier *= suffix[1] === "亿" ? 100000000 : 10000;
      text = text.slice(0, -1);
    }
    text = text.replace(/^[￥¥$€£]\s*/, "").replace(/,/g, "").trim();
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return { valid: false, key: 0 };
    const number = Number(text);
    return Number.isFinite(number) ? { valid: true, key: number * multiplier } : { valid: false, key: 0 };
  }

  function resolveDataGridColumnWidthGrow(column: string, meta: DataColumnMeta = {}) {
    const storedGrow = Number(meta.widthGrow);
    if (Number.isFinite(storedGrow) && storedGrow > 0) return clampDataGridWidthGrow(storedGrow);
    const legacyWidth = Number(meta.width);
    if (Number.isFinite(legacyWidth) && legacyWidth >= 40) return clampDataGridWidthGrow(legacyWidth / 24);
    return smartDataGridColumnWidthGrow(column);
  }

  function smartDataGridColumnWidthGrow(column: string) {
    const samples = [
      String(column || ""),
      ...(options.getRows?.() || [])
        .slice(0, widthSampleRows)
        .map(record => options.formatCell(record, column)),
    ].filter(value => value != null && value !== "");
    const units = samples.map(estimateDataGridTextUnits).filter(Number.isFinite);
    const headerUnits = estimateDataGridTextUnits(column);
    const maxUnits = units.length ? Math.max(...units) : headerUnits;
    const avgUnits = units.length ? units.reduce((sum, value) => sum + value, 0) / units.length : headerUnits;
    const score = Math.max(9, headerUnits * 1.25, avgUnits * 0.55 + maxUnits * 0.45);
    return clampDataGridWidthGrow(score / 8);
  }

  function estimateDataGridTextUnits(value: unknown) {
    const text = String(value ?? "").trim();
    if (!text) return 4;
    let units = 0;
    for (const char of text.slice(0, 120)) {
      units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/.test(char) ? 1.8 : 1;
    }
    return Math.min(64, Math.max(4, units));
  }

  function clampDataGridWidthGrow(value: unknown) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 1;
    return Math.round(Math.max(0.75, Math.min(10, number)) * 100) / 100;
  }


  return {
    sorterParams: DATA_GRID_SORTER_PARAMS,
    inferProfiles: inferDataGridSortProfiles,
    getProfile: getDataGridSortProfile,
    getProfileLabel: getDataGridSortProfileLabel,
    createColumnSorter: createDataGridColumnSorter,
    resolveColumnWidthGrow: resolveDataGridColumnWidthGrow,
    clampWidthGrow: clampDataGridWidthGrow,
    parse: Object.freeze(Object.fromEntries(DATA_GRID_SORT_PARSERS.map(profile => [profile.kind, profile.parse]))),
  };
}
