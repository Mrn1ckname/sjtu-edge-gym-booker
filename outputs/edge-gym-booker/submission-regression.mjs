import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { submitOrder, dismissBookingNotice, waitForPaymentInterface, isRetryableBeforeSubmission } from './booker.mjs';

// 所有网络请求均在本地拦截；不使用个人配置或登录文件。
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
let code = 888, message = '场地预定人数已满', submitted = 0;
await context.route('**/*', async route => {
  if (new URL(route.request().url()).pathname === '/venue/personal/ConfirmOrder') {
    submitted++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code, msg: message }) });
  } else await route.fulfill({ contentType: 'text/html', body: '<body></body>' });
});
const page = await context.newPage();
const config = { targetDate: '2026-11-09', dryRun: false, paymentTimeoutMs: 90000 };
const picks = [{ courtName: '场地1', slot: '17:00-18:00' }];
async function fixture(checked = true) {
  await page.goto('https://sports.sjtu.edu.cn/fixture');
  await page.setContent(`<div role="tab" aria-selected="true" id="tab-2026-11-09">11月9日</div>
    <div>2026-11-09 场地1 17:00-18:00</div><button id="order">立即下单</button>
    <div class="el-dialog" style="display:none;position:fixed;inset:0;background:white">
    本人已认真阅读<label class="el-checkbox"><input type="checkbox" ${checked ? 'checked' : ''}>同意</label>
    <button id="back">上一步</button><button id="submit">提交订单</button></div>`);
  await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog');
    document.querySelector('#order').onclick = () => dialog.style.display = 'block';
    document.querySelector('#back').onclick = () => dialog.style.display = 'none';
    document.querySelector('#submit').onclick = async () => {
      if (!document.querySelector('input').checked) return;
      const body = await fetch('/venue/personal/ConfirmOrder', { method: 'POST' }).then(r => r.json());
      // 模拟不显示错误提示、弹窗仍保留，后端拒绝只能靠响应判断。
      if (body.code === 0) document.body.innerHTML = '<div>收银台 微信支付</div><button id="pay">确认付款</button>';
    };
  });
}
try {
  for (const [nextCode, nextMessage, checked] of [[888, '场地预定人数已满', true], [500, '场地1 已被预定，请重新选择时段。', false]]) {
    code = nextCode; message = nextMessage;
    await fixture(checked);
    const started = Date.now();
    const before = page.listenerCount('response');
    await assert.rejects(() => submitOrder(context, page, config, picks), e => isRetryableBeforeSubmission(e) && e.message.includes(nextMessage));
    assert.ok(Date.now() - started < 5000, '明确拒绝不应等待90秒');
    assert.equal(page.listenerCount('response'), before, '监听器必须清理');
    assert.equal(await page.locator('input').isChecked(), true);
    await dismissBookingNotice(page);
    assert.equal(await page.locator('.el-dialog').isVisible(), false);
    await page.getByRole('tab').click();
  }
  code = 0; message = '操作成功';
  await fixture();
  assert.equal((await submitOrder(context, page, config, picks)).outcome, 'payment-ready');
  assert.equal(submitted, 3);
  assert.equal(await page.locator('#pay').count(), 1);
  await page.setContent('<div>只有预约页面，无订单证据</div>');
  assert.equal((await waitForPaymentInterface(context, page, 100)).outcome, 'submission-unknown');
  console.log('通过：888/500快速重试、已勾选与未勾选、弹窗清理、成功到支付页、未知结果分类、监听器清理。');
} finally { await browser.close(); }
