const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('D:/qq-bridge/state/recall/recall.db', { readOnly: true });
console.log('cols:', db.prepare('PRAGMA table_info(msgs)').all().map(c => c.name).join(','));
const rows = db.prepare('SELECT * FROM msgs WHERE text LIKE ? LIMIT 4').all('%99次我爱他%');
for (const r of rows) console.log(JSON.stringify(r).slice(0, 400));
db.close();