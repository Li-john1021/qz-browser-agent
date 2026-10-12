import { getLocale } from "#sdk/shared/i18n";
import { t } from "../i18n.js";
export interface DataGridFilter { text: string; values: string[] }
interface CategoricalOption { value: string; count: number }
type Row = Record<string, unknown>;
export function createDataGridFilterModel(options: { formatCellValue?: (value: unknown) => string; getRows?: () => Row[] } = {}) {
  const filters = new Map<string, DataGridFilter>();
  const formatCellValue = options.formatCellValue || (value => String(value ?? ""));

  function normalize(value: unknown): DataGridFilter {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const values = (value as Row).values;
      return {
        text: String((value as Row).text ?? "").trim(),
        values: Array.from(new Set((Array.isArray(values) ? values : [])
          .map(item => String(item ?? "")))),
      };
    }
    return { text: String(value ?? "").trim(), values: [] };
  }

  function get(field: string) {
    return normalize(filters.get(field));
  }

  function set(field: string, patch: Partial<DataGridFilter> = {}) {
    const next = normalize({ ...get(field), ...patch });
    if (isActive(next)) filters.set(field, next);
    else filters.delete(field);
    return next;
  }

  function isActive(value: unknown) {
    const filter = normalize(value);
    return Boolean(filter.text || filter.values.length);
  }

  function pruneInactive() {
    for (const [field, value] of filters.entries()) {
      if (!isActive(value)) filters.delete(field);
    }
  }

  function pruneColumns(columns: string[] = []) {
    const allowed = new Set(columns);
    for (const field of filters.keys()) {
      if (!allowed.has(field)) filters.delete(field);
    }
  }

  function getCategoricalOptions(field: string, filter: DataGridFilter) {
    const counts = new Map<string, number>();
    let matchedRows = 0;
    for (const rowData of options.getRows?.() || []) {
      if (!rowMatchesForOptions(rowData, field, filter)) continue;
      matchedRows += 1;
      const value = formatCellValue(rowData?.[field]);
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    const values = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort(compareCategoricalOptions);
    return { options: values, totalUnique: values.length, matchedRows };
  }

  function compareCategoricalOptions(a: CategoricalOption, b: CategoricalOption) {
    if (b.count !== a.count) return b.count - a.count;
    const aBlank = formatCellValue(a.value) === "";
    const bBlank = formatCellValue(b.value) === "";
    if (aBlank !== bBlank) return aBlank ? 1 : -1;
    return categoricalValueLabel(a.value).localeCompare(categoricalValueLabel(b.value), getLocale());
  }

  function rowMatchesForOptions(rowData: Row, optionField: string, optionFilter: DataGridFilter) {
    for (const [field, value] of filters.entries()) {
      const filter = field === optionField ? { ...optionFilter, values: [] } : value;
      if (!match(field, filter, rowData)) return false;
    }
    return true;
  }

  function categoricalValueLabel(value: unknown) {
    return String(value ?? "") || t("empty");
  }

  function predicate(rowData: Row = {}) {
    for (const [field, value] of filters.entries()) {
      if (!match(field, value, rowData)) return false;
    }
    return true;
  }

  function match(field: string, value: unknown, rowData: Row = {}) {
    const filter = normalize(value);
    if (filter.text && !headerMatch(filter.text, rowData?.[field])) return false;
    if (filter.values.length) {
      const expected = new Set(filter.values);
      if (!expected.has(formatCellValue(rowData?.[field]))) return false;
    }
    return true;
  }

  function headerMatch(headerValue: unknown, rowValue: unknown) {
    const query = String(headerValue ?? "").trim();
    if (!query) return true;
    return formatCellValue(rowValue).toLowerCase().includes(query.toLowerCase());
  }

  function activeFilters() {
    return [...filters.entries()]
      .map(([field, value]) => [field, normalize(value)] as const)
      .filter(([, value]) => isActive(value))
      .map(([field, value]) => ({ field, value }));
  }

  return {
    filters,
    normalize,
    get,
    set,
    isActive,
    pruneInactive,
    pruneColumns,
    getCategoricalOptions,
    categoricalValueLabel,
    predicate,
    match,
    headerMatch,
    activeFilters,
    clear: () => filters.clear(),
  };
}
