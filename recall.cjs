const { DatabaseSync } = require('node:sqlite');
const DB = 'D:/qq-bridge/state/recall/recall.db';
const args = process.argv.slice(2);
if (!args.length) { console.log('usage: node recall.cjs <关键词> [--since YYYY-MM-DD] [--who 他|鱼] [--limit N] [--around] [--raw]'); process.exit(1); }
let q = null, since = null, who = null, limit = 15, around = false, raw = false, json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--since') since = args[++i];
  else if (a === '--who') who = args[++i];
  else if (a === '--limit') limit = parseInt(args[++i], 10) || 15;
  else if (a === '--around') around = true;
  else if (a === '--raw') raw = true;
  else if (a === '--json') json = true;
  else if (q === null) q = a;
}
const db = new DatabaseSync(DB);
db.exec('CREATE TABLE IF NOT EXISTS access (id INTEGER PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER NOT NULL DEFAULT 0)');
const pad = n => String(n).padStart(2, '0');
const fmt = ts => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const where = [], params = [];
if (since) { where.push('m.day >= ?'); params.push(since); }
if (who) { where.push('m.who = ?'); params.push(who); }
const HALF_LIFE_DAYS = 45;
const now = Date.now();
const hitsMap = new Map();
for (const r of db.prepare('SELECT id, hits, last_hit FROM access').all()) hitsMap.set(r.id, r);

let rows = [], mode = 'fts';
const wsql = where.length ? ' AND ' + where.join(' AND ') : '';
if ([...q].length >= 3) {
  const sql = `SELECT m.id, m.ts, m.day, m.who, m.text, bm25(fts) AS rank FROM fts f JOIN msgs m ON m.id = f.rowid WHERE fts MATCH ?` + wsql + ` ORDER BY rank LIMIT ${Math.max(limit * 6, 40)}`;
  rows = db.prepare(sql).all('"' + q.replace(/"/g, '""') + '"', ...params);
}
if (!rows.length) {
  mode = 'like';
  const sql = `SELECT id, ts, day, who, text, 0 AS rank FROM msgs m WHERE m.text LIKE ?` + wsql + ` ORDER BY m.ts DESC LIMIT ${Math.max(limit * 6, 40)}`;
  rows = db.prepare(sql).all('%' + q + '%', ...params);
}
if (!rows.length) { console.log('(没找到)'); process.exit(0); }

function score(r) {
  const ageDays = Math.max(0, (now - r.ts) / 86400000);
  const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  const hits = (hitsMap.get(r.id) || { hits: 0 }).hits;
  const rehearsal = 1 + 0.35 * Math.log(1 + hits);
  const base = mode === 'fts' ? -r.rank : 1;
  return base * (0.55 + 0.45 * recency) * rehearsal;
}
rows.forEach(r => { r._s = score(r); });
rows.sort((a, b) => b._s - a._s);
rows = rows.slice(0, limit);

const clean = t => t.replace(/\s+/g, ' ');
if (json) {
  const out = rows.map(r => ({ ts: r.ts, day: r.day, who: r.who, text: clean(r.text).slice(0, 300), hits: (hitsMap.get(r.id) || { hits: 0 }).hits }));
  console.log(JSON.stringify({ ok: true, q, since, who, mode, count: out.length, rows: out }, null, 0));
  const bump2 = db.prepare('INSERT INTO access(id, hits, last_hit) VALUES(?, 1, ?) ON CONFLICT(id) DO UPDATE SET hits = hits + 1, last_hit = excluded.last_hit');
  for (const r of rows) { try { bump2.run(r.id, now); } catch (e) {} }
  db.close();
  process.exit(0);
}
console.log(`命中 ${rows.length} 条（关键词：${q}${since ? '，起 ' + since : ''}${who ? '，只 ' + who : ''}${raw ? '' : '，已按遗忘曲线排序'}）`);
for (const r of rows) {
  const hits = (hitsMap.get(r.id) || { hits: 0 }).hits;
  console.log(`[${fmt(r.ts)}]${hits ? '·' + hits : ''} ${r.who}：${clean(r.text).slice(0, 220)}`);
}
const bump = db.prepare('INSERT INTO access(id, hits, last_hit) VALUES(?, 1, ?) ON CONFLICT(id) DO UPDATE SET hits = hits + 1, last_hit = excluded.last_hit');
for (const r of rows) { try { bump.run(r.id, now); } catch (e) {} }
if (around) {
  const top = rows[0];
  console.log('\n—— 那一条的上下文 ——');
  const ctx = db.prepare('SELECT ts, who, text FROM msgs WHERE ts BETWEEN ? AND ? ORDER BY ts ASC').all(top.ts - 40 * 60000, top.ts + 40 * 60000);
  for (const c of ctx) console.log(`[${fmt(c.ts)}] ${c.who}：${clean(c.text).slice(0, 200)}`);
}
db.close();