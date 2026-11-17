Add-Type -AssemblyName System.Drawing
$W = 1400; $H = 1000
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'ClearTypeGridFit'
$g.Clear([System.Drawing.Color]::FromArgb(250, 250, 252))

$fontTitle = New-Object System.Drawing.Font('Microsoft YaHei', 20, [System.Drawing.FontStyle]::Bold)
$fontBox = New-Object System.Drawing.Font('Microsoft YaHei', 13)
$fontSmall = New-Object System.Drawing.Font('Microsoft YaHei', 10.5)
$fontTiny = New-Object System.Drawing.Font('Microsoft YaHei', 9.5)
$brushText = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 30, 40))
$brushSub = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 90, 105))
$penArrow = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(90, 110, 160), 2)
$penArrow.CustomEndCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap(6, 8)

function Box($x, $y, $w, $h, $title, $lines, $color) {
  $pen = New-Object System.Drawing.Pen($color, 2.5)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $color.R, $color.G, $color.B))
  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(18, $color.R, $color.G, $color.B))
  $g.FillRectangle($fill, $x, $y, $w, $h)
  $g.DrawRectangle($pen, $x, $y, $w, $h)
  $g.DrawString($title, $fontBox, $brush, ($x + 12), ($y + 9))
  $yy = $y + 40
  foreach ($ln in $lines) { $g.DrawString($ln, $fontTiny, $brushSub, ($x + 12), $yy); $yy += 20 }
  $pen.Dispose(); $brush.Dispose(); $fill.Dispose()
}
function Arrow($x1, $y1, $x2, $y2) { $g.DrawLine($penArrow, $x1, $y1, $x2, $y2) }

$g.DrawString('我的记忆插件 · 结构图', $fontTitle, $brushText, 40, 26)
$g.DrawString('2026-11-17 版（三条已改，两条等星期四）', $fontSmall, $brushSub, 42, 62)

$cBlue = [System.Drawing.Color]::FromArgb(60, 120, 210)
$cGreen = [System.Drawing.Color]::FromArgb(50, 160, 100)
$cOrange = [System.Drawing.Color]::FromArgb(220, 140, 40)
$cPurple = [System.Drawing.Color]::FromArgb(140, 90, 190)
$cGray = [System.Drawing.Color]::FromArgb(120, 120, 130)

# 输入层
Box 40 110 380 130 '① 数据源' @('会话日志 sessions\**\session.v4.jsonl.zstd', 'zstd 解压 → 逐行 JSON', '他的话 + 我的话（不要 reasoning）') $cGray
# 索引
Box 480 110 380 130 '② 索引 build-index.cjs' @('SQLite + FTS5（trigram）', '84 个文件 / 8351 条消息', '按文件 mtime+size 增量；事务包裹') $cBlue
# 检索
Box 920 110 420 130 '③ 检索 recall.cjs / digest.cjs' @('关键词查询 → [MM-DD HH:mm] 谁：原文', '--json 给程序用，--no-hit 只读不计数', 'digest 抽词：3-4 字片段 + 稀有度') $cBlue

# 记忆库
Box 480 320 380 190 '④ 记忆库 memory.cjs' @('memory.jsonl 每行一条 JSON', '类型：fact/event/preference/promise/', '      rule/self/relation', '并发锁 + 原子写（temp+fsync+rename）', '遗忘曲线 D(t)=D0·e^(-t/S)', '规矩/承诺豁免压缩；压缩可逆') $cGreen
# 检索封装
Box 920 320 420 190 '⑤ 检索封装 memory-recall.cjs' @('统一走 STORE.query（不再自己算分）', 'score = 关键词命中 × 类型权重 × 时间衰减', '  权重：规矩/承诺 1.6、自己/喜好 1.3', '  衰减：0.55 + 0.45·0.5^(天数/60)', '命中只数最终选中的，不数探测的', '错误直接抛，不吞成空结果') $cGreen

# 体检
Box 40 320 380 190 '⑥ 体检 check-memory.cjs' @('MEMORY.md / USER.md / KEY.md', '条目数、含「作废/更正」的过时条目', '--days=N 找超期未更新的') $cOrange
# 迁移
Box 40 560 380 150 '⑦ 迁移 migrate-dry.cjs' @('MEMORY.md → memory.jsonl', '干跑模式：只输出样本，不写文件', '真跑等星期四主人看着') $cOrange

# 桥
Box 480 560 860 150 '⑧ 桥 / DSH 接入（还没做）' @('时机：主人提到旧人/旧事/旧词时，组唤醒提示前先调 digest.cjs', '要求：失败就跳过，绝不阻塞主聊天；引用段先剥掉再抽词', '开关：config.json 的 socialV2.recall（默认关）') $cPurple

Arrow 420 175 480 175
Arrow 860 175 920 175
Arrow 670 240 670 320
Arrow 860 415 920 415
Arrow 420 415 480 415
Arrow 230 510 230 560
Arrow 420 635 480 635

$legend = @(
  @('已完成并测过', $cGreen),
  @('已完成（索引/检索层）', $cBlue),
  @('工具/辅助', $cOrange),
  @('待做（星期四）', $cPurple)
)
$lx = 40; $ly = 760
$g.DrawString('图例：', $fontSmall, $brushText, $lx, $ly)
$ly += 30
foreach ($item in $legend) {
  $b = New-Object System.Drawing.SolidBrush($item[1])
  $g.FillRectangle($b, $lx, $ly + 4, 16, 16)
  $g.DrawString($item[0], $fontTiny, $brushText, ($lx + 26), $ly)
  $b.Dispose()
  $ly += 26
}

$g.DrawString('五条审查意见：①存储合并✔ ②sid→source_file（星期四） ③探测不计数✔ ④压缩可逆+豁免✔ ⑤批量检索+Intl.Segmenter（星期四）', $fontTiny, $brushSub, 40, 920)
$g.DrawString('数据量：memory.jsonl 7 条 / recall.db 8351 条消息 / 会话日志 84 个文件', $fontTiny, $brushSub, 40, 945)

$out = 'D:\qq-bridge\state\recall\arch-20261117.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"OK: $out"
(Get-Item $out).Length