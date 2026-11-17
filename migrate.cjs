#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createStore } = require('./memory.cjs');
const { extractKeywords } = require('./digest.cjs');

const TYPES = [
  ['rule', /绝不|不许|不要/u],
  ['promise', /答应|说好|以后每天/u],
  ['preference', /我喜欢|讨厌|偏好/u],
  ['self', /我是|我叫|我的/u]
];
const SAID = /用户(?:说|表示|告诉|提到)|他(?:说|表示|告诉我|提到)|她(?:说|表示|告诉我|提到)|对方(?:说|表示|告诉)|主人(?:说|表示|告诉)|原话[：:]/u;
const OBSERVED = /我(?:发现|注意到|观察到|看到)|观察到|注意到|根据(?:日志|记录)|从(?:日志|记录)发现/u;
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

function parse(text) {
  const entries = [];
  let current = null;
  for (const [i, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/u).entries()) {
    const start = raw.match(/^\s*(?:-\s*)?\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/u);
    if (start) {
      if (current) throw new Error(`Missing § before line ${i + 1}`);
      if (!validDate(start[1])) throw new Error(`Invalid date at line ${i + 1}`);
      current = { date: start[1], line: i + 1, lines: [start[2]] };
    } else if (/^\s*§\s*$/u.test(raw)) {
      if (!current) throw new Error(`Unexpected § at line ${i + 1}`);
      const content = current.lines.join('\n').trim();
      if (!content) throw new Error(`Empty entry at line ${current.line}`);
      entries.push({ date: current.date, line: current.line, content });
      current = null;
    } else if (current) current.lines.push(raw);
  }
  // 真实 MEMORY.md 最后一条没有 § 结尾，按到文件末尾处理
  if (current) {
    const content = current.lines.join('\n').trim();
    if (content) entries.push({ date: current.date, line: current.line, content });
  }
  return entries;
}

function convert(entries, src) {
  const duplicates = new Map();
  return entries.map(entry => {
    const { date, line, content } = entry;
    const types = TYPES.filter(([, re]) => re.test(content)).map(([type]) => type);
    const said = SAID.test(content), observed = OBSERVED.test(content);
    const ambiguous = types.length > 1 || said === observed;
    const signature = JSON.stringify([date, content]);
    const occurrence = duplicates.get(signature) || 0;
    duplicates.set(signature, occurrence + 1);
    const id = 'legacy-' + createHash('sha256')
      .update(JSON.stringify([date, content, occurrence])).digest('hex').slice(0, 32);
    const tags = [...new Set(extractKeywords(content))].slice(0, 3);
    if (!tags.length) tags.push(content.replace(/\s+/gu, ' ').slice(0, 12));
    const memory = {
      id, type: types[0] || 'fact', content,
      source: { kind: said && !observed ? 'said' : 'observed',
        ref: `legacy:${path.basename(src)}:L${line}` },
      subject: 'me', validity: { from: date }, evidence: [], valid: true,
      closedBy: '', createdAt: `${date}T00:00:00.000Z`, tags,
      accessCount: 0, lastRecalledAt: null, compressed: false
    };
    return { memory, ambiguous };
  });
}

function atomicMerge(dest, items) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const lock = dest + '.lock';
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  try {
    const existing = createStore(dest).read();
    const ids = new Set(existing.map(m => m.id));
    const additions = items.map(x => x.memory).filter(m => !ids.has(m.id));
    if (!additions.length) return 0;
    const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, [...existing, ...additions]
          .map(m => JSON.stringify(m)).join('\n') + '\n', 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, dest);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    return additions.length;
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}

function main(argv = process.argv.slice(2)) {
  let apply = false, dest = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--out') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing --out path');
      dest = argv[++i];
    } else if (argv[i].startsWith('--')) throw new Error(`Unknown option: ${argv[i]}`);
    else positional.push(argv[i]);
  }
  if (positional.length > 1) throw new Error('Usage: migrate.cjs [MEMORY.md] [--out memory.jsonl] [--apply]');
  const source = positional[0] || path.join(process.env.RECALL_MEM_DIR || __dirname, 'MEMORY.md');
  dest ||= process.env.MEMORY_FILE || path.join(__dirname, 'memory.jsonl');
  const input = path.resolve(source), output = path.resolve(dest);
  if (input === output || (fs.existsSync(output) &&
    fs.realpathSync(input) === fs.realpathSync(output))) throw new Error('Input and output must differ');
  const items = convert(parse(fs.readFileSync(input, 'utf8')), input);
  const byType = Object.fromEntries(['fact', ...TYPES.map(t => t[0])].map(t => [t, 0]));
  for (const { memory } of items) byType[memory.type]++;
  const result = {
    ok: true, dryRun: !apply, total: items.length, byType,
    ambiguous: items.filter(x => x.ambiguous).length,
    samples: items.slice(0, 5).map(x => ({ ...x.memory, ambiguous: x.ambiguous }))
  };
  if (apply) result.added = atomicMerge(output, items);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exitCode = 1;
  }
}
module.exports = { parse, convert, main };