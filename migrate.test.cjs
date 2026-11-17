'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, convert } = require('./migrate.cjs');
const { createStore } = require('./memory.cjs');

function fixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'MEMORY.md');
  const dest = path.join(dir, 'memory.jsonl');
  fs.writeFileSync(src, text);
  function run(...args) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'migrate.cjs'), src, '--out', dest, ...args],
      { encoding: 'utf8' });
    return { status: r.status, result: JSON.parse((r.status ? r.stderr : r.stdout).trim()) };
  }
  return { src, dest, run };
}

const legacy = `# Memory
[2026-11-10] 用户说我喜欢 Node.js。
第二行补充。
§
- [2026-11-11] 我注意到这人不许泄密，也答应保密。
§
[2026-11-12] 他告诉我：我叫小明。
§
[2026-11-13] 以后每天检查备份。
§
[2026-11-14] 这是一个事实。
§
[2026-11-15] 我观察到有新事件。
§
`;

test('parses multiline records, optional bullet and exact delimiters', () => {
  const rows = parse(legacy);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].content, '用户说我喜欢 Node.js。\n第二行补充。');
  assert.equal(rows[1].line, 5);
  assert.equal(rows[2].date, '2026-11-12');
  assert.equal(rows[0].content.includes('§'), false);
});

test('infer types, source, ambiguity and stable IDs', () => {
  const a = convert(parse(legacy), '/tmp/MEMORY.md');
  const b = convert(parse(legacy), '/tmp/MEMORY.md');
  assert.deepEqual(a, b);
  assert.deepEqual(a.map(x => x.memory.type),
    ['preference', 'rule', 'self', 'promise', 'fact', 'fact']);
  assert.deepEqual(a.map(x => x.memory.source.kind),
    ['said', 'observed', 'said', 'observed', 'observed', 'observed']);
  assert.equal(a[1].ambiguous, true); // rule and promise overlap
  assert.equal(a[3].ambiguous, true); // no explicit source
  for (const { memory } of a) {
    assert.match(memory.id, /^legacy-[0-9a-f]{32}$/);
    assert.ok(memory.tags.length >= 1 && memory.tags.length <= 3);
    assert.match(memory.createdAt, /^2026-11-\d\dT00:00:00\.000Z$/);
  }
});

test('dry-run writes nothing and prints first five samples', t => {
  const f = fixture(t, legacy);
  const before = fs.readFileSync(f.src, 'utf8');
  const { status, result } = f.run();
  assert.equal(status, 0);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.total, 6);
  assert.equal(result.samples.length, 5);
  assert.equal(result.byType.fact, 2);
  assert.ok(result.ambiguous >= 2);
  assert.equal(fs.existsSync(f.dest), false);
  assert.equal(fs.readFileSync(f.src, 'utf8'), before);
});

test('apply merges atomically and reruns are idempotent', t => {
  const f = fixture(t, legacy);
  const before = fs.readFileSync(f.src, 'utf8');
  assert.equal(f.run('--apply').result.added, 6);
  const rows = createStore(f.dest).read();
  assert.equal(rows.length, 6);
  assert.equal(rows[0].content.includes('\n'), true);
  assert.equal(rows[0].valid, true);
  assert.equal(rows[0].accessCount, 0);
  const initial = fs.readFileSync(f.dest, 'utf8');
  assert.equal(f.run('--apply').result.added, 0);
  assert.equal(fs.readFileSync(f.dest, 'utf8'), initial);
  assert.equal(fs.readFileSync(f.src, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(f.dest)).some(n => n.endsWith('.lock')), false);
});

test('keeps existing structured records', t => {
  const f = fixture(t, legacy);
  const existing = createStore(f.dest).add({ type: 'fact', content: 'Existing memory',
    source: { kind: 'observed', ref: 'test' } }).memory;
  const result = f.run('--apply');
  assert.equal(result.status, 0);
  assert.equal(result.result.added, 6);
  assert.equal(createStore(f.dest).read().length, 7);
  assert.equal(createStore(f.dest).read()[0].id, existing.id);
});

test('malformed date, missing delimiter and same output are rejected without writes', t => {
  // 注意：文件末尾那条允许没有 §（真实 MEMORY.md 就是这样结尾的），所以这里只测中间缺 §
  for (const bad of ['[2026-02-30] bad\n§', '[2026-11-10] one\n[2026-11-11] two\n§']) {
    assert.throws(() => parse(bad));
  }
  const f = fixture(t, '[2026-11-10] Test\n§\n');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'migrate.cjs'),
    f.src, '--out', f.src, '--apply'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(f.dest), false);
  assert.equal(fs.readFileSync(f.src, 'utf8'), '[2026-11-10] Test\n§\n');
});
