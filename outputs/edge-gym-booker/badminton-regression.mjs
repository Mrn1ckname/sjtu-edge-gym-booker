import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { attemptBooking, isRetryableBeforeSubmission } from './booker.mjs';
import { gridTracker } from './grid-sync.mjs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
let documents = 0, targetRequests = 0, full = false;
const events = [];
const config = { bookingUrl: 'https://sports.sjtu.edu.cn/pc/', activityType: '羽毛球', targetDate: '2026-11-04',
  timeSlots: ['17:00-18:00'], sameCourt: true, preferredCourts: ['场地10','场地9','场地8','场地7','场地6','场地5'], excludedCourts: [] };
const html = `<div>我的订单</div><div class=lists>
<div class="el-tabs__item is-active" role=tab aria-selected=true id=tab-gym>羽毛球</div>
<div class="el-tabs__item is-active" role=tab aria-selected=true id=tab-2026-10-28 onclick="selectDate('2026-10-28')">10月28日</div>
<div class=el-tabs__item role=tab aria-selected=false id=tab-2026-11-04 onclick="selectDate('2026-11-04')">11月04日</div>
<div class=drawerText><h2>2026-10-28</h2></div><div class=inner-seat-wrapper>${Array.from({length:12},(_,i)=>'<div class=topsiteStyle>场地'+(i+1)+'</div>').join('')}<div id=cells></div></div></div>
<script>
function paint(slots) { document.querySelector('#cells').innerHTML=slots.map(s=>'<div class=seat><div class="inner-seat '+(s.status===0?'unselected-seat':'bought-seat')+'"><i>'+s.count+'</i></div></div>').join(''); document.querySelectorAll('.inner-seat').forEach(el=>el.onclick=()=>el.className='inner-seat selected-seat'); }
paint(Array.from({length:15},()=>({status:-1,count:0})));
async function selectDate(date) {
 document.querySelectorAll('[id^="tab-20"]').forEach(el=>{el.classList.toggle('is-active',el.id==='tab-'+date);el.setAttribute('aria-selected',String(el.id==='tab-'+date));});
 document.querySelector('h2').textContent=date;
 const response=await fetch('/manage/fieldDetail/queryFieldSituation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date,fieldType:'gym',venueId:'fixture'})});
 const body=await response.json();
 setTimeout(()=>paint(body.data[0].priceList.flatMap((_,row)=>body.data.map(c=>c.priceList[row]))),500);
}
// 模拟项目切换的迟到响应：会把日期设回当天。
fetch('/manage/fieldDetail/queryFieldReserveSituationIsFull').then(()=>selectDate('2026-10-28'));
</script>`;
await context.route('**/*', async route => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.endsWith('/queryFieldReserveSituationIsFull')) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, data: [] }) });
  }
  if (pathname.endsWith('/queryFieldSituation')) {
    const { date } = route.request().postDataJSON();
    if (date === config.targetDate) targetRequests++;
    await new Promise(resolve => setTimeout(resolve, date === config.targetDate ? 1800 : 100));
    const priceList = Array.from({ length: 15 }, (_, row) => ({status: !full && date === config.targetDate && row === 10 ? 0 : -1, count: row === 10 ? 7 : 0}));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({code:0,data:Array.from({length:12},(_,i)=>({fieldName:'场地'+(i+1),priceList:priceList.map(slot=>targetRequests>1&&i===9?{status:-1,count:0}:slot)}))}) });
  }
  documents++;
  return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
});
try {
  const page = await context.newPage();
  gridTracker(page, (event, details) => events.push({event,...details}));
  await page.goto(config.bookingUrl);
  const started = Date.now();
  assert.equal((await attemptBooking(page, config))[0].courtName, '场地10');
  assert.ok(Date.now()-started >= 3000, 'must await delayed list, target response and DOM painting');
  assert.equal((await attemptBooking(page, config))[0].courtName, '场地9');
  assert.equal(documents, 1, 'normal retry must not reload the document');
  assert.equal(targetRequests, 2, 'each retry must fetch fresh target-date data');
  full = true;
  await assert.rejects(()=>attemptBooking(page, config), error => isRetryableBeforeSubmission(error) && /没有找到/.test(error.message));
  assert.equal(events.filter(e=>e.event==='grid-ready').length,3);
  assert.equal(documents,1);
  await page.locator('[id=tab-2026-11-04]').evaluate(el=>el.remove());
  const missingStarted = Date.now();
  await assert.rejects(()=>attemptBooking(page, config), /尚未开放/);
  assert.ok(Date.now()-missingStarted<2000, '已加载日期列表缺少目标日期时不再空等5秒');
  console.log('通过：场地10优先、10不可用改选9、日期缺失快速返回；迟到的日期列表先完成；接口延迟与DOM延迟均等待；两次选场及一次无名额均匹配新响应；重试无整页刷新。');
} finally { await context.close(); await browser.close(); }
