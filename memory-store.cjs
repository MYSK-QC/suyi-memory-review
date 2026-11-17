// 记忆库（结构化版）：node memory-store.cjs <add|query|list|stats> [...]
// 数据文件 memories.jsonl，每行一条 JSON，字段见 memory.schema.json
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = process.env.RECALL_DIR || __dirname;
const DB = process.env.MEMORY_DB || path.join(DIR, 'memories.jsonl');

function load() {
  if (!fs.existsSync(DB)) return [];
  const out = [];
  for (const ln of fs.readFileSync(DB, 'utf8').split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch { }
  }
  return out;
}

function save(list) {
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, list.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, DB);
}

function validate(e) {
  const errs = [];
  if (!e || typeof e !== 'object') return ['不是对象'];
  if (typeof e.content !== 'string' || !e.content.trim()) errs.push('content 必须是非空字符串');
  const TYPES = ['fact', 'event', 'preference', 'promise', 'rule', 'self', 'relation'];
  if (!TYPES.includes(e.type)) errs.push('type 必须是 ' + TYPES.join('/'));
  if (!e.source || !['said', 'observed', 'inferred'].includes(e.source.kind)) errs.push('source.kind 必须是 said/observed/inferred');
  return errs;
}

function add(raw, opts = {}) {
  const errs = validate(raw);
  if (errs.length) return { ok: false, errors: errs };
  const list = load();
  const now = new Date();
  const id = raw.id || ('m_' + now.toISOString().slice(0, 10).replace(/-/g, '') + '_' + crypto.randomBytes(3).toString('hex'));
  if (list.some(x => x.id === id)) return { ok: false, errors: ['id 重复: ' + id] };
  const rec = {
    id,
    type: raw.type,
    content: String(raw.content).trim(),
    source: raw.source,
    subject: raw.subject || '我',
    validity: raw.validity || {},
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    valid: raw.valid !== false,
    closedBy: raw.closedBy || '',
    createdAt: raw.createdAt || now.toISOString().slice(0, 16).replace('T', ' '),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
  };
  list.push(rec);
  save(list);
  return { ok: true, id, total: list.length };
}

// 极简检索：字段命中 + 标签命中，按命中数排序（真正的 IDF 靠 build-index 那套，这里先能用）
function query(q, limit = 10) {
  const list = load().filter(e => e.valid !== false);
  if (!q) return list.slice(-limit);
  const terms = String(q).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  const scored = list.map(e => {
    const hay = (e.content + ' ' + (e.tags || []).join(' ') + ' ' + e.subject).toLowerCase();
    let s = 0;
    for (const t of terms) if (hay.includes(t)) s += 1;
    if (e.type === 'rule' || e.type === 'promise') s += 0.5;  // 规矩和承诺优先
    return { e, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(x => x.e);
}

function stats() {
  const list = load();
  const byType = {}, byValid = { true: 0, false: 0 };
  for (const e of list) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byValid[e.valid !== false ? 'true' : 'false'] += 1;
  }
  return { total: list.length, byType, byValid };
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const arg = rest.join(' ');
  if (cmd === 'add') {
    let e;
    try { e = JSON.parse(arg); } catch { console.log(JSON.stringify({ ok: false, errors: ['参数必须是 JSON'] })); return; }
    console.log(JSON.stringify(add(e)));
  } else if (cmd === 'query') {
    console.log(JSON.stringify({ ok: true, rows: query(arg, 10) }, null, 0));
  } else if (cmd === 'list') {
    console.log(JSON.stringify({ ok: true, total: load().length, rows: load().slice(-20) }, null, 0));
  } else if (cmd === 'stats') {
    console.log(JSON.stringify({ ok: true, ...stats() }));
  } else {
    console.log('usage: node memory-store.cjs <add|query|list|stats> [...]');
  }
}

if (require.main === module) main();
module.exports = { load, save, add, query, stats, validate };