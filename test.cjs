'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { extractKeywords } = require('./digest.cjs');

function fixture(t, messages = []) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'suyi-memory-test-')
  );

  const sessions = path.join(root, 'sessions');
  const recallDir = path.join(root, 'recall');
  const session = path.join(sessions, 'test-session');
  const logfile = path.join(session, 'session.v4.jsonl.zstd');
  const dbfile = path.join(recallDir, 'recall.db');

  fs.mkdirSync(session, { recursive: true });
  fs.mkdirSync(recallDir, { recursive: true });

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    RECALL_SESS_ROOT: sessions,
    RECALL_DIR: recallDir,
    RECALL_DB: dbfile
  };

  const base = Date.now() - 3600000;

  function writeLog(texts) {
    const lines = texts.map((text, i) => JSON.stringify({
      type: 'assistant/message',
      seq: i + 1,
      time: base + i * 1000,
      data: {
        message: {
          content: [
            { type: 'text', text }
          ]
        }
      }
    }));

    const compressed = zlib.zstdCompressSync(
      Buffer.from(lines.join('\n') + '\n', 'utf8')
    );

    fs.writeFileSync(logfile, compressed);
  }

  function run(script, args = []) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, script), ...args],
      {
        env,
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true
      }
    );

    assert.ifError(result.error);

    assert.equal(
      result.status,
      0,
      `${script} failed:\n${result.stderr}\n${result.stdout}`
    );

    return result.stdout.trim();
  }

  function json(script, args = []) {
    return JSON.parse(run(script, args));
  }

  function query(sql, ...params) {
    const db = new DatabaseSync(dbfile);

    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  }

  function access() {
    return query(`
      SELECT message_id, hits
      FROM access_by_key
      ORDER BY message_id
    `).map(row => ({ ...row }));
  }

  function build() {
    return run('build-index.cjs');
  }

  writeLog(messages);

  return {
    root,
    logfile,
    dbfile,
    writeLog,
    run,
    json,
    query,
    access,
    build
  };
}

test('keyword extraction removes conversational boundary junk', () => {
  const kws = extractKeywords(
    '你上次说的那个记忆检索方案'
  );

  assert.ok(kws.includes('记忆'));
  assert.ok(kws.includes('检索'));
  assert.ok(kws.includes('记忆检索'));

  assert.ok(!kws.includes('你上'));
  assert.ok(!kws.includes('那个'));
  assert.ok(!kws.includes('上次'));

  assert.equal(kws.length, new Set(kws).size);
  assert.ok(kws.length <= 24);
});

test('keyword extraction preserves names and technical identifiers', () => {
  const kws = extractKeywords(
    '[引用 某人：无关内容] 星露谷 Node.js GPT-4 SHA256'
  );

  assert.ok(kws.includes('星露谷'));
  assert.ok(kws.includes('node.js'));
  assert.ok(kws.includes('gpt-4'));
  assert.ok(kws.includes('sha256'));

  assert.ok(!kws.some(kw => kw.includes('无关')));
  assert.deepEqual(extractKeywords(''), []);
});

test('zero-hit recall returns valid empty JSON', t => {
  const f = fixture(t, ['记忆检索方案']);
  f.build();

  const result = f.json('recall.cjs', [
    'zzzz_nonexistent_keyword',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.total, 0);
  assert.equal(result.count, 0);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(f.access(), []);
});

test('zero-hit batch returns valid empty JSON', t => {
  const f = fixture(t, ['记忆检索方案']);
  f.build();

  const result = f.json('recall.cjs', [
    '--batch', '不存在的词,zzzz_missing',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.total, 0);
  assert.equal(result.count, 0);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.used, []);
  assert.deepEqual(f.access(), []);
});

test('generic-word filter rejects >60 but retains exactly 60', t => {
  const messages = Array.from(
    { length: 61 },
    (_, i) => i < 60
      ? `星露谷 临界测试 普通聊天 ${i}`
      : `星露谷 普通聊天 ${i}`
  );

  messages.push('记忆检索方案');

  const f = fixture(t, messages);
  f.build();

  const result = f.json('recall.cjs', [
    '--batch', '星露谷,临界测试,记忆检索',
    '--max-total', '60',
    '--no-hit',
    '--json'
  ]);

  assert.equal(result.ok, true);

  const totals = new Map(
    result.totals.map(row => [row.kw, row.total])
  );

  assert.equal(totals.get('星露谷'), 61);
  assert.equal(totals.get('临界测试'), 60);
  assert.equal(totals.get('记忆检索'), 1);

  assert.ok(!result.used.some(row => row.kw === '星露谷'));
  assert.ok(result.used.some(row => row.kw === '临界测试'));
  assert.ok(result.used.some(row => row.kw === '记忆检索'));

  assert.deepEqual(f.access(), []);
});

test('digest excludes generic keywords and credits final hits only', t => {
  const messages = Array.from(
    { length: 65 },
    (_, i) => `星露谷 普通聊天 ${i}`
  );

  messages.push('记忆检索方案');

  const f = fixture(t, messages);
  f.build();

  const result = f.json('digest.cjs', [
    '星露谷 记忆检索'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.failed, 0);
  assert.equal(result.count, 1);

  assert.ok(!result.used.some(row => row.kw === '星露谷'));
  assert.ok(result.hits[0].line.includes('记忆检索方案'));

  assert.deepEqual(f.access(), [{
    message_id: result.hits[0].id,
    hits: 1
  }]);
});

test('batch retrieves Chinese trigrams and two-character terms', t => {
  const f = fixture(t, [
    '记忆检索方案',
    '微信聊天记录',
    '无关消息'
  ]);

  f.build();

  const result = f.json('recall.cjs', [
    '--batch', '记忆检索,微信',
    '--no-hit',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(result.count, 2);
  assert.equal(result.mode, 'mixed');

  assert.ok(result.rows.some(row =>
    row.text.includes('记忆检索')
  ));

  assert.ok(result.rows.some(row =>
    row.text.includes('微信')
  ));

  assert.deepEqual(f.access(), []);
});

test('batch deduplicates by message identity, not display text', t => {
  const f = fixture(t, [
    '记忆检索方案',
    '记忆检索方案',
    '其他记忆'
  ]);

  f.build();

  const result = f.json('recall.cjs', [
    '--batch', '记忆,检索方案,记忆检索,记忆',
    '--no-hit',
    '--json'
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.equal(result.count, 3);

  const ids = result.rows.map(row => row.id);

  assert.equal(new Set(ids).size, 3);

  const duplicates = result.rows.filter(row =>
    row.text === '记忆检索方案'
  );

  // Same content, but two independent messages.
  assert.equal(duplicates.length, 2);
  assert.notEqual(duplicates[0].id, duplicates[1].id);

  for (const row of duplicates) {
    assert.equal(row.kws.length, 3);
    assert.equal(new Set(row.kws).size, 3);
  }

  assert.deepEqual(f.access(), []);
});

test('batch credits only final selected rows, once per message', t => {
  const f = fixture(t, [
    '记忆检索方案',
    '记忆检索记录',
    '其他记忆'
  ]);

  f.build();

  const args = [
    '--batch', '记忆,记忆检索,检索',
    '--limit', '1',
    '--json'
  ];

  const first = f.json('recall.cjs', args);

  assert.equal(first.total, 3);
  assert.equal(first.count, 1);

  const id = first.rows[0].id;

  assert.deepEqual(f.access(), [{
    message_id: id,
    hits: 1
  }]);

  const second = f.json('recall.cjs', args);

  assert.equal(second.rows[0].id, id);

  assert.deepEqual(f.access(), [{
    message_id: id,
    hits: 2
  }]);

  f.json('recall.cjs', [...args, '--no-hit']);

  assert.deepEqual(f.access(), [{
    message_id: id,
    hits: 2
  }]);
});

test('re-indexing unchanged logs is idempotent', t => {
  const f = fixture(t, [
    '第一条记忆',
    '第二条记忆',
    '第三条记忆'
  ]);

  const first = f.build();

  assert.match(first, /scanned=1\b/);
  assert.match(first, /total=3\b/);

  const before = f.query(`
    SELECT id, uniq, text FROM msgs ORDER BY id
  `);

  const second = f.build();

  assert.match(second, /scanned=0\b/);
  assert.match(second, /skipped=1\b/);
  assert.match(second, /total=3\b/);

  const after = f.query(`
    SELECT id, uniq, text FROM msgs ORDER BY id
  `);

  assert.deepEqual(after, before);

  assert.equal(
    f.query('SELECT COUNT(*) AS n FROM fts')[0].n,
    3
  );
});

test('stable message identity and recall counters survive re-indexing', t => {
  const f = fixture(t, [
    '记忆检索方案',
    '其他消息'
  ]);

  f.build();

  const first = f.json('recall.cjs', [
    '记忆检索方案',
    '--json'
  ]);

  const stableId = first.rows[0].id;

  const before = f.query(
    'SELECT id FROM msgs WHERE uniq = ?',
    stableId
  )[0].id;

  assert.equal(f.access()[0].hits, 1);

  // Modify the log, forcing a real re-index.
  f.writeLog([
    '记忆检索方案',
    '其他消息',
    '新增消息'
  ]);

  const future = new Date(Date.now() + 2000);
  fs.utimesSync(f.logfile, future, future);

  const output = f.build();

  assert.match(output, /scanned=1\b/);
  assert.match(output, /total=3\b/);

  const after = f.query(
    'SELECT id FROM msgs WHERE uniq = ?',
    stableId
  )[0].id;

  // The old index builder reinserts rows with new numeric IDs.
  assert.notEqual(before, after);

  const second = f.json('recall.cjs', [
    '记忆检索方案',
    '--no-hit',
    '--json'
  ]);

  assert.equal(second.rows[0].id, stableId);
  assert.equal(second.rows[0].hits, 1);
  assert.equal(f.access()[0].hits, 1);

  assert.equal(
    f.query('SELECT COUNT(*) AS n FROM fts')[0].n,
    3
  );
});

test('capped totals distinguish 500 from more than 500', t => {
  const messages = Array.from(
    { length: 501 },
    (_, i) => `通用关键词 ${i}`
  );

  const f = fixture(t, messages);
  f.build();

  const result = f.json('recall.cjs', [
    '通用关键词',
    '--limit', '1',
    '--no-hit',
    '--json'
  ]);

  assert.equal(result.total, 500);
  assert.equal(result.totalCapped, true);
  assert.equal(result.count, 1);

  assert.deepEqual(f.access(), []);
});
