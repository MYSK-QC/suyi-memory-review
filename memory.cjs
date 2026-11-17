// 记忆库（结构化版）—— 由 GPT 按 spec 实现，我合并进 suyi-memory
// 字段见 memory.schema.json；数据文件默认 memory.jsonl（每行一条 JSON）
// 特点：并发锁 + 原子写 + 遗忘曲线压缩（D(t)=D0*e^(-t/S)，S 随召回次数增长）
// 用法：node memory.cjs add JSON | query 关键词 [--limit N] | stats | review [--apply] | touch ID#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TYPES = new Set(['fact', 'event', 'preference', 'promise', 'rule', 'self', 'relation']);
const KINDS = new Set(['said', 'observed', 'inferred']);
const WEIGHTS = { rule: 1.6, promise: 1.6, self: 1.3, preference: 1.3 };
const DAY = 86_400_000;
const THRESHOLD = 0.05;  // 原 0.25 约 1.4 天就够格，太激进；0.05 约 3 天
const DEFAULT_FILE = process.env.MEMORY_FILE || path.join(__dirname, 'memory.jsonl');
const error = (...errors) => ({ ok: false, errors });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = v => Array.isArray(v) && v.every(s => typeof s === 'string');
const dateOnly = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const timestamp = s => typeof s === 'string' && Number.isFinite(Date.parse(s));
const age = (ts, now) => Math.max(0, (now - Date.parse(ts)) / DAY);
const normalize = s => s.normalize('NFKC').toLowerCase();

function strength(m) { return 1 + 0.6 * m.accessCount; }
function decay(m, now = Date.now()) {
  return Math.exp(-age(m.lastRecalledAt || m.createdAt, now) / strength(m));
}
function recency(m, now = Date.now()) {
  return 0.55 + 0.45 * 0.5 ** (age(m.createdAt, now) / 60);
}
function active(m, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  return m.valid && !m.closedBy && (!m.validity.from || m.validity.from <= today) &&
    (!m.validity.to || today <= m.validity.to);
}
function summarize(content, max = 120) {
  const chars = [...content.replace(/\s+/gu, ' ').trim()];
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…';
}

function validate(m) {
  if (!isObject(m)) return ['Memory must be an object'];
  const errors = [];
  if (!TYPES.has(m.type)) errors.push('Invalid type');
  if (typeof m.content !== 'string' || !m.content.trim()) errors.push('Empty or invalid content');
  if (!isObject(m.source) || !KINDS.has(m.source.kind)) errors.push('Invalid source.kind');
  if (typeof m.source?.ref !== 'string') errors.push('source.ref must be a string');
  if (m.id !== undefined && (typeof m.id !== 'string' || !m.id.trim())) errors.push('Invalid id');
  for (const key of ['subject', 'closedBy']) {
    if (m[key] !== undefined && typeof m[key] !== 'string') errors.push(`Invalid ${key}`);
  }
  for (const key of ['evidence', 'tags']) {
    if (m[key] !== undefined && !isStringArray(m[key])) errors.push(`Invalid ${key}`);
  }
  if (m.valid !== undefined && typeof m.valid !== 'boolean') errors.push('Invalid valid');
  if (m.createdAt !== undefined && !timestamp(m.createdAt)) errors.push('Invalid createdAt');
  if (m.validity !== undefined) {
    const v = m.validity;
    if (!isObject(v) || ['from', 'to'].some(k => v[k] !== undefined && !dateOnly(v[k])) ||
        (v.from && v.to && v.from > v.to)) errors.push('Invalid validity date range');
  }
  return errors;
}

function createStore(filename = DEFAULT_FILE, clock = Date.now) {
  const file = path.resolve(filename);
  const lock = file + '.lock';

  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const seen = new Set();
    const rows = [];
    for (const [i, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (validate(m).length || typeof m.id !== 'string' || seen.has(m.id) ||
            !timestamp(m.createdAt) || !isObject(m.validity) || typeof m.valid !== 'boolean' ||
            !isStringArray(m.tags) || !Number.isSafeInteger(m.accessCount) || m.accessCount < 0 ||
            (m.lastRecalledAt != null && !timestamp(m.lastRecalledAt)) ||
            typeof m.compressed !== 'boolean') throw new Error('Invalid memory record');
        seen.add(m.id);
        rows.push(m);
      } catch (e) { throw new Error(`Invalid JSONL at line ${i + 1}: ${e.message}`); }
    }
    return rows;
  }

  function write(rows) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, rows.map(m => JSON.stringify(m) + '\n').join(''), 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }

  // All read-modify-write operations share a lock, preventing lost updates.
  function transaction(fn) {
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') return error('Memory store is locked; retry'); throw e; }
    try { return fn(read()); }
    finally { try { fs.closeSync(fd); } finally { fs.unlinkSync(lock); } }
  }

  function add(input) {
    const errors = validate(input);
    if (errors.length) return error(...errors);
    return transaction(rows => {
      const m = {
        id: input.id ?? randomUUID(), type: input.type, content: input.content.trim(),
        source: { kind: input.source.kind, ref: input.source.ref }, subject: input.subject ?? 'me',
        validity: { from: input.validity?.from, to: input.validity?.to },
        evidence: input.evidence ?? [], valid: input.valid ?? true, closedBy: input.closedBy ?? '',
        createdAt: new Date(input.createdAt ?? clock()).toISOString(), tags: input.tags ?? [],
        accessCount: 0, lastRecalledAt: null, compressed: false
      };
      if (rows.some(row => row.id === m.id)) return error('Duplicate id');
      rows.push(m);
      write(rows);
      return { ok: true, memory: m };
    });
  }

  function recordRecall(m, now) {
    m.accessCount++;
    m.lastRecalledAt = new Date(now).toISOString();
  }

  function query(keywords, limit = 10) {
    if (typeof keywords !== 'string') return error('Keywords must be a string');
    if (!Number.isSafeInteger(limit) || limit < 1) return error('Limit must be a positive integer');
    const terms = [...new Set(normalize(keywords).split(/[\s,，、]+/u).filter(Boolean))];
    if (!terms.length) return { ok: true, count: 0, hits: [] };
    return transaction(rows => {
      const now = clock();
      const hits = rows.filter(m => active(m, now)).map(m => {
        const content = normalize(m.content + ' ' + (m.originalContent || ''));  // 压缩过的原文也要能搜到
        const keywordHits = terms.filter(k => content.includes(k)).length;
        return { m, keywordHits, score: keywordHits * (WEIGHTS[m.type] ?? 1) * recency(m, now) };
      }).filter(h => h.keywordHits > 0)
        .sort((a, b) => b.score - a.score || b.m.createdAt.localeCompare(a.m.createdAt) ||
          a.m.id.localeCompare(b.m.id)).slice(0, limit);
      for (const { m } of hits) recordRecall(m, now);
      if (hits.length) write(rows);
      return { ok: true, count: hits.length, hits: hits.map(({ m, ...rest }) => ({ ...m, ...rest })) };
    });
  }

  function touch(id) {
    return transaction(rows => {
      const m = rows.find(row => row.id === id);
      if (!m) return error('Memory not found');
      recordRecall(m, clock());
      write(rows);
      return { ok: true, id, accessCount: m.accessCount, strength: strength(m) };
    });
  }

  function review(apply = false) {
    function inspect(rows) {
      const now = clock();
      // 规矩和承诺不参与压缩（GPT 审查第 4 条：它们不能变成一句话摘要）
      const due = rows.filter(m => !m.compressed && m.type !== 'rule' && m.type !== 'promise' && decay(m, now) < THRESHOLD)
        .map(m => ({ id: m.id, type: m.type, content: m.content, decay: decay(m, now),
          strength: strength(m), needsCompression: true, suggestedSummary: summarize(m.content) }));
      if (apply && due.length) {
        const summaries = new Map(due.map(m => [m.id, m.suggestedSummary]));
        for (const m of rows) if (summaries.has(m.id)) {
          // 压缩可逆：原文留在 originalContent 里，随时能展开（GPT 审查第 4 条）
          if (!m.originalContent) m.originalContent = m.content;
          m.content = summaries.get(m.id);
          m.compressed = true;
        }
        write(rows);
      }
      return { ok: true, applied: apply, count: due.length, memories: due };
    }
    return apply ? transaction(inspect) : inspect(read());
  }

  function stats() {
    const rows = read();
    const now = clock();
    const byType = Object.fromEntries([...TYPES].map(t => [t, 0]));
    for (const m of rows) byType[m.type]++;
    return { ok: true, total: rows.length, active: rows.filter(m => active(m, now)).length,
      compressed: rows.filter(m => m.compressed).length,
      needsCompression: rows.filter(m => !m.compressed && m.type !== 'rule' && m.type !== 'promise' && decay(m, now) < THRESHOLD).length,
      exempt: rows.filter(m => m.type === 'rule' || m.type === 'promise').length,
      totalRecalls: rows.reduce((sum, m) => sum + m.accessCount, 0), byType };
  }

  return { add, query, touch, review, stats, read };
}

function main(args = process.argv.slice(2)) {
  const [cmd, ...rest] = args;
  const store = createStore();
  // add 既支持命令行传 JSON，也支持从 stdin 读（powershell 里传中文 JSON 容易被吃掉引号）
  if (cmd === 'add' && (rest.length === 1 || (rest.length === 0 && !process.stdin.isTTY))) {
    let input;
    const raw = rest.length === 1 ? rest[0] : fs.readFileSync(0, 'utf8');
    try { input = JSON.parse(raw); } catch { return error('Invalid JSON input'); }
    return store.add(input);
  }
  if (cmd === 'query' && (rest.length === 1 || (rest.length === 3 && rest[1] === '--limit'))) {
    const limit = rest.length === 1 ? 10 : (/^\d+$/.test(rest[2]) ? Number(rest[2]) : NaN);
    return store.query(rest[0], limit);
  }
  if (cmd === 'stats' && !rest.length) return store.stats();
  if (cmd === 'review' && (!rest.length || (rest.length === 1 && rest[0] === '--apply'))) {
    return store.review(rest.length === 1);
  }
  if (cmd === 'touch' && rest.length === 1) return store.touch(rest[0]);
  return error('Usage: add <json> | query <keywords> [--limit N] | stats | review [--apply] | touch <id>');
}

if (require.main === module) {
  let result;
  try { result = main(); } catch (e) { result = error(e.message); }
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}
module.exports = { createStore, decay, recency, strength, summarize };
