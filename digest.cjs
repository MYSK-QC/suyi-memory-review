// 记忆检索小工具 v3：不依赖分词库，用「3-4字片段 + 稀有度过滤」抽词
// 用法: node digest.cjs "他刚说的那句话"
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const RECALL = path.join(__dirname, 'recall.cjs');
const MAX_TOTAL = 60;   // 命中数超过这个的关键词视为「太泛」，丢掉
const MAX_KW = 12;

const STOP = new Set(['我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '不是', '没有', '还是', '就是', '因为', '所以', '知道', '觉得', '时候', '东西', '真的', '应该', '一个', '现在', '今天', '昨天', '明天', '刚才', '的话', '一点', '这样', '那样', '如果', '但是', '而且', '然后', '已经', '还有', '那些', '这些', '自己', '起来', '出来', '过来', '下来', '上去', '了的', '是的', '不错', '有点', '好像']);

function extractKeywords(text) {
  // 先把引用段剥掉：[引用 某人：xxx] 里的内容不是「现在这句话」，拿它当关键词会翻回一堆自己引用自己的话
  const noQuote = String(text || '').replace(/\[引用[^\]]*\]/g, ' ');
  const cleaned = noQuote.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const out = [];
  const seen = new Set();
  const zh = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zh) {
    for (const len of [4, 3]) {
      for (let i = 0; i + len <= run.length; i++) {
        const w = run.slice(i, i + len);
        if (STOP.has(w) || seen.has(w)) continue;
        seen.add(w);
        out.push(w);
      }
    }
  }
  const en = cleaned.match(/[a-zA-Z]{3,}/g) || [];
  for (const w of en) if (!seen.has(w)) { seen.add(w); out.push(w); }
  return out.slice(0, MAX_KW * 2);
}

const pad = n => String(n).padStart(2, '0');
function fmtTs(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function query(kw) {
  try {
    const raw = execFileSync(process.execPath, [RECALL, kw, '--limit', '4', '--json'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    const j = JSON.parse(raw.trim());
    if (!j || !j.ok) return { total: -1, lines: [] };
    const lines = j.rows.map(r => `[${fmtTs(r.ts)}] ${r.who}：${r.text}`);
    return { total: (typeof j.total === "number" ? j.total : j.count), lines };
  } catch (e) { return { total: -1, lines: [] }; }
}

const hits = new Map();
function addHit(line, kw) {
  const cur = hits.get(line) || { line, kws: [] };
  if (!cur.kws.includes(kw)) cur.kws.push(kw);
  hits.set(line, cur);
}

function main() {
  const text = process.argv.slice(2).join(' ');
  if (!text) { console.log(JSON.stringify({ ok: true, hits: [] })); return; }
  const kws = extractKeywords(text);
  const used = [];
  let failed = 0;
  for (const kw of kws) {
    const r = query(kw);
    if (r.total < 0) { failed++; continue; }
    if (r.total > MAX_TOTAL) continue;   // 太泛，跳过
    if (r.lines.length === 0) continue;
    used.push({ kw, total: r.total });
    for (const line of r.lines) addHit(line, kw);
    if (used.length >= MAX_KW) break;
  }
  const list = [...hits.values()].sort((a, b) => b.kws.length - a.kws.length).slice(0, 5)
    .map(h => ({ line: h.line.length > 200 ? h.line.slice(0, 200) + '…' : h.line, kws: h.kws }));
  // 失败兜底：全部查询都挂了就明说，别假装「没找到」（桥那边要能区分「没结果」和「坏了」）
  if (failed > 0 && used.length === 0 && kws.length > 0) {
    console.log(JSON.stringify({ ok: false, error: 'all_queries_failed', failed, tried: kws.length }));
    return;
  }
  console.log(JSON.stringify({ ok: true, used, count: list.length, hits: list, failed }, null, 0));
}

main();