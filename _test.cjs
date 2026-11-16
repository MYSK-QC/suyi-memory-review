const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
try {
  db.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
  db.exec("INSERT INTO t VALUES('hello world')");
  const r = db.prepare("SELECT * FROM t WHERE t MATCH 'hello'").all();
  console.log('FTS5 ok rows=' + r.length);
} catch (e) { console.log('FTS5 FAIL ' + e.message); }
console.log('node=' + process.version);