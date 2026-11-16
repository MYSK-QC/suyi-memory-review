// 记忆体检：node check-memory.cjs [--days N]
// 只看不改。找出「可能过时」的条目，供人工复核。
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.RECALL_MEM_DIR || 'C:/Users/DFY/.dsh/memories';
const days = Number((process.argv.find(a => a.startsWith('--days=')) || '').split('=')[1]) || 30;
const now = Date.now();

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function parseEntries(text) {
  // 条目以「- [YYYY-MM-DD]」或「- [标题]」开头，续行缩进
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const ln of lines) {
    if (/^\[(\d{4}-\d{2}-\d{2})\]/.test(ln) || /^\s*-\s/.test(ln) && !/^\s{2,}/.test(ln)) {
      if (cur) out.push(cur);
      cur = { head: ln.trim(), body: [] };
    } else if (cur) cur.body.push(ln);
  }
  if (cur) out.push(cur);
  return out.map(e => ({ text: (e.head + '\n' + e.body.join('\n')).trim(), date: (e.head.match(/\[(\d{4}-\d{2}-\d{2})/) || [])[1] || null }));
}

const files = ['MEMORY.md', 'USER.md', 'KEY.md'].map(name => ({ name, full: path.join(DIR, name) })).filter(x => fs.existsSync(x.full));
let total = 0;
const stale = [];
const flagged = [];

for (const f of files) {
  const ents = parseEntries(read(f.full));
  total += ents.length;
  for (const e of ents) {
    const age = e.date ? Math.floor((now - new Date(e.date + 'T00:00:00+08:00').getTime()) / 86400000) : null;
    if (age !== null && age > days) stale.push({ file: f.name, date: e.date, age, head: e.text.split('\n')[0].slice(0, 110) });
    if (/作废|更正|记错|写反|不再|已失效|过时/.test(e.text)) flagged.push({ file: f.name, date: e.date, head: e.text.split('\n')[0].slice(0, 110) });
  }
}

const byFile = files.map(f => {
  const st = fs.statSync(f.full);
  return { file: f.name, kb: Math.round(st.size / 1024), entries: parseEntries(read(f.full)).length };
});

console.log(JSON.stringify({
  ok: true,
  dir: DIR,
  files: byFile,
  totalEntries: total,
  staleCount: stale.length,
  flaggedCount: flagged.length,
  stale: stale.slice(0, 15),
  flagged: flagged.slice(0, 15),
}, null, 2));