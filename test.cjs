// 最小回归测试：node test.cjs
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DIR = __dirname;
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}

function run(script, args) {
  try {
    return execFileSync(process.execPath, [path.join(DIR, script), ...(args || [])], {
      encoding: 'utf8', timeout: 60000, windowsHide: true
    }).trim();
  } catch (e) { return ''; }
}

// 1. 零命中时 --json 必须返回合法空结构，不能打印人类可读文本
const zeroRaw = run('recall.cjs', ['zzz_no_such_thing_' + Date.now(), '--json']);
let zero = null;
try { zero = JSON.parse(zeroRaw); } catch { }
check('零命中时 --json 返回合法 JSON', !!zero && zero.ok === true, zeroRaw.slice(0, 120));
check('零命中时 total=0 且 rows 为空', !!zero && zero.total === 0 && Array.isArray(zero.rows) && zero.rows.length === 0);

// 2. 泛词过滤：命中数过大的词应被 digest 丢掉
const digestRaw = run('digest.cjs', ['星露谷夏天种什么最赚钱']);
let digest = null;
try { digest = JSON.parse(digestRaw); } catch { }
check('digest 返回合法 JSON', !!digest && digest.ok === true, digestRaw.slice(0, 120));
check('泛词被过滤（used 里不含「星露谷」）', !!digest && Array.isArray(digest.used) && !digest.used.some(x => x.kw === '星露谷'), JSON.stringify(digest && digest.used));

// 3. 重复建索引不应重复插入
const out1 = run('build-index.cjs', []);
const out2 = run('build-index.cjs', []);
const m1 = out1.match(/total=(\d+)/);
const m2 = out2.match(/total=(\d+)/);
check('两次建索引后的总条数一致', !!m1 && !!m2 && m1[1] === m2[1], (m1 && m1[1]) + ' vs ' + (m2 && m2[1]));
check('第二次全部跳过（scanned=0）', /scanned=0/.test(out2), out2.slice(0, 160));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);