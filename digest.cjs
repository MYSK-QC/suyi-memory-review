// 记忆检索小工具 v2：输入当前消息，输出命中的旧话（只读）
// 用法: node digest.cjs "他刚说的那句话"
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const RECALL = path.join(__dirname, 'recall.cjs');

const STOP = new Set(['我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '不是', '没有', '还是', '就是', '因为', '所以', '知道', '觉得', '时候', '东西', '真的', '应该', '一个', '现在', '今天', '昨天', '明天', '刚才', '的话', '一点', '这样', '那样', '如果', '但是', '而且', '然后', '已经', '还有', '那些', '这些', '自己', '起来', '出来', '过来', '下来', '上去', '了的', '是的', '不错', '有点', '好像']);

function extractKeywords(text) {
  const cleaned = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const freq = new Map();
  const zh = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zh) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const w = run.slice(i, i + 2);
      if (STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    if (run.length >= 3 && run.length <= 6) freq.set(run, (freq.get(run) || 0) + 2);
  }
  const en = cleaned.match(/[a-zA-Z]{3,}/g) || [];
  for (const w of en.slice(0, 4)) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 10);
}

function search(keyword) {
  try {
    const out = execFileSync(process.execPath, [RECALL, keyword, '--limit', '4'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    return out.split('\n').map(s => s.trim()).filter(s => s.startsWith('['));
  } catch (e) { return []; }
}

const hits = new Map();
function addHit(line, kw) {
  if (!line.startsWith('[')) return;
  const cur = hits.get(line) || { line, kws: [], n: 0 };
  if (!cur.kws.includes(kw)) { cur.kws.push(kw); cur.n += 1; }
  hits.set(line, cur);
}

function main() {
  const text = process.argv.slice(2).join(' ');
  if (!text) { console.log(JSON.stringify({ ok: true, hits: [] })); return; }
  const kws = extractKeywords(text);
  for (const kw of kws) {
    for (const line of search(kw)) addHit(line, kw);
    if (hits.size >= 20) break;
  }
  const list = [...hits.values()].sort((a, b) => b.n - a.n).slice(0, 5)
    .map(h => ({ line: h.line.length > 220 ? h.line.slice(0, 220) + '…' : h.line, kws: h.kws }));
  console.log(JSON.stringify({ ok: true, keywords: kws, count: list.length, hits: list }, null, 0));
}

main();