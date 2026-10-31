import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const logs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');
export function cleanOldLogs({ now = Date.now(), dryRun = false } = {}) {
  if (!fs.existsSync(logs)) return [];
  if (fs.lstatSync(logs).isSymbolicLink() || fs.realpathSync(logs).toLowerCase() !== path.resolve(logs).toLowerCase()) throw new Error('日志目录路径异常，停止清理');
  const removed = [];
  for (const entry of fs.readdirSync(logs, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(log|jsonl|png|jpg|jpeg|webp|html)$/i.test(entry.name)) continue;
    const target = path.resolve(logs, entry.name);
    if (path.dirname(target) !== path.resolve(logs)) throw new Error('日志路径越界');
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || now - stat.mtimeMs <= 3 * 24 * 60 * 60 * 1000) continue;
    try { if (!dryRun) fs.unlinkSync(target); removed.push({ name: entry.name, bytes: stat.size }); }
    catch (error) { console.error(`日志清理失败 ${entry.name}: ${error.message}`); }
  }
  return removed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(cleanOldLogs({ dryRun: process.argv.includes('--dry-run') })));
}
