// 记忆迁移（干跑）：node migrate-dry.cjs [--limit N]
// 只读 MEMORY.md，按「- [YYYY-MM-DD]」切条目，试着转成结构化记忆，打印样本。
// 绝不写文件；真正迁移等主人指令（他说等星期 4 在家）。
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.env.RECALL_MEM_DIR
  ? path.join(process.env.RECALL_MEM_DIR, 'MEMORY.md')
  : 'C:/Users/DFY/.dsh/memories/MEMORY.md';
const limit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 5;

const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

const entries = [];
let cur = null;
for (const ln of lines) {
  const m = ln.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
  if (m) {
    if (cur) entries.push(cur);
    cur = { date: m[1], lines: [m[2]] };
  } else if (cur) {
    cur.lines.push(ln);
  }
}
if (cur) entries.push(cur);

const out = entries.map((e, i) => {
  const body = e.lines.join('\n').replace(/^\s*§\s*$/gm, '').trim();
  // 猜类型
  let type = 'fact';
  if (/承诺|约定|说好|答应/.test(body)) type = 'promise';
  else if (/不许|不要|禁止|红线|底线|规矩/.test(body)) type = 'rule';
  else if (/喜欢|讨厌|爱吃|口味/.test(body)) type = 'preference';
  else if (/我(自己|的)|我是|我的名字|我的嗓子/.test(body)) type = 'self';
  else if (/他(说|讲|问|原话)/.test(body)) type = 'event';
  return {
    id: 'm_' + e.date.replace(/-/g, '') + '_' + String(i + 1).padStart(3, '0'),
    type,
    content: body.slice(0, 400) + (body.length > 400 ? '…' : ''),
    source: { kind: 'said', ref: e.date },
    subject: /我(自己|的)|我是/.test(body) ? '我' : '主人',
    validity: { from: e.date },
    evidence: [],
    valid: true,
    createdAt: e.date + ' 00:00',
    tags: [],
  };
});

console.log(JSON.stringify({
  ok: true,
  src: SRC,
  total: entries.length,
  byType: out.reduce((a, x) => (a[x.type] = (a[x.type] || 0) + 1, a), {}),
  sample: out.slice(0, limit),
}, null, 2));