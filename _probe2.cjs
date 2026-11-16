const fs = require('node:fs'), zlib = require('node:zlib');
const f = 'C:/Users/DFY/.dsh/sessions/--D-qq-bridge-state-agents--/session-af94b2c6-0365-43c6-beab-9df64c436705/session.v4.jsonl.zstd';
const lines = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8').split('\n').filter(Boolean);
let seen = {};
for (const ln of lines) {
  let o; try { o = JSON.parse(ln); } catch { continue; }
  if (seen[o.type]) continue;
  seen[o.type] = 1;
  if (o.type === 'user/message' || o.type === 'assistant/message') {
    const d = o.data || {};
    console.log('== ' + o.type + ' seq=' + o.seq + ' time=' + o.time);
    console.log('   data keys: ' + Object.keys(d).join(','));
    const s = JSON.stringify(d).slice(0, 600);
    console.log('   sample: ' + s);
  }
}
console.log('--- all types ---');
console.log(Object.keys(seen).join(' | '));