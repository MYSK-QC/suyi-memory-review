// 记忆检索：node memory-recall.cjs "关键词" [--limit N]
// 打分 = 内容命中 + 标签命中 + 类型权重 + 时间衰减
const { load } = require('./memory-store.cjs');

const HALF_LIFE_DAYS = 60;

function tokenize(s) {
  return String(s || '').toLowerCase().split(/[\s,，、。；;:：!！?？"'"'（）()\[\]【】]+/).filter(t => t.length >= 2);
}

function score(entry, terms, now) {
  const hay = (entry.content + ' ' + (entry.tags || []).join(' ') + ' ' + (entry.subject || '')).toLowerCase();
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit += 1;
  if (hit === 0) return 0;
  const typeW = entry.type === 'rule' || entry.type === 'promise' ? 1.6
    : entry.type === 'self' || entry.type === 'preference' ? 1.3 : 1.0;
  let recency = 1;
  const t = Date.parse((entry.validity && entry.validity.from) || entry.createdAt || '');
  if (!Number.isNaN(t)) {
    const ageDays = Math.max(0, (now - t) / 86400000);
    recency = 0.55 + 0.45 * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }
  return hit * typeW * recency;
}

function recall(q, limit = 10) {
  const entries = load().filter(e => e.valid !== false);
  const terms = tokenize(q);
  const now = Date.now();
  const scored = entries.map(e => ({ e, s: score(e, terms, now) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return scored.map(x => ({
    id: x.e.id,
    type: x.e.type,
    content: x.e.content,
    tags: x.e.tags || [],
    when: (x.e.validity && x.e.validity.from) || x.e.createdAt,
    score: Math.round(x.s * 100) / 100,
  }));
}

function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 10 : 10;
  const q = (limitIdx >= 0)
    ? args.filter((a, i) => i !== limitIdx && i !== limitIdx + 1).join(' ')
    : args.join(' ');
  const rows = recall(q, limit);
  console.log(JSON.stringify({ ok: true, q, count: rows.length, rows }, null, 0));
}

if (require.main === module) main();
module.exports = { recall };