'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB = process.env.RECALL_DB ||
  path.join(
    process.env.RECALL_DIR || 'D:/qq-bridge/state/recall',
    'recall.db'
  );

const COUNT_CAP = 500;
const MAX_TERMS = 24;
const HALF_LIFE_DAYS = 45;
const DAY_MS = 86400000;

function parseArgs(args) {
  const opts = {
    q: null,
    batch: null,
    since: null,
    who: null,
    limit: 15,
    maxTotal: Infinity,
    maxKeywords: MAX_TERMS,
    around: false,
    raw: false,
    json: false,
    noHit: false
  };

  function integer(value, max) {
    if (!/^\d+$/.test(value || '')) {
      throw new Error('Expected a positive integer');
    }

    const n = Number(value);

    if (!Number.isSafeInteger(n) || n < 1 || n > max) {
      throw new Error(`Integer must be between 1 and ${max}`);
    }

    return n;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    function next() {
      const value = args[++i];

      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }

      return value;
    }

    switch (arg) {
      case '--batch':
        opts.batch = next();
        break;
      case '--since':
        opts.since = next();
        break;
      case '--who':
        opts.who = next();
        break;
      case '--limit':
        opts.limit = integer(next(), COUNT_CAP);
        break;
      case '--max-total':
        opts.maxTotal = integer(next(), COUNT_CAP);
        break;
      case '--max-keywords':
        opts.maxKeywords = integer(next(), MAX_TERMS);
        break;
      case '--around':
        opts.around = true;
        break;
      case '--raw':
        opts.raw = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--no-hit':
        opts.noHit = true;
        break;
      default:
        if (arg.startsWith('--') || opts.q !== null) {
          throw new Error(`Unexpected argument: ${arg}`);
        }
        opts.q = arg;
    }
  }

  if (opts.batch !== null && opts.q !== null) {
    throw new Error('Use either a keyword or --batch');
  }

  const terms = opts.batch !== null
    ? opts.batch.split(/[,，]/u)
    : [opts.q || ''];

  opts.keywords = [...new Set(
    terms.map(w => w.trim().toLowerCase()).filter(Boolean)
  )];

  if (!opts.keywords.length) {
    throw new Error('No keywords supplied');
  }

  if (opts.keywords.length > MAX_TERMS) {
    throw new Error(`Maximum ${MAX_TERMS} keywords`);
  }

  if (opts.keywords.some(w => w.includes('\0'))) {
    throw new Error('Invalid keyword');
  }

  if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }

  return opts;
}

// Use stable message keys instead of transient numeric row IDs.
// Migrate the legacy counters once, where the old row still exists.
function initAccess(db) {
  const tables = new Set(
    db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table'
        AND name IN ('access', 'access_by_key')
    `).all().map(r => r.name)
  );

  if (tables.has('access_by_key')) return;

  db.exec(`
    CREATE TABLE access_by_key (
      message_id TEXT PRIMARY KEY NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      last_hit INTEGER NOT NULL DEFAULT 0
    )
  `);

  if (tables.has('access')) {
    db.exec(`
      INSERT OR IGNORE INTO access_by_key
        (message_id, hits, last_hit)
      SELECT m.uniq, a.hits, a.last_hit
      FROM access a
      JOIN msgs m ON m.id = a.id
      WHERE m.uniq IS NOT NULL
    `);
  }
}

function ftsLiteral(word) {
  return '"' + word.replace(/"/g, '""') + '"';
}

// Build one compound SQL statement for the entire batch.
//
// Long keywords use FTS5 first, with literal fallback.
// Keywords shorter than three characters use substring matching.
//
// COUNT_CAP + 1 lets us distinguish exactly 500 from >500.
function fetchCandidates(db, opts) {
  const ctes = [];
  const selects = [];
  const params = [];

  const filters = [];
  const filterParams = [];

  if (opts.since) {
    filters.push('m.day >= ?');
    filterParams.push(opts.since);
  }

  if (opts.who) {
    filters.push('m.who = ?');
    filterParams.push(opts.who);
  }

  const extra = filters.length
    ? ' AND ' + filters.join(' AND ')
    : '';

  const columns = `
    m.uniq AS id,
    m.ts,
    m.day,
    m.who,
    substr(m.text, 1, 1200) AS text,
    COALESCE(a.hits, 0) AS hits
  `;

  const accessJoin = `
    LEFT JOIN access_by_key a
      ON a.message_id = m.uniq
  `;

  opts.keywords.forEach((kw, i) => {
    const name = `k${i}`;
    const ftsName = `f${i}`;
    const useFts = [...kw].length >= 3;

    if (useFts) {
      ctes.push(`
        ${ftsName} AS MATERIALIZED (
          SELECT ? AS kw,
                 ${columns},
                 bm25(fts) AS rank,
                 'fts' AS mode
          FROM fts
          JOIN msgs m ON m.id = fts.rowid
          ${accessJoin}
          WHERE fts MATCH ?
            AND m.uniq IS NOT NULL
            ${extra}
          ORDER BY rank ASC, m.id ASC
          LIMIT ${COUNT_CAP + 1}
        )
      `);

      params.push(kw, ftsLiteral(kw), ...filterParams);
    }

    // instr() treats %, _ and other characters literally.
    // SQLite lower() handles ASCII case folding.
    const fallback = `
      SELECT ? AS kw,
             ${columns},
             0 AS rank,
             'like' AS mode
      FROM msgs m
      ${accessJoin}
      WHERE instr(lower(m.text), lower(?)) > 0
        AND m.uniq IS NOT NULL
        ${useFts
          ? `AND NOT EXISTS (SELECT 1 FROM ${ftsName})`
          : ''}
        ${extra}
      ORDER BY m.ts DESC, m.id ASC
      LIMIT ${COUNT_CAP + 1}
    `;

    ctes.push(`
      ${name} AS MATERIALIZED (
        ${useFts
          ? `SELECT * FROM ${ftsName} UNION ALL`
          : ''}
        SELECT * FROM (${fallback})
      )
    `);

    params.push(kw, kw, ...filterParams);
    selects.push(`SELECT * FROM ${name}`);
  });

  const sql = `
    WITH ${ctes.join(',\n')}
    ${selects.join('\nUNION ALL\n')}
  `;

  return db.prepare(sql).all(...params);
}

function rankCandidates(rows, opts, now) {
  const groups = new Map(
    opts.keywords.map(kw => [kw, []])
  );

  for (const row of rows) {
    groups.get(row.kw).push(row);
  }

  const totals = opts.keywords.map(kw => ({
    kw,
    total: Math.min(groups.get(kw).length, COUNT_CAP),
    totalCapped: groups.get(kw).length > COUNT_CAP
  }));

  // Filter generic keywords BEFORE scoring or crediting.
  const selectedTerms = totals.filter(t =>
    t.total > 0 &&
    t.total <= opts.maxTotal &&
    !(t.totalCapped && Number.isFinite(opts.maxTotal))
  ).slice(0, opts.maxKeywords);

  const used = selectedTerms.map(({ kw, total }) => ({
    kw,
    total
  }));

  const merged = new Map();
  const batch = opts.batch !== null;
  const modes = new Set();

  for (const { kw, total } of selectedTerms) {
    const rarity = 1 / Math.log2(total + 2);

    for (const row of groups.get(kw).slice(0, COUNT_CAP)) {
      modes.add(row.mode);

      let hit = merged.get(row.id);

      if (!hit) {
        hit = {
          id: row.id,
          ts: row.ts,
          day: row.day,
          who: row.who,
          text: row.text.replace(/\s+/gu, ' ').trim(),
          hits: row.hits,
          kws: [],
          base: 0
        };

        merged.set(row.id, hit);
      }

      if (hit.kws.includes(kw)) continue;

      hit.kws.push(kw);

      if (batch) {
        // Rarer matching keywords contribute more.
        hit.base += rarity;
      } else {
        // Preserve BM25-based ranking for single queries.
        hit.base += row.mode === 'fts'
          ? Math.max(0, -row.rank)
          : 1;
      }
    }
  }

  const ranked = [...merged.values()];

  for (const hit of ranked) {
    const ageDays = Math.max(0, (now - hit.ts) / DAY_MS);

    const recency =
      0.55 + 0.45 * Math.pow(
        0.5, ageDays / HALF_LIFE_DAYS
      );

    const rehearsal = 1 + 0.35 * Math.log1p(hit.hits);

    hit.score = opts.raw
      ? hit.base
      : hit.base * recency * rehearsal;
  }

  ranked.sort((a, b) =>
    b.score - a.score ||
    b.ts - a.ts ||
    a.id.localeCompare(b.id)
  );

  const results = ranked
    .slice(0, opts.limit)
    .map(({ base, ...row }) => ({
      ...row,
      text: [...row.text].slice(0, 300).join('')
    }));

  return {
    ok: true,
    q: opts.keywords.join(','),
    since: opts.since,
    who: opts.who,
    mode: modes.size > 1
      ? 'mixed'
      : [...modes][0] || 'like',
    total: merged.size,
    totalCapped: selectedTerms.some(t => t.totalCapped),
    count: results.length,
    used,
    totals,
    rows: results
  };
}

// Credit each selected stable message ID exactly once.
function creditHits(db, rows, now) {
  const bump = db.prepare(`
    INSERT INTO access_by_key(message_id, hits, last_hit)
    VALUES (?, 1, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      hits = hits + 1,
      last_hit = excluded.last_hit
  `);

  for (const id of new Set(rows.map(row => row.id))) {
    bump.run(id, now);
  }
}

function search(opts, filename = DB) {
  if (!fs.existsSync(filename)) {
    throw new Error(`Recall database not found: ${filename}`);
  }

  const db = new DatabaseSync(filename);

  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');

    try {
      initAccess(db);

      const now = Date.now();
      const candidates = fetchCandidates(db, opts);
      const result = rankCandidates(candidates, opts, now);

      if (!opts.noHit) {
        creditHits(db, result.rows, now);
      }

      if (opts.around && result.rows.length) {
        const top = result.rows[0];

        result.context = db.prepare(`
          SELECT ts, who, text
          FROM msgs
          WHERE ts BETWEEN ? AND ?
          ORDER BY ts ASC
        `).all(
          top.ts - 40 * 60000,
          top.ts + 40 * 60000
        );
      }

      db.exec('COMMIT');

      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

function fmtTs(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printHuman(result) {
  if (!result.rows.length) {
    console.log('(没找到)');
    return;
  }

  console.log(
    `命中 ${result.total}${result.totalCapped ? '+' : ''} 条` +
    `（返回 ${result.count} 条，关键词：${result.q}）`
  );

  for (const row of result.rows) {
    const hits = row.hits ? `·${row.hits}` : '';

    console.log(
      `[${fmtTs(row.ts)}]${hits} ${row.who}：` +
      row.text.slice(0, 220)
    );
  }

  if (result.context) {
    console.log('\n—— 那一条的上下文 ——');

    for (const row of result.context) {
      const text = row.text.replace(/\s+/gu, ' ').slice(0, 200);
      console.log(`[${fmtTs(row.ts)}] ${row.who}：${text}`);
    }
  }
}

function main(args = process.argv.slice(2)) {
  try {
    const opts = parseArgs(args);
    const result = search(opts);

    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      printHuman(result);
    }
  } catch (e) {
    if (args.includes('--json')) {
      console.log(JSON.stringify({
        ok: false,
        error: e.message,
        total: 0,
        count: 0,
        rows: []
      }));
    } else {
      console.error(e.message);
    }

    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  search,
  fetchCandidates,
  rankCandidates
};