// recall index builder: extract his words + my words from DSH session logs into SQLite FTS5
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const SESS_ROOT = process.env.RECALL_SESS_ROOT || 'C:/Users/DFY/.dsh/sessions';
const OUT_DIR = process.env.RECALL_DIR || 'D:/qq-bridge/state/recall';
const DB_PATH = path.join(OUT_DIR, 'recall.db');
fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;`);
db.exec(`CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, mtime INTEGER, size INTEGER, n INT);`);
db.exec(`CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, day TEXT, who TEXT, text TEXT, sid TEXT, uniq TEXT UNIQUE);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_msgs_day ON msgs(day);`);
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text, tokenize='trigram');`);

const insMsg = db.prepare(`INSERT OR IGNORE INTO msgs(ts, day, who, text, sid, uniq) VALUES(?,?,?,?,?,?)`);
const insFts = db.prepare(`INSERT INTO fts(rowid, text) VALUES(?,?)`);
const getFile = db.prepare(`SELECT mtime, size FROM files WHERE path=?`);
const setFile = db.prepare(`INSERT INTO files(path,mtime,size,n) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, n=excluded.n`);

function walk(d, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'session.v4.jsonl.zstd') out.push(p);
  }
  return out;
}

const pad = n => String(n).padStart(2, '0');
function dayOf(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function resolveAt(at, baseMs) {
  if (!at) return baseMs;
  let m = /^(\d{2}):(\d{2})$/.exec(at);
  if (m) { const b = new Date(baseMs); b.setHours(+m[1], +m[2], 0, 0); return b.getTime(); }
  m = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at);
  if (m) { const b = new Date(baseMs); b.setMonth(+m[1] - 1, +m[2]); b.setHours(+m[3], +m[4], 0, 0); return b.getTime(); }
  return baseMs;
}
function extractSnapshot(text) {
  const out = [];
  const tag = '【本次消息快照】';
  const i = text.indexOf(tag);
  if (i < 0) return out;
  let rest = text.slice(i + tag.length);
  const nl = rest.indexOf('\n');
  if (nl >= 0) rest = rest.slice(nl + 1);
  let end = rest.indexOf('\n以上消息');
  let jsonStr = (end >= 0 ? rest.slice(0, end) : rest).trim();
  if (!jsonStr.startsWith('{')) {
    const s = jsonStr.indexOf('{');
    if (s < 0) return out;
    jsonStr = jsonStr.slice(s);
  }
  try {
    const j = JSON.parse(jsonStr);
    for (const m of (j.messages || [])) {
      const t = (m.text || '').trim();
      if (!t) continue;
      const isOwner = m.isOwner === true || m.sender === '私聊';
      if (!isOwner) continue;
      out.push({ at: m.at, sender: m.sender, text: t, mid: m.messageId });
    }
  } catch (e) { }
  return out;
}

let files = walk(SESS_ROOT);
let added = 0, skipped = 0, scanned = 0, decompressFailed = 0, invalidJson = 0;
const failures = [];
for (const f of files) {
  let st; try { st = fs.statSync(f); } catch { continue; }
  const prev = getFile.get(f);
  if (prev && prev.mtime === Math.floor(st.mtimeMs) && prev.size === st.size) { skipped++; continue; }
  let raw;
  try { raw = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8'); } catch (e) { decompressFailed++; failures.push(f + ' :: ' + e.message); continue; }
  scanned++;
  const sid = path.basename(path.dirname(f));
    // 这个文件内容变了：先清掉之前为它建过的记录，避免旧内容残留（一个会话目录对应一个日志文件）
    try {
      db.prepare('DELETE FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE sid=?)').run(sid);
      db.prepare('DELETE FROM msgs WHERE sid=?').run(sid);
    } catch { }
  let n = 0;
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { invalidJson++; continue; }
    const t = o.type;
    if (t === 'user/message') {
      const base = o.time || Date.now();
      for (const c of ((o.data && o.data.content) || [])) {
        if (c.type !== 'text' || !c.text) continue;
        for (const s of extractSnapshot(c.text)) {
          const ts = resolveAt(s.at, base);
          const uniq = `u:${sid}:${s.mid || ts}`;
          const r = insMsg.run(ts, dayOf(ts), '他', s.text, sid, uniq);
          if (r.changes) { insFts.run(r.lastInsertRowid, s.text); added++; n++; }
        }
      }
    } else if (t === 'assistant/message') {
      const base = o.time || Date.now();
      const msg = (o.data && o.data.message) || {};
      const txt = ((msg.content) || []).filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n').trim();
      if (!txt) continue;
      const uniq = `a:${sid}:${o.seq}`;
      const r = insMsg.run(base, dayOf(base), '鱼', txt, sid, uniq);
      if (r.changes) { insFts.run(r.lastInsertRowid, txt); added++; n++; }
    }
  }
  setFile.run(f, Math.floor(st.mtimeMs), st.size, n);
}
const c = db.prepare('SELECT COUNT(*) c FROM msgs').get();
const d = db.prepare("SELECT day, COUNT(*) c FROM msgs GROUP BY day ORDER BY day DESC LIMIT 5").all();
console.log(`files=${files.length} scanned=${scanned} skipped=${skipped} added=${added} total=${c.c} decompressFailed=${decompressFailed} invalidJson=${invalidJson}`);
if (failures.length) { console.log("--- failed files ---"); for (const x of failures) console.log(x); }
console.log('recent days: ' + d.map(x => `${x.day}:${x.c}`).join(' '));
db.close();