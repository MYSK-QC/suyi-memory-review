'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const RECALL = path.join(__dirname, 'recall.cjs');
const MAX_TOTAL = 60;
const MAX_KW = 12;
const MAX_HITS = 5;

const STOP = new Set(`
  我们 你们 他们 她们 这个 那个 什么 怎么
  可以 不是 没有 还是 就是 因为 所以
  知道 觉得 时候 东西 真的 应该 一个
  现在 今天 昨天 明天 刚才 的话 一点
  这样 那样 如果 但是 而且 然后 已经
  还有 那些 这些 自己 起来 出来 过来
  下来 上去 了的 是的 不错 有点 好像
  上次 之前 以前 后来 那句 这句 句话
  说的 说过 提到 刚刚 是不是 有没有
  一下 能不能 记得 不记得 告诉
  你 我 他 她 它 咱 这 那 的 了 是
  就 吗 呢 吧 啊 呀 嘛 着 最 又 也
`.trim().split(/\s+/u));

const HAN = /^\p{Script=Han}+$/u;
const BAD_HEAD = /^[你我他她它咱这那的了是就]/u;
const BAD_TAIL = /[的了着吗呢吧啊嘛呀]$/u;

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null;

function extractKeywords(text) {
  const clean = String(text ?? '')
    .normalize('NFKC')
    .replace(/\[引用[^\]]*\]/gu, ' ');

  const primary = new Set();
  const secondary = new Set();

  function add(target, word) {
    const w = word.trim().toLowerCase();
    if (!w || STOP.has(w)) return;

    if (HAN.test(w)) {
      const len = [...w].length;
      if (len < 2 || len > 4) return;
      if (BAD_HEAD.test(w) || BAD_TAIL.test(w)) return;
    } else if (w.length < 2) {
      return;
    }

    target.add(w);
  }

  // Technical identifiers: Node.js, GPT-4, SHA256, etc.
  for (const w of clean.match(
    /[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*/g
  ) || []) {
    add(primary, w);
  }

  for (const run of clean.match(/\p{Script=Han}+/gu) || []) {
    const words = segmenter
      ? [...segmenter.segment(run)].map(s => s.segment)
      : [...run];

    // Don't generate compounds across stopword boundaries.
    const groups = [];
    let group = [];

    for (const word of words) {
      if (STOP.has(word)) {
        if (group.length) groups.push(group);
        group = [];
      } else {
        group.push(word);
      }
    }

    if (group.length) groups.push(group);

    for (const tokens of groups) {
      // Prefer actual segmented words.
      for (const word of tokens) {
        add(primary, word);
      }

      // Combine neighboring meaningful words.
      for (let i = 0; i < tokens.length; i++) {
        let compound = '';

        for (let j = i; j < tokens.length; j++) {
          compound += tokens[j];
          const len = [...compound].length;

          if (len > 4) break;

          if (j > i && len >= 2) {
            add(secondary, compound);
          }
        }
      }

      // Trigram fallback for names and unknown terms.
      const chars = [...tokens.join('')];

      for (const len of [3, 4, 2]) {
        for (let i = 0; i + len <= chars.length; i++) {
          add(secondary, chars.slice(i, i + len).join(''));
        }
      }
    }
  }

  return [...new Set([...primary, ...secondary])]
    .slice(0, MAX_KW * 2);
}

function fmtTs(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(text, limit) {
  const chars = [...text];

  return chars.length > limit
    ? chars.slice(0, limit).join('') + '…'
    : text;
}

function digest(text) {
  const kws = extractKeywords(text);

  const empty = {
    ok: true,
    used: [],
    count: 0,
    hits: [],
    failed: 0
  };

  if (!kws.length) return empty;

  try {
    // The batch process credits only the final returned rows.
    // No separate probe or touch subprocess is needed.
    const output = execFileSync(process.execPath, [
      RECALL,
      '--batch', kws.join(','),
      '--max-total', String(MAX_TOTAL),
      '--max-keywords', String(MAX_KW),
      '--limit', String(MAX_HITS),
      '--json'
    ], {
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const r = JSON.parse(output);

    if (!r.ok) {
      throw new Error(r.error || 'Recall failed');
    }

    if (!Array.isArray(r.rows) || !Array.isArray(r.used)) {
      throw new Error('Invalid recall response');
    }

    const hits = r.rows.map(row => ({
      id: row.id,
      line: truncate(
        `[${fmtTs(row.ts)}] ${row.who}：${row.text}`,
        200
      ),
      kws: row.kws
    }));

    return {
      ok: true,
      used: r.used,
      count: hits.length,
      hits,
      failed: 0
    };
  } catch (e) {
    let detail = e.message;

    try {
      const response = JSON.parse(String(e.stdout || ''));
      detail = response.error || detail;
    } catch {}

    return {
      ok: false,
      error: 'all_queries_failed',
      detail,
      failed: kws.length,
      tried: kws.length
    };
  }
}

if (require.main === module) {
  const result = digest(process.argv.slice(2).join(' '));

  console.log(JSON.stringify(result));

  if (!result.ok) process.exitCode = 1;
}

module.exports = { extractKeywords, digest };