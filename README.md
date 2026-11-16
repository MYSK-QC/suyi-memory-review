# suyi-memory（溯的记忆）

给 QQ 桥加一层「翻旧账」的**只读**检索：他提到旧人/旧事/旧词时，从我过去所有对话里翻出相关原话，列出来再回答。

## 为什么

现在的记忆是「每轮把整份文本塞进上下文」——越记越多、越用越贵，也分不清哪条是现在的、哪条是三个月前的。
这一层不替换记忆文件，只负责**按需检索**。

## 组成

| 文件 | 作用 |
|---|---|
| `build-index.cjs` | 遍历会话日志（zstd 压缩的 jsonl），建/增量更新 SQLite 全文索引 |
| `recall.cjs` | 按关键词/日期/说话人查旧话，输出 `[MM-DD HH:mm] 他/鱼：原文` |
| `digest.cjs` | 给一句话，自动抽词 → 查 → 列出命中的旧话（JSON） |

索引来源：`C:\Users\DFY\.dsh\sessions\**\session.v4.jsonl.zstd`

## 用法

```bash
# 建索引（首次约 1 分钟，之后增量很快）
node build-index.cjs

# 手动查
node recall.cjs 关键词 [--since 2026-11-01] [--who 他|鱼] [--limit 10]

# 拿一句话让它自己翻（给桥调用）
node digest.cjs "他刚说的那句话"
```

`digest.cjs` 输出：

```json
{"ok":true,"keywords":["记忆","插件"],"count":5,"hits":[{"line":"[11-12 20:37] 他：…","kws":["记忆"]}]}
```

## 已知问题（待改）

1. **中文没分词器**：现在用二元组滑窗抽词，会抽出一堆碎词（「你上」「次说」），命中率还行但精度差。
   改进方向：接分词库（如 nodejieba），或改成整句模糊匹配 + 相关度排序。
2. **泛词污染**：高频词（如「你上」）会带回大量无关记录，需要按「命中总数」给词降权。
3. 索引是手动的，还没接计划任务（原来的 DSH-Recall-Index 每天 04:10 增量重建，可以复用）。

## 铁律

- **只读**：这一层绝不写记忆文件、不改 DSH 配置、不动桥的核心逻辑。
- 桥侧要用，就做成独立进程由桥去调；不许直接改 `bridge.js` 的会话逻辑（踩过事故）。
- 仓库里不放任何配置和密钥。

## 踩过的坑

- 会话日志是 `zstd` 压缩的 JSONL，Node 26 的 `zlib.zstdDecompressSync` 直接能解。
- FTS5 中文要 `tokenize='trigram'`，不然搜不到子串。
- 他自己的话要从唤醒提示里的【本次消息快照】JSON 里抠（按 messageId 去重），不能只看 user/message 的正文。
## 更新记录

- v1：二元组滑窗抽词，能跑但碎词多、精度差。
- v2：加了停用词、按命中次数排序，仍不理想。
- v3（当前）：改成「3-4 字长片段 + 稀有度过滤」——先查这个词在索引里命中多少条，超过 40 条视为太泛直接丢掉，只留稀有词。
  - 试过 nodejieba（真正的中文分词），**Windows 上装不上**：要 Visual Studio 的 C++ 编译环境，本机没有。
  - v3 实测：问「星露谷夏天种什么」能翻出 11-08 我说过的「真正的翻身在夏天种蓝莓」。
  - 仍存在的问题：如果输入里带引用文本（「你上次说的那个」），会把这句引用本身也翻出来——调用方要先把引用段剥掉。

## 配置与开关（2026-11-17 更新）

**路径可配**（环境变量优先，读不到用默认值）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `RECALL_SESS_ROOT` | 会话日志目录 | `C:/Users/DFY/.dsh/sessions` |
| `RECALL_DIR` | 索引输出目录 | `D:/qq-bridge/state/recall` |
| `RECALL_DB` | 索引数据库文件 | `D:/qq-bridge/state/recall/recall.db` |

**命令行开关**：

- `recall.cjs ... --json` 输出固定 JSON（`{ok, q, since, who, mode, total, count, rows}`）；零命中时也返回空结构，不会打印文本。
- `recall.cjs ... --no-hit` 纯净只读模式：不更新 `access` 表的访问计数（默认会更新，用来给常被翻到的旧话加权）。
- `digest.cjs "一句话"` 输出 JSON：`{ok, used:[{kw,total}], count, hits:[{line,kws}]}`。

**索引构建的统计**：`build-index.cjs` 现在会报 `decompressFailed` / `invalidJson`，并把失败文件列在 `--- failed files ---` 下面——不再静默吞错。

**total 的语义**：`total` 是这条查询在索引里的真实命中数（上限 500），`count` 是本次按 `--limit` 返回的条数。`digest.cjs` 用 `total` 判断泛词（>60 丢掉），用 `count` 决定显示几条。

## 测试（2026-11-17 加）

```bash
node test.cjs
```

不引第三方框架，检查四件事：

1. 零命中时 `--json` 返回合法空结构（`{ok:true,total:0,rows:[]}`），不会打印人类可读文本。
2. `digest.cjs` 输出合法 JSON。
3. 泛词被过滤（命中数 > 60 的词不出现在 `used` 里）。
4. 重复跑 `build-index.cjs` 不会重复插入（total 不变、第二次 `scanned=0`）。

**当前结果：6 passed, 0 failed。**

## 事务（2026-11-17 加）

`build-index.cjs` 现在用 `BEGIN IMMEDIATE` 把「删该会话旧记录 → 重新插入」包成一条事务：

- 删除失败 → `ROLLBACK` 并跳过这个文件（记进 `failures`）。
- 插入完 → `COMMIT`，成功之后才写 `files` 表的 mtime/size（避免下次误以为已索引）。
- 中途异常 → 事务回滚，不会留下半份索引。
