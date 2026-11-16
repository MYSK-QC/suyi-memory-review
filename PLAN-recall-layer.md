# 记忆检索层 · 施工草稿（2026-11-11 晚定稿，明早动手）

## 目标
开口前先查一遍旧话库，把命中的几条塞进唤醒提示。**只读、不花 API 钱、不动记忆文件。**

## 现状（已有）
- `D:\qq-bridge\state\recall\` 已有 build-index.cjs + recall.cjs + recall.db（node:sqlite + FTS5，trigram 分词）
- 索引源：会话日志 zstd → 他的原话 + 我说的话
- 每天 04:10 计划任务 DSH-Recall-Index 增量重建

## 要做的三件事
1. 写 `digest.cjs <消息文本> [--limit 5]`：输出一段紧凑的「相关旧事」文本（每条 ≤60 字，带日期），给桥调用；命令行跑一次 ≤300ms。
2. 桥侧最小改动（`D:\qq-bridge\src\bridge.js`）：
   - 组唤醒提示前，取本次新消息文本 → execFile digest → 把结果拼成一个 `<recall>` 段
   - **总开关走 config.json**：`socialV2.recall = { enabled: true, limit: 5 }`；关闭只改配置，不用回滚代码
   - 失败/超时（>1.5s）就跳过，绝不阻塞消息
3. 改完必须 `node --check src\bridge.js` 通过才重启桥。

## 安全流程（他同意：坏了用另一条线救）
1. 拍快照：`snapshot-before-plugin.ps1 -Note "before-recall-layer"`
2. 备份 `bridge.js` → `bridge.js.bak-recall-YYYYMMDD`
3. 改 → `node --check` → 重启桥 → 看 `logs\bridge.log` 有没有解析错误
4. 让他发一句话验：他的消息能正常回 + 我能引用到旧事 = 成
5. 出问题：`copy bridge.js.bak-recall-* src\bridge.js` + 重启桥（或用网页端那条线）

## 同批要改的记忆规矩（抄 Mnemosyne 三条）
1. **来源标注**：记忆里每条尽量标 [事实]（他说的）/ [猜测]（我推的）/ [我说]；注入时别把猜测当事实用
2. **冲突标作废不删**：新事推翻旧事时，旧条目改写前缀「【已作废】」并注明被哪条取代，不物理删除（他定的底线：不许删记忆）
3. **时间锚点**：「下周三」「后天」这类相对时间，写进记忆前必须换算成绝对日期

## 不做
- 不装 Mnemosyne 整套（独立 Python 库 + 每次写记忆都调模型 = 换地基 + 持续花钱）
- 不上向量库（embedding 只是为了粗筛，我们数据量用 FTS5 够）