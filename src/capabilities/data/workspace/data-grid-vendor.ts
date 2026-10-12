import { SelectRangeModule, TabulatorFull } from "tabulator-tables";

class DataGridSelectRange extends SelectRangeModule {
  // Tabulator 6.5.2 uses this hook only to warn about header sorting with column selection.
  initializeColumn() {}
}

TabulatorFull.registerModule(DataGridSelectRange);

/** The Tabulator surface used by the adapter; no vendor internals escape this boundary. */
export interface GridRecord extends Record<string, unknown> { _rowId: string; createdAt: string; updatedAt: string }
export interface GridColumn { getField(): string; getElement(): HTMLElement; getWidth(): number; move(target: GridColumn, after: boolean): void }
export interface GridRow {
  getData(): GridRecord; getElement(): HTMLElement; getCell(field: string): GridCell | false;
  update(data: GridRecord): Promise<void>;
}
export interface GridCell {
  getValue(): unknown; getField(): string; getRow(): GridRow; getColumn(): GridColumn;
  getElement(): HTMLElement; restoreOldValue(): void;
}
export interface GridSorter { field?: string; column: string | GridColumn; dir: "asc" | "desc" }
interface GridEvents {
  cellClick: [MouseEvent, GridCell]; cellDblClick: [MouseEvent, GridCell]; cellEditing: [GridCell]; cellEdited: [GridCell];
  dataSorted: [GridSorter[]]; dataSorting: []; columnMoved: []; columnResized: []; tableBuilt: []; renderComplete: [];
  dataFiltered: []; rangeAdded: []; rangeChanged: []; rangeRemoved: []; scrollVertical: []; scrollHorizontal: [];
}
export interface GridInstance {
  getColumns(): GridColumn[]; getSorters(): GridSorter[]; getRows(scope?: string): GridRow[];
  getRow(id: string): GridRow | false;
  getRanges(): { getStructuredCells(): GridCell[][] }[];
  replaceData(rows: GridRecord[]): Promise<void>; setHeight(height: string): void; redraw(force?: boolean): void;
  destroy(): void; clearFilter(): void; setFilter(predicate: (row: GridRecord) => boolean): void;
  scrollToRow(id: string, position: string, ifVisible: boolean): Promise<void>;
  on<K extends keyof GridEvents>(event: K, callback: (...args: GridEvents[K]) => unknown): void;
  modules?: { selectRange?: { layoutElement?(force: boolean): void; layoutRanges?(): void } };
}
export interface GridConstructor { new(element: HTMLElement, options: Record<string, unknown>): GridInstance }

export const Tabulator = TabulatorFull as unknown as GridConstructor;
