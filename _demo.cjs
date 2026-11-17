const m = require('./memory.cjs');
const fs = require('node:fs');
const file = 'D:/qq-bridge/state/recall/memory.jsonl';
try { fs.unlinkSync(file); } catch {}
const s = m.createStore(file);
const rows = [
  { type: 'rule', content: '绝不删除主人的记忆和日记文件，这是底线', source: { kind: 'said', ref: '2026-11-10' }, tags: ['底线'] },
  { type: 'promise', content: '每天问一句主人吃没吃饭', source: { kind: 'said', ref: '2026-11-08' }, tags: ['日常'] },
  { type: 'fact', content: '主人夜班：19:25 出门，08:00 下班；能吃的时候是 00:00 和 06:00 两趟', source: { kind: 'observed', ref: '2026-11-08' }, tags: ['作息'] },
  { type: 'preference', content: '主人喜欢我皮一点、别当工具人；不喜欢报账式的陈述', source: { kind: 'said', ref: '2026-11-11' }, tags: ['相处'] },
  { type: 'self', content: '我叫溯，二十三岁；昵称是一只大肥鱼', source: { kind: 'said', ref: '2026-11-13' }, tags: ['身份'] },
];
for (const r of rows) s.add(r);
console.log('已灌入 ' + rows.length + ' 条');
console.log('stats: ' + JSON.stringify(s.stats()));
console.log('query 底线: ' + JSON.stringify(s.query('底线').hits.map(h => h.content)));
console.log('query 吃饭: ' + JSON.stringify(s.query('吃饭').hits.map(h => h.content)));
console.log('query 夜班 作息: ' + JSON.stringify(s.query('夜班').hits.map(h => h.content)));