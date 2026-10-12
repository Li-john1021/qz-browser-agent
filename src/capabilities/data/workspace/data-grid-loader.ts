let pending: Promise<typeof import("./data-grid-vendor.js")> | undefined;

/** Share concurrent loads. Browser module failures require reopening the panel to clear its cache. */
export function loadDataGrid() {
  return pending ||= import("./data-grid-vendor.js").catch(error => {
    pending = undefined;
    throw error;
  });
}
