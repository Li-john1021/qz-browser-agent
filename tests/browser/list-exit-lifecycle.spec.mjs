import { expect, test } from './fixtures.mjs';
import { installBenchmarkChromeStub } from './benchmark-chrome-stub.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false });
  await page.goto('/tests/git-skill-source/probe.html');
  await page.addStyleTag({ url: '/extension/sidepanel/sidepanel.css' });
  await page.evaluate(async () => {
    const html = await fetch('/extension/sidepanel/sidepanel.html').then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    document.querySelector('#app').removeAttribute('data-workspace-booting');
    document.querySelectorAll('.tab-panel, #messages, #chat-dock').forEach(element => element.classList.add('hidden'));
    document.querySelector('#sessions-panel').classList.remove('hidden');
    const { createSessionsFeature } = await import('/extension/capabilities/sessions/sessions-feature.js');
    const { createAutomationsFeature } = await import('/extension/capabilities/sessions/automations/automations-feature.js');
    const { createSessionState, isSessionRuntimeActive } = await import('/extension/sidepanel/features/sessions/session-state.js');
    window.sessionRecords = [{ id: 'original', title: 'Original session' }];
    window.automationRecords = [{ id: 'original', title: 'Original automation', instruction: 'Read a page' }];
    const request = async type => {
      if (type === 'list_automations') return { automations: window.automationRecords, runs: {} };
      if (type === 'delete_automation') { window.automationRecords = []; return {}; }
      return { sessions: window.sessionRecords };
    };
    const sessionState = createSessionState();
    window.sessions = createSessionsFeature({
      root: document, request, isActive: () => true, sessionState,
      getRuntime: id => sessionState.getRuntime(id), isRuntimeRunning: isSessionRuntimeActive,
      artifactsFeature: { scheduleSummaryBackfill() {}, scheduleListHydration() {}, getSummaryFromRecord: () => ({}), renderSessionChip: () => '' },
      sessionExportFeature: { isPreparing: () => false },
    });
    window.automations = createAutomationsFeature({
      root: document, request, isActive: () => true, confirm: async () => true,
      morphListHtml: window.sessions.morphListHtml, listItemKey: window.sessions.listItemKey,
    });
    window.setSessionRecords = async records => {
      window.sessionRecords = records;
      await chrome.storage.local.set({ _sessions: Object.fromEntries(records.map(record => [record.id, record])) });
      await window.sessions.renderNow();
    };
    await window.setSessionRecords(window.sessionRecords);
    await window.automations.renderNow();
    window.automations.setVisible(true);
    window.exitAnimations = [];
    window.exitCompletions = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function(...args) {
      const animation = animate.apply(this, args);
      if (this.matches('.session-tree-node-final-exit, .automation-card-final-exit')) {
        animation.pause();
        window.exitAnimations.push(animation);
        window.exitCompletions.push(animation.finished.catch(() => {}));
      }
      return animation;
    };
  });
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
});

for (const kind of ['sessions', 'automations']) {
  for (const reset of [false, true]) {
    test(`${kind}: ${reset ? 'reset and refill' : 'refill'} revokes an unfinished empty transition`, async ({ page }) => {
      await page.evaluate(async kind => {
        if (kind === 'sessions') await window.setSessionRecords([]);
        else document.querySelector('[data-automation-action="delete"]').click();
      }, kind);
      const selector = kind === 'sessions' ? '.session-tree-node-final-exit' : '.automation-card-final-exit';
      await expect(page.locator(selector)).toHaveCount(1);
      const timing = await page.evaluate(() => window.exitAnimations[0].effect.getTiming());
      expect(timing.duration).toBe(kind === 'sessions' ? 260 : 160);
      expect(timing.easing).toBe(kind === 'sessions' ? 'cubic-bezier(0.16, 1, 0.3, 1)' : 'linear');
      await page.evaluate(async ({ kind, reset }) => {
        if (reset) window[kind].reset();
        if (kind === 'sessions') await window.setSessionRecords([{ id: 'replacement', title: 'Replacement session' }]);
        else {
          window.automationRecords = [{ id: 'replacement', title: 'Replacement automation', instruction: 'Read another page' }];
          await window.automations.renderNow();
        }
        await window.exitCompletions[0];
      }, { kind, reset });
      await page.clock.fastForward(1000);
      const replacement = kind === 'sessions' ? '.session-card[data-id="replacement"]' : '.automation-card[data-automation-id="replacement"]';
      await expect(page.locator(replacement)).toHaveCount(1);
      await expect(page.locator(selector)).toHaveCount(0);
      await expect(page.locator(kind === 'sessions' ? '#sessions-list .sessions-empty' : '#automations-list .automation-empty')).toHaveCount(0);
    });
  }
}

for (const colorScheme of ['light', 'dark']) {
  test(`session action icon replaces its SVG geometry on status changes (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
    const action = page.locator('.session-card[data-id="original"] .session-card-actions > button:last-child');
    for (const status of ['running', 'interrupted', 'running', 'aborted', 'running', 'completed']) {
      await page.evaluate(async status => {
        await window.setSessionRecords([{ id: 'original', title: 'Original session', status, running: status === 'running' }]);
        await window.sessions.renderNow({ requestFreshState: true });
      }, status);
      const running = status === 'running';
      await expect(action).toHaveAttribute('data-session-action', running ? 'stop' : 'delete');
      await expect(action.locator('svg > *')).toHaveCount(1);
      await expect(action.locator(running ? 'svg > rect' : 'svg > path')).toHaveCount(1);
    }
  });
}
