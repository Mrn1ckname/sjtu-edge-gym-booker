import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { observeOrderSubmission, waitForPaymentInterface } from './booker.mjs';

const request = () => ({ url: () => 'https://sports.sjtu.edu.cn/venue/personal/ConfirmOrder', method: () => 'POST' });
const response = (req, code) => ({ request: () => req, ok: () => true, status: () => 200,
  json: async () => ({ code, msg: code === 888 ? '场地预定人数已满' : '场地1 已被预定，请重新选择时段。' }) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fakePage() {
  return Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'https://sports.sjtu.edu.cn/pc/',
    locator: () => ({ innerText: async () => '立即下单' }), getByText: () => ({ count: async () => 0 }) });
}
for (const code of [888, 500]) test(`业务码 ${code} 即使页面无错误提示也立即终止支付等待`, async () => {
  const page = fakePage(), observer = observeOrderSubmission(page), req = request();
  page.emit('request', req);
  page.emit('response', response(req, code));
  await tick();
  const started = Date.now();
  const result = await waitForPaymentInterface({ pages: () => [page] }, page, 90000, observer);
  assert.equal(result.outcome, 'submit-error');
  assert.ok(result.message.includes(code === 888 ? '人数已满' : '已被预定'));
  assert.ok(Date.now() - started < 1000);
  observer.close();
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
});
test('忽略旧请求和监听结束后的迟到响应', async () => {
  const page = fakePage(), old = request(), observer = observeOrderSubmission(page);
  page.emit('response', response(old, 500));
  await tick();
  assert.equal(observer.result, null);
  const req = request(); page.emit('request', req);
  page.emit('response', response(req, 500));
  observer.close();
  await tick();
  assert.equal(observer.result, null);
});
test('接口成功与没有订单证据的超时分别归类', async () => {
  const page = fakePage(), observer = observeOrderSubmission(page), req = request();
  const context = { pages: () => [page] };
  assert.equal((await waitForPaymentInterface(context, page, 0, observer)).outcome, 'submission-unknown');
  page.emit('request', req); page.emit('response', response(req, 0)); await tick();
  assert.equal(observer.result.outcome, 'order-confirmed');
  assert.equal((await waitForPaymentInterface(context, page, 0, observer)).outcome, 'payment-timeout');
  observer.close();
});
