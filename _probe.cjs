const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const root = 'C:/Users/DFY/.dsh/sessions';
function walk(d, out=[]) { for (const e of fs.readdirSync(d, {withFileTypes:true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name === 'session.v4.jsonl.zstd') out.push(p); } return out; }
const files = walk(root);
console.log('sessions files=' + files.length);
let f = files.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
console.log('sample=' + f);
const raw = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
const lines = raw.split('\n').filter(Boolean);
console.log('lines=' + lines.length);
for (const ln of lines.slice(0, 4)) {
  try { const o = JSON.parse(ln); console.log('KEYS: ' + Object.keys(o).join(',')); console.log('  type=' + o.type + ' ts=' + (o.timestamp || o.ts || o.at) + ' dataKeys=' + (o.data ? Object.keys(o.data).join(',') : 'none')); } catch(e) { console.log('badline'); }
}