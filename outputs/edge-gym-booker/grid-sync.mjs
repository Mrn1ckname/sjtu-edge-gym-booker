const trackers = new WeakMap();
export class GridNotReadyError extends Error {}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function gridTracker(page, record = () => {}) {
  if (trackers.has(page)) return trackers.get(page);
  let sequence = 0, generation = 0, changed = Date.now(), latest = null;
  const pending = new Map(), entries = new WeakMap();
  const reset = () => { generation++; pending.clear(); latest = null; changed = Date.now(); };
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) reset();
    const pathname = new URL(request.url()).pathname;
    if (!/\/queryFieldSituation$|\/queryFieldReserveSituationIsFull$/.test(pathname)) return;
    let body = {};
    try { body = request.postDataJSON() || {}; } catch {}
    const entry = { id: ++sequence, generation, kind: pathname.endsWith('/queryFieldSituation') ? 'grid' : 'dates',
      date: body.date, fieldType: body.fieldType ?? body.feildType, venueId: body.venueId ?? body.id, started: Date.now() };
    entries.set(request, entry); pending.set(entry.id, entry); changed = Date.now();
    record('grid-request', { ...entry });
  });
  page.on('requestfailed', request => {
    const entry = entries.get(request);
    if (!entry || entry.generation !== generation) return;
    pending.delete(entry.id); changed = Date.now();
    record('grid-request-failed', { id: entry.id, date: entry.date, error: request.failure()?.errorText });
  });
  page.on('response', response => {
    const entry = entries.get(response.request());
    if (!entry) return;
    void (async () => {
      try {
        const body = await response.json();
        if (entry.generation !== generation) return;
        entry.code = body.code; entry.httpStatus = response.status();
        entry.courts = Array.isArray(body.data) ? body.data.map(court => ({
          name: court.fieldName, slots: Array.isArray(court.priceList) ? court.priceList.map(slot => ({
            status: slot.status, count: slot.count
          })) : []
        })) : [];
        if (entry.kind === 'grid' && (!latest || entry.id > latest.id)) latest = entry;
        record('grid-response', { id: entry.id, date: entry.date, fieldType: entry.fieldType,
          code: entry.code, httpStatus: entry.httpStatus, elapsedMs: Date.now() - entry.started, courts: entry.courts });
      } catch (error) {
        if (entry.generation === generation) record('grid-response-error', { id: entry.id, error: error.message });
      } finally {
        if (entry.generation === generation) { pending.delete(entry.id); changed = Date.now(); }
      }
    })();
  });
  async function idle(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pending.size && Date.now() - changed >= 150) return;
      await sleep(100);
    }
    record('grid-idle-timeout', { pending: [...pending.values()].map(({ id, date, kind }) => ({ id, date, kind })) });
    throw new GridNotReadyError('场地或日期列表接口尚未完成，保留当前页面等待下一轮');
  }
  async function ready(config, after = 0, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let previous = '', stableSince = Date.now();
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        return {
          tabs: [...document.querySelectorAll('.el-tabs__item.is-active, [role="tab"][aria-selected="true"]')].map(el => ({ id: el.id, text: el.innerText.trim() })),
          summary: document.querySelector('.drawerText h2')?.innerText || '',
          loading: [...document.querySelectorAll('.el-loading-mask')].some(visible),
          cells: [...document.querySelectorAll('.inner-seat-wrapper .seat .inner-seat')].map(el => ({ cls: el.className, count: el.querySelector('i')?.innerText || '' }))
        };
      });
      const response = latest;
      const activity = state.tabs.find(tab => tab.text === config.activityType);
      const matching = response && response.id > after && response.date === config.targetDate &&
        response.fieldType === activity?.id.replace(/^tab-/, '') &&
        String(response.code) === '0' && response.httpStatus === 200;
      let cellsMatch = false;
      if (matching && response.courts.length && response.courts.every(c => c.slots.length === response.courts[0].slots.length)) {
        const expected = response.courts[0].slots.flatMap((_, row) => response.courts.map(c => c.slots[row]));
        cellsMatch = expected.length === state.cells.length && expected.every((slot, index) => {
          const cls = [-2, -1, -3].includes(Number(slot.status)) ? 'bought-seat' : Number(slot.status) === 1 ? 'selected-seat' : 'unselected-seat';
          return state.cells[index].cls.split(/\s+/).includes(cls) &&
            (Number(slot.status) !== 0 || slot.count == null || String(slot.count) === state.cells[index].count);
        });
      }
      const valid = matching && cellsMatch && !state.loading && !pending.size &&
        state.tabs.some(tab => tab.id === `tab-${config.targetDate}`) && state.summary.includes(config.targetDate);
      const signature = JSON.stringify({ responseId: response?.id, state });
      if (!valid || signature !== previous) stableSince = Date.now();
      previous = signature;
      if (valid && Date.now() - stableSince >= 300) {
        record('grid-ready', { responseId: response.id, date: response.date, activity: config.activityType,
          stableMs: Date.now() - stableSince, targetSlots: config.timeSlots.map(slot => {
            const row = Number(slot.slice(0, 2)) - 7;
            return { slot, courts: response.courts.map(c => ({ name: c.name, ...c.slots[row] })) };
          }) });
        return response.id;
      }
      await sleep(100);
    }
    record('grid-not-ready', { targetDate: config.targetDate, latestDate: latest?.date, responseId: latest?.id, pending: pending.size });
    throw new GridNotReadyError('目标日期的接口数据与页面网格尚未一致，不判定为无名额');
  }
  const tracker = { idle, ready, get sequence() { return sequence; } };
  trackers.set(page, tracker);
  return tracker;
}
