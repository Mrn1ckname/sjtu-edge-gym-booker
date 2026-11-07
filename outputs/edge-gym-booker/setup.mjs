import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const ui = createInterface({ input: process.stdin, output: process.stdout });
async function choice(prompt, options) {
  for (;;) {
    const answer = (await ui.question(prompt)).trim();
    if (options.includes(answer)) return answer;
    console.log('请输入提示中的选项。');
  }
}
function run(program, args) {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw Error('上一步未完成，请查看上方提示，解决后重新运行设置。');
}
try {
  const exists = fs.existsSync('config.json');
  const config = JSON.parse(fs.readFileSync(exists ? 'config.json' : 'config.example.json', 'utf8').replace(/^\uFEFF/, ''));
  console.log('默认时段为 ' + config.timeSlots.join('、') + '。周三休息，周末使用羽毛球配置。');
  for (;;) {
    const hour = (await ui.question('输入开始小时（7 至 21，例如 17 表示17到18点），直接回车保留：')).trim();
    if (!hour) break;
    if (/^(?:[789]|1\d|2[01])$/.test(hour)) {
      config.timeSlots = [hour.padStart(2,'0') + ':00-' + String(Number(hour)+1).padStart(2,'0') + ':00'];
      break;
    }
  }
  const mode = await choice('选择 1 演练（只选场）或 2 真实提交订单：', ['1','2']);
  config.dryRun = mode === '1';
  console.log('默认时段 ' + config.timeSlots.join('、') + '，模式 ' + (config.dryRun ? '演练' : '真实预约'));
  for (const [key,label] of [['thursdayBooking','周四'],['sundayBooking','周末']]) {
    if (config[key]?.timeSlots) console.log(label + '使用单独时段 ' + config[key].timeSlots.join('、'));
  }
  if (await choice('输入 1 保存并继续，或 0 退出：',['1','0']) === '1') {
    fs.writeFileSync('config.json.tmp', JSON.stringify(config,null,2)+'\n');
    fs.renameSync('config.json.tmp','config.json');
    run('powershell.exe',['-NoProfile','-Command','npm.cmd ci; exit $LASTEXITCODE']);
    run(process.execPath,['booker.mjs','--check-config']);
    const login = await choice('输入 1 打开 Edge 登录（首次使用请选择），或 0 使用已有登录：',['1','0']);
    if (login === '1') {
      ui.pause();
      run(process.execPath,['booker.mjs','--login']);
      ui.resume();
    }
    if (await choice('输入 1 安装或更新定时任务，或 0 跳过：',['1','0']) === '1') {
      run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','install-schedule.ps1']);
    }
    console.log('设置完成。');
  }
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { ui.close(); }
