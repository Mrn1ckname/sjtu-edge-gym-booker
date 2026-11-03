import fs from 'node:fs';
import path from 'node:path';

export function createDiagnostics(file) {
  let sequence = 0;
  let target = null, attempt = 0, previousScreenshot = '', screenshotAt = 0;
  const pending = new Set();
  const clean = value => String(value ?? '').replace(/((?:token|password|authorization|cookie|ticket|sessionid)\s*[:=]\s*)[^\s,;&]+/ig, '$1[redacted]').slice(0, 4000);
  const safeUrl = value => {
    try { const u = new URL(value); return u.origin + u.pathname; } catch { return ''; }
  };
  function record(event, details = {}) {
    if (event === 'attempt-start') attempt = details.attempt;
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), attempt, event, ...details }) + '\n');
  }
  function attach(context) {
    const started = new WeakMap();
    context.on('request', request => {
      if (!['xhr', 'fetch'].includes(request.resourceType())) return;
      const entry = { id: ++sequence, url: safeUrl(request.url()), method: request.method(), start: Date.now() };
      started.set(request, entry);
      record('request', entry); // 不记录请求头、Cookie 或请求体。
    });
    context.on('requestfailed', request => {
      const entry = started.get(request);
      if (entry) record('request-failed', { ...entry, elapsedMs: Date.now() - entry.start, error: clean(request.failure()?.errorText) });
    });
    context.on('response', response => {
      const entry = started.get(response.request());
      if (!entry) return;
      record('response', { ...entry, status: response.status(), elapsedMs: Date.now() - entry.start });
      if (new URL(response.url()).hostname !== 'sports.sjtu.edu.cn') return;
      const job = response.json().then(body => {
        record('response-result', { id: entry.id, code: clean(body?.code), message: clean(body?.message ?? body?.msg) });
      }).catch(() => {});
      pending.add(job);
      void job.finally(() => pending.delete(job));
    });
    const attachPage = page => {
      page.on('pageerror', error => record('page-error', { message: clean(error.message) }));
      page.on('console', message => {
        if (message.type() === 'error') record('console-error', { message: clean(message.text()) });
      });
    };
    context.pages().forEach(attachPage);
    context.on('page', attachPage);
  }
  async function snapshot(page, phase, { captureImage = true } = {}) {
    try {
      const state = await page.evaluate(timeSlots => ({
        activeTabs: [...document.querySelectorAll('[role="tab"][aria-selected="true"], .el-tabs__item.is-active')].map(el => ({ id: el.id, text: el.innerText })),
        selectedSeats: document.querySelectorAll('.selected-seat').length,
        summary: document.querySelector('.drawerText')?.innerText || '',
        loading: [...document.querySelectorAll('.el-loading-mask')].some(el => !!(el.offsetWidth || el.offsetHeight)),
        targetCells: timeSlots.flatMap(slot => {
          const wrapper = document.querySelector('.inner-seat-wrapper');
          const headers = [...(wrapper?.querySelectorAll('.topsiteStyle') || [])];
          const seats = [...(wrapper?.querySelectorAll('.seat') || [])];
          const row = Number(slot.slice(0, 2)) - 7;
          return headers.map((header, column) => {
            const seat = seats[row * headers.length + column]?.querySelector('.inner-seat');
            return { slot, court: header.textContent.trim(), row, column, className: seat?.className, count: seat?.querySelector('i')?.textContent };
          });
        }),
        text: (document.body?.innerText || '').split('场馆设施')[0].slice(0, 3000)
      }), target?.timeSlots || []);
      const key = JSON.stringify({ tabs: state.activeTabs, cells: state.targetCells, loading: state.loading });
      let screenshot = null;
      if (captureImage && (key !== previousScreenshot || Date.now() - screenshotAt > 30000 || /submit|order/.test(phase))) {
        screenshot = path.join(path.dirname(file), `${path.basename(file, '.jsonl')}-${++sequence}-${phase}.png`);
        const grid = page.locator('.inner-seat-wrapper');
        if (await grid.isVisible()) await grid.screenshot({ path: screenshot, timeout: 3000 });
        else await page.screenshot({ path: screenshot, fullPage: false, timeout: 3000 });
        previousScreenshot = key; screenshotAt = Date.now();
      }
      record('snapshot', { phase, url: safeUrl(page.url()), ...state, text: clean(state.text), screenshot, captureImage });
    } catch (error) { record('snapshot-error', { phase, error: clean(error.message) }); }
  }
  return { record, attach, snapshot, setTarget(config) { target = config; } };
}
