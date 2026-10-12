import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  const writeMethods = ['insertDataRows', 'updateDataRow', 'deleteDataRows', 'addDataTableColumn', 'deleteDataTableColumn', 'renameDataTableColumn', 'setDataTableColumns'];
  await page.route("**/shared/data-store.js", route => route.fulfill({
    contentType: "text/javascript",
    body: `export * from './data-store.js?actual';
      import * as store from './data-store.js?actual';
      ${writeMethods.map(method => `export const ${method} = (...args) => window.deferDataWrite('${method}', args, store);`).join('\n')}`,
  }));
  await page.route("**/data-grid-vendor.js", route => route.fulfill({
    contentType: "text/javascript",
    body: `export * from './data-grid-vendor.js?actual';
      import { Tabulator as OriginalGrid } from './data-grid-vendor.js?actual';
      export class Tabulator extends OriginalGrid {
        constructor(...args) {
          super(...args);
          window.activeGrid = this;
          window.gridBuilt = new Promise(resolve => this.on('tableBuilt', resolve));
        }
      }`,
  }));
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css"><link rel="stylesheet" href="/extension/capabilities/data/grid-vendor.css">';
    // tableBuilt cannot protect a pointer sequence from a later stylesheet
    // load resizing the grid and replacing its row-header controls.
    await Promise.all([...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.sheet || new Promise((resolve, reject) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', () => reject(new Error(`Stylesheet failed: ${link.href}`)), { once: true });
    })));
    document.querySelector("#app").removeAttribute("data-workspace-booting");
    // Mirror the shell's workspace visibility: Chat consists of separate
    // messages/dock elements, not a .tab-panel.
    document.querySelectorAll(".tab-panel, #messages, #chat-dock, #session-title-bar").forEach(panel => panel.classList.add("hidden"));
    document.querySelector("#data-panel").classList.remove("hidden");
    window.pendingWrites = [];
    window.toasts = [];
    window.dataTraces = [];
    window.deferSchema = false;
    window.deferDataWrite = (method, args, store) => {
      if (method === 'setDataTableColumns' && !window.deferSchema) return store[method](...args);
      return new Promise((resolve, reject) => {
        window.pendingWrites.push({ method, args, complete: () => store[method](...args).then(resolve, reject), reject });
      });
    };
    const store = await import('/extension/shared/data-store.js?actual');
    window.store = store;
    [window.alpha] = await store.insertDataRows('alpha', { value: 'original alpha', category: 'first' });
    [window.beta] = await store.insertDataRows('beta', { value: 'original beta', category: 'second' });
    const { createDataFeature } = await import('/extension/capabilities/data/workspace/data-feature.js');
    window.dataLifetime = new AbortController();
    window.feature = createDataFeature({ root: document, signal: window.dataLifetime.signal, initialTable: 'alpha', isActive: () => true,
      gridTrace: (event, detail) => window.dataTraces.push({ event, detail }),
      showToast: text => window.toasts.push(text),
      confirm: () => new Promise(resolve => { window.confirmDelete = resolve; }),
      requestText: () => new Promise(resolve => { window.confirmText = resolve; }) });
    await window.feature.activate();
    await window.gridBuilt;
  });
  await expect(page.locator('.tabulator-cell').filter({ hasText: 'original alpha' })).toBeVisible();
});

async function switchToBeta(page) {
  await page.evaluate(() => window.feature.openArtifactTable('beta'));
  await expect(page.locator('.tabulator-cell').filter({ hasText: 'original beta' })).toBeVisible();
  await page.evaluate(() => { window.toasts = []; });
}

test('a late insert stays in its original table without replacing the new view', async ({ page }) => {
  await page.locator('#btn-add-data-row').click();
  await expect.poll(() => page.evaluate(() => window.pendingWrites.length)).toBe(1);
  await switchToBeta(page);
  await page.evaluate(() => window.pendingWrites.shift().complete());
  expect(await page.evaluate(async () => (await window.store.queryDataRows({ table: 'alpha' })).rows.length)).toBe(2);
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  await expect(page.locator('.tabulator-cell').filter({ hasText: 'original beta' })).toBeVisible();
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

test('row checkboxes keep native focus without changing cell ranges', async ({ page }) => {
  const row = page.locator('.data-grid-row-check').first();
  const all = page.locator('.data-grid-row-check-all');
  const remove = page.locator('#btn-delete-data-rows');
  const rangeCount = () => page.evaluate(() => window.activeGrid.getRanges().length);
  expect(await rangeCount()).toBe(0);
  await row.check();
  await expect(row).toBeChecked();
  await expect(row).toBeFocused();
  await expect(remove).toBeEnabled();
  expect(await rangeCount()).toBe(0);
  await row.uncheck();
  await expect(row).not.toBeChecked();
  await expect(remove).toBeDisabled();
  await all.check();
  await expect(row).toBeChecked();
  await expect(all).toBeFocused();
  await expect(remove).toBeEnabled();
  expect(await rangeCount()).toBe(0);
  await all.uncheck();
  await expect(row).not.toBeChecked();
  await expect(remove).toBeDisabled();
  await row.focus();
  await page.keyboard.press('Space');
  await expect(row).toBeChecked();
  await expect(remove).toBeEnabled();
  expect(await rangeCount()).toBe(0);
  await page.locator('.tabulator-cell').filter({ hasText: 'original alpha' }).click();
  expect(await rangeCount()).toBe(1);
  await expect(row).toBeChecked();
});

test('delete confirmation keeps the selected table even after navigation', async ({ page }) => {
  await page.locator('.data-grid-row-check').first().check();
  await page.locator('#btn-delete-data-rows').click();
  await switchToBeta(page);
  await page.evaluate(() => window.confirmDelete(true));
  await expect.poll(() => page.evaluate(() => window.pendingWrites.length)).toBe(1);
  expect(await page.evaluate(() => window.pendingWrites[0].args[1].table)).toBe('alpha');
  await page.evaluate(() => window.pendingWrites.shift().complete());
  expect(await page.evaluate(async () => (await window.store.queryDataRows({ table: 'alpha' })).rows.length)).toBe(0);
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

for (const succeeds of [true, false]) test(`late cell write ${succeeds ? 'success' : 'failure'} leaves the replacement grid untouched`, async ({ page }) => {
  await page.evaluate(() => window.activeGrid.getRow(window.alpha.id).getCell('value').setValue('changed alpha'));
  await expect.poll(() => page.evaluate(() => window.pendingWrites.length)).toBe(1);
  await switchToBeta(page);
  await page.evaluate(async succeeds => {
    const pending = window.pendingWrites.shift();
    if (succeeds) await pending.complete(); else pending.reject(new Error('expected write failure'));
  }, succeeds);
  await expect(page.locator('.tabulator-cell').filter({ hasText: 'original beta' })).toBeVisible();
  expect(await page.evaluate(() => window.activeGrid.getData().map(row => row.value))).toEqual(['original beta']);
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

async function openColumns(page) {
  if (!await page.locator('#data-columns-menu').isVisible()) await page.locator('#btn-data-columns').click();
}

async function expectWrite(page, method, table) {
  await expect.poll(() => page.evaluate(method => window.pendingWrites.filter(write => write.method === method).length, method)).toBe(1);
  expect(await page.evaluate(method => window.pendingWrites.find(write => write.method === method).args[0], method)).toBe(table);
}

async function finishWrite(page, method, succeeds = true) {
  const refreshes = await page.evaluate(() => window.dataTraces.filter(trace => trace.event === 'column_schema cache_refresh').length);
  await page.evaluate(async ({ method, succeeds }) => {
    const index = window.pendingWrites.findIndex(write => write.method === method);
    const [pending] = window.pendingWrites.splice(index, 1);
    if (succeeds) await pending.complete(); else pending.reject(new Error('expected column write failure'));
  }, { method, succeeds });
  if (succeeds && method !== 'setDataTableColumns') {
    await expect.poll(() => page.evaluate(() => window.dataTraces.filter(trace => trace.event === 'column_schema cache_refresh').length)).toBeGreaterThan(refreshes);
  }
}

async function changeColumnVisibility(page, field, checked) {
  await page.evaluate(({ field, checked }) => {
    const input = document.querySelector(`[data-column-field="${field}"] input[type="checkbox"]`);
    input.checked = checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { field, checked });
}

async function pauseSchemaClock(page) {
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
  await page.evaluate(() => { window.deferSchema = true; });
}

test('an add-column prompt keeps its original table after navigation', async ({ page }) => {
  await openColumns(page);
  await page.locator('[data-column-add]').click();
  await expect.poll(() => page.evaluate(() => typeof window.confirmText)).toBe('function');
  await switchToBeta(page);
  await page.evaluate(() => window.confirmText('alpha_only'));
  await expectWrite(page, 'addDataTableColumn', 'alpha');
  await finishWrite(page, 'addDataTableColumn');
  expect(await page.evaluate(() => window.store.getDataTableColumns('alpha'))).toContain('alpha_only');
  expect(await page.evaluate(() => window.store.getDataTableColumns('beta'))).not.toContain('alpha_only');
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  await expect(page.locator('[data-column-field="alpha_only"]')).toHaveCount(0);
  await expect(page.locator('.tabulator-cell').filter({ hasText: 'original beta' })).toBeVisible();
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

test('adding a column reveals it in the reloaded current table', async ({ page }) => {
  // Fill the default visibility limit so this exercises explicit reveal, not
  // the ordinary inclusion of a new field while spare column slots remain.
  await page.evaluate(async () => {
    await window.store.setDataTableColumns('alpha', ['value', 'category', ...Array.from({ length: 22 }, (_, i) => `field_${i}`)]);
    await window.feature.openArtifactTable('alpha');
    await window.gridBuilt;
  });
  await openColumns(page);
  await page.locator('[data-column-add]').click();
  await page.evaluate(() => window.confirmText('notes'));
  await expectWrite(page, 'addDataTableColumn', 'alpha');
  await finishWrite(page, 'addDataTableColumn');
  expect(await page.evaluate(() => window.store.getDataTableColumns('alpha'))).toContain('notes');
  await expect(page.locator('[data-column-field="notes"] input[type="checkbox"]')).toBeChecked();
  await expect(page.locator('.tabulator-col[tabulator-field="notes"]')).toBeVisible();
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('alpha');
});

test('a delete-column confirmation cannot delete the replacement table column', async ({ page }) => {
  await openColumns(page);
  await page.locator('[data-column-field="value"]').hover();
  await page.locator('[data-column-action="delete"][data-column="value"]').click();
  await expect.poll(() => page.evaluate(() => typeof window.confirmDelete)).toBe('function');
  await switchToBeta(page);
  await page.evaluate(() => window.confirmDelete(true));
  await expectWrite(page, 'deleteDataTableColumn', 'alpha');
  await finishWrite(page, 'deleteDataTableColumn');
  expect(await page.evaluate(() => window.store.getDataTableColumns('alpha'))).not.toContain('value');
  expect(await page.evaluate(async () => (await window.store.queryDataRows({ table: 'alpha' })).rows[0].data)).not.toHaveProperty('value');
  expect(await page.evaluate(() => window.store.getDataTableColumns('beta'))).toContain('value');
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  await expect(page.locator('.tabulator-cell').filter({ hasText: 'original beta' })).toBeVisible();
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

for (const succeeds of [true, false]) test(`late column rename ${succeeds ? 'success' : 'failure'} preserves a new-table edit and allows recovery`, async ({ page }) => {
  await openColumns(page);
  await page.locator('[data-column-field="value"]').hover();
  await page.locator('[data-column-action="rename"][data-column="value"]').click();
  await page.locator('[data-column-rename-input]').fill('alpha_value');
  await page.locator('[data-column-rename-input]').press('Enter');
  await expectWrite(page, 'renameDataTableColumn', 'alpha');
  await switchToBeta(page);
  await openColumns(page);
  await page.locator('[data-column-field="value"]').hover();
  await page.locator('[data-column-action="rename"][data-column="value"]').click();
  await page.locator('[data-column-rename-input]').fill('beta_value');
  await finishWrite(page, 'renameDataTableColumn', succeeds);
  await expect(page.locator('[data-column-rename-input]')).toHaveValue('beta_value');
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  expect(await page.evaluate(() => window.store.getDataTableColumns('alpha'))).toContain(succeeds ? 'alpha_value' : 'value');
  expect(await page.evaluate(() => window.store.getDataTableColumns('beta'))).toContain('value');
  expect(await page.evaluate(() => window.activeGrid.getData().map(row => row.value))).toEqual(['original beta']);
  expect(await page.evaluate(() => window.toasts)).toEqual([]);

  await page.locator('[data-column-rename-input]').press('Enter');
  await expectWrite(page, 'renameDataTableColumn', 'beta');
  await finishWrite(page, 'renameDataTableColumn');
  await expect.poll(() => page.evaluate(() => window.activeGrid.getData().map(row => row.beta_value))).toEqual(['original beta']);
  await expect(page.locator('[data-column-field="beta_value"] input[type="checkbox"]')).toBeChecked();
  await expect(page.locator('.tabulator-col[tabulator-field="beta_value"]')).toBeVisible();
  expect(await page.evaluate(() => window.store.getDataTableColumns('beta'))).toContain('beta_value');
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

test('schema debounce retains independent writes for two tables during a fast switch', async ({ page }) => {
  await pauseSchemaClock(page);
  await changeColumnVisibility(page, 'value', false);
  await page.evaluate(() => window.feature.openArtifactTable('beta'));
  await changeColumnVisibility(page, 'category', false);
  expect(await page.evaluate(() => window.pendingWrites.length)).toBe(0);
  await page.clock.runFor(451);
  expect(await page.evaluate(() => window.pendingWrites.map(write => [write.method, write.args[0]]))).toEqual([
    ['setDataTableColumns', 'alpha'], ['setDataTableColumns', 'beta'],
  ]);
  await page.evaluate(async () => {
    // Complete the new view first, then let the old table write arrive late.
    await window.pendingWrites.pop().complete();
    await window.pendingWrites.pop().complete();
  });
  const tables = await page.evaluate(() => window.store.listDataTables());
  expect(tables.find(table => table.name === 'alpha').columnMeta.value.hidden).toBe(true);
  expect(tables.find(table => table.name === 'beta').columnMeta.category.hidden).toBe(true);
  expect(tables.find(table => table.name === 'beta').columnMeta.value?.hidden).not.toBe(true);
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  await expect(page.locator('[data-column-field="category"] input[type="checkbox"]')).not.toBeChecked();
  await expect(page.locator('[data-column-field="value"] input[type="checkbox"]')).toBeChecked();
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

test('an older schema response cannot overwrite a newer same-table draft', async ({ page }) => {
  await pauseSchemaClock(page);
  await changeColumnVisibility(page, 'value', false);
  await page.clock.runFor(451);
  await expectWrite(page, 'setDataTableColumns', 'alpha');
  await changeColumnVisibility(page, 'category', false);
  await finishWrite(page, 'setDataTableColumns');
  // A third edit must start from the latest draft, not the first response.
  await changeColumnVisibility(page, 'value', true);
  await page.clock.runFor(451);
  await expectWrite(page, 'setDataTableColumns', 'alpha');
  expect(await page.evaluate(() => window.pendingWrites[0].args[2].columnMeta)).toMatchObject({
    value: { hidden: false }, category: { hidden: true },
  });
  await finishWrite(page, 'setDataTableColumns');
  const savedMeta = await page.evaluate(async () => (await window.store.listDataTables()).find(table => table.name === 'alpha').columnMeta);
  expect(savedMeta.category.hidden).toBe(true);
  expect(savedMeta.value?.hidden).not.toBe(true);
  await changeColumnVisibility(page, 'category', true);
  await page.clock.runFor(451);
  await finishWrite(page, 'setDataTableColumns');
  expect(await page.evaluate(async () => (await window.store.listDataTables()).find(table => table.name === 'alpha').columnMeta.category?.hidden)).not.toBe(true);
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});

test('a previous-table column write refreshes the list without losing the new table schema draft', async ({ page }) => {
  await openColumns(page);
  await page.locator('[data-column-add]').click();
  await page.evaluate(() => window.confirmText('alpha_only'));
  await expectWrite(page, 'addDataTableColumn', 'alpha');
  await switchToBeta(page);
  await pauseSchemaClock(page);
  await changeColumnVisibility(page, 'category', false);
  await finishWrite(page, 'addDataTableColumn');
  expect(await page.evaluate(() => window.store.getDataTableColumns('alpha'))).toContain('alpha_only');
  await changeColumnVisibility(page, 'value', false);
  await page.clock.runFor(451);
  await expectWrite(page, 'setDataTableColumns', 'beta');
  expect(await page.evaluate(() => window.pendingWrites[0].args[2].columnMeta)).toMatchObject({
    value: { hidden: true }, category: { hidden: true },
  });
  await finishWrite(page, 'setDataTableColumns');
  expect(await page.evaluate(async () => (await window.store.listDataTables()).find(table => table.name === 'beta').columnMeta)).toMatchObject({
    value: { hidden: true }, category: { hidden: true },
  });
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
});


test('disposing the Data capability removes listeners and ignores a late write before remount', async ({ page }) => {
  await page.locator('#btn-add-data-row').click();
  await expect.poll(() => page.evaluate(() => window.pendingWrites.length)).toBe(1);
  await page.evaluate(async () => {
    window.dataLifetime.abort();
    document.querySelector('#btn-add-data-row').click();
    const { createDataFeature } = await import('/extension/capabilities/data/workspace/data-feature.js');
    window.dataLifetime = new AbortController();
    window.feature = createDataFeature({ root: document, signal: window.dataLifetime.signal,
      initialTable: 'beta', isActive: () => true, showToast: text => window.toasts.push(text) });
    await window.feature.activate();
    await window.gridBuilt;
  });
  expect(await page.evaluate(() => window.pendingWrites.length)).toBe(1);
  await expect(page.locator('.tabulator-cell').filter({ hasText: 'original beta' })).toBeVisible();
  await page.evaluate(() => window.pendingWrites.shift().complete());
  await expect.poll(() => page.evaluate(async () => (await window.store.queryDataRows({ table: 'alpha' })).rows.length)).toBe(2);
  expect(await page.evaluate(() => window.feature.getCurrentTable())).toBe('beta');
  expect(await page.evaluate(() => window.toasts)).toEqual([]);
  await page.locator('#btn-add-data-row').click();
  await expect.poll(() => page.evaluate(() => window.pendingWrites.length)).toBe(1);
  expect(await page.evaluate(() => window.pendingWrites[0].args[0])).toBe('beta');
  await page.evaluate(() => window.pendingWrites.shift().complete());
});
