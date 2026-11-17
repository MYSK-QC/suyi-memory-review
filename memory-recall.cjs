// 记忆检索（薄封装）：统一走 memory.cjs 的 STORE.query，避免两套打分逻辑
// 用法：node memory-recall.cjs "关键词" [--limit N]
const { createStore } = require('./memory.cjs');
const STORE = createStore();

function recall(q, limit = 10) {
  const r = STORE.query(q, limit);
  return (r.hits || []).map(h => ({
    id: h.id,
    type: h.type,
    content: h.content,
    tags: h.tags || [],
    when: h.createdAt,
    score: h.score,
  }));
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--limit');
  const limit = i >= 0 ? Number(args[i + 1]) || 10 : 10;
  const q = (i >= 0) ? args.filter((a, k) => k !== i && k !== i + 1).join(' ') : args.join(' ');
  const rows = recall(q, limit);
  console.log(JSON.stringify({ ok: true, q, count: rows.length, rows }, null, 0));
}

if (require.main === module) main();
module.exports = { recall };