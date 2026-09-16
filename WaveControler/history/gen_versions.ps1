# ============================================================================
# gen_versions.ps1 - 扫描 history/app/ 下的历史版本目录，生成 versions.js
# ----------------------------------------------------------------------------
# 用法（任选一种）：
#   1) 双击本文件 / 右键“使用 PowerShell 运行”
#   2) 终端：powershell -ExecutionPolicy Bypass -File history\gen_versions.ps1
#   3) 不想结束时暂停：在命令后面加 -NoPause
# 说明：脚本自动定位自身所在目录（$PSScriptRoot），在任何工作目录下运行都正确。
# ============================================================================

param([switch]$NoPause)

$ErrorActionPreference = 'Stop'

$here    = $PSScriptRoot
if (-not $here) { $here = (Get-Location).Path }
$appDir  = Join-Path $here 'app'
$outFile = Join-Path $here 'versions.js'
$utf8    = New-Object System.Text.UTF8Encoding($false)

Write-Host ''
Write-Host '=== UFO 波形控制器 历史版本清单生成器 ===' -ForegroundColor Cyan
Write-Host "版本目录: $appDir"

if (-not (Test-Path $appDir)) {
  Write-Host "错误：找不到版本目录，请先创建：$appDir" -ForegroundColor Red
  exit 1
}

# 读取 UTF-8 文本（同时兼容带/不带 BOM）
function Read-Utf8([string]$path) {
  return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

# 排序键：把每段数字左补 0 到 6 位，使字符串排序等价于按数字排序（v1.10 > v1.9）
function Get-SortKey([string]$name) {
  $key = ''
  foreach ($part in [regex]::Split($name, '(\d+)')) {
    if ($part -match '^\d+$') { $key += $part.PadLeft(6, '0') } else { $key += $part.ToLower() }
  }
  # 不含数字的名字（如 beta）视为更旧，排在所有带版本号的目录之后
  if ($name -match '\d') { return '1' + $key }
  return '0' + $key
}

# 检查归档快照里的本地资源引用是否真的存在。
# 背景：快照被复制进 app/vX/ 后位于更深的目录，任何指向快照目录之外的相对路径
# （例如早期写法 ../style.css 想引用仓库根的那份）都会指错目录 —— 页面能打开却缺 CSS。
# 现在 WaveControler/ 自带 style.css，页面统一用 ./style.css，快照自带全部依赖后不再有这问题；
# 这里按 file:// 的相对语义逐个解析 href/src，缺了就报警，防止以后又归档出“能开但没样式”的版本。
function Get-BrokenRefs([string]$htmlPath) {
  $dir  = Split-Path $htmlPath
  $html = Read-Utf8 $htmlPath
  $bad  = @()
  foreach ($m in [regex]::Matches($html, '(?:href|src)="([^"]+)"')) {
    $raw = $m.Groups[1].Value
    if ($raw -match '^(https?:|//|data:|mailto:|javascript:|#|/)') { continue }
    $u = ($raw -split '[?#]')[0]                                  # 去掉 ?query / #hash
    if ($u -eq '') { continue }
    try { $u = [uri]::UnescapeDataString($u) } catch { }           # 还原 %20 之类
    $u = $u -replace '/', '\'
    if (-not (Test-Path (Join-Path $dir $u))) { $bad += $raw }
  }
  return $bad
}

# JS 双引号字符串转义（反斜杠必须最先处理）
function Escape-Js([string]$s) {
  $s = $s -replace '\\', '\\'
  $s = $s -replace '"', '\"'
  $s = $s -replace "`t", '\t'
  $s = $s -replace "`r`n", '\n'
  $s = $s -replace "`n", '\n'
  $s = $s -replace "`r", '\n'
  return $s
}

# ---------- 扫描版本目录（按版本号降序，第一个即最新版本） ----------
$dirs = @(Get-ChildItem -Path $appDir -Directory | Sort-Object -Property { Get-SortKey $_.Name } -Descending)

$items      = @()
$missing    = @()
$noSnapshot = @()
$badRefs    = @()

for ($i = 0; $i -lt $dirs.Count; $i++) {
  $name     = $dirs[$i].Name
  $isLatest = ($i -eq 0)
  $readme   = Join-Path $dirs[$i].FullName 'readme.txt'

  if (Test-Path $readme) {
    $desc = Read-Utf8 $readme
    $desc = $desc -replace "`r`n", "`n"
    $desc = $desc.TrimEnd([char[]]"`n ")
  } else {
    $desc = '（缺少 readme.txt）'
    $missing += $name
  }

  # 跳转链接（相对 history/ 目录）：最新版本直接指向主站控制界面 WaveApp.html
  $url = "app/$name/WaveApp.html"
  if ($isLatest) { $url = '../WaveApp.html' }

  # 非最新版本必须真的归档了 WaveApp.html，否则卡片会 404
  $snapshot = Join-Path $dirs[$i].FullName 'WaveApp.html'
  if (-not $isLatest -and -not (Test-Path $snapshot)) {
    $noSnapshot += $name
  }

  # 快照存在时，检查它引用的本地资源是否都能解析到（缺 CSS 是最常见的归档事故）
  if ((Test-Path $snapshot) -and -not $isLatest) {
    $broken = Get-BrokenRefs $snapshot
    if ($broken.Count -gt 0) { $badRefs += [pscustomobject]@{ Ver = $name; Refs = $broken } }
  }

  $items += [pscustomobject]@{
    Dir    = $name
    Title  = $name
    Desc   = $desc
    Latest = $isLatest
    Url    = $url
  }
}

# ---------- 生成 versions.js ----------
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('// ---------------------------------------------------------------------------')
[void]$sb.AppendLine('// 本文件由 history/gen_versions.ps1 自动生成，请勿手改（重新运行脚本会被覆盖）。')
[void]$sb.AppendLine('// 新增/删除历史版本后，重新运行脚本即可刷新本文件：')
[void]$sb.AppendLine('//   powershell -ExecutionPolicy Bypass -File history\gen_versions.ps1')
[void]$sb.AppendLine('// 字段：dir=版本目录名  title=版本号  desc=readme.txt 原文')
[void]$sb.AppendLine('//       latest=是否最新版本  url=跳转链接（相对 history/ 目录）')
[void]$sb.AppendLine('// ---------------------------------------------------------------------------')
[void]$sb.AppendLine('window.UFO_VERSIONS = [')

for ($i = 0; $i -lt $items.Count; $i++) {
  $it  = $items[$i]
  $end = ','
  if ($i -eq $items.Count - 1) { $end = '' }
  [void]$sb.AppendLine('  {')
  [void]$sb.AppendLine(('    "dir": "{0}",'    -f (Escape-Js $it.Dir)))
  [void]$sb.AppendLine(('    "title": "{0}",'  -f (Escape-Js $it.Title)))
  [void]$sb.AppendLine(('    "desc": "{0}",'   -f (Escape-Js $it.Desc)))
  [void]$sb.AppendLine(('    "latest": {0},'   -f $it.Latest.ToString().ToLower()))
  [void]$sb.AppendLine(('    "url": "{0}"'     -f (Escape-Js $it.Url)))
  [void]$sb.AppendLine(('  }' + $end))
}

[void]$sb.AppendLine('];')
[System.IO.File]::WriteAllText($outFile, $sb.ToString(), $utf8)

# ---------- 控制台核对信息 ----------
Write-Host ''
if ($items.Count -eq 0) {
  Write-Host '未生成任何版本条目（app 目录下没有版本文件夹）。' -ForegroundColor Yellow
} else {
  Write-Host ("共扫描到 {0} 个版本，最新版本：{1}" -f $items.Count, $items[0].Title) -ForegroundColor Green
  Write-Host ''
  foreach ($it in $items) {
    $tag = '   '
    if ($it.Latest) { $tag = '★  ' }
    Write-Host ("{0}{1}   →   {2}" -f $tag, $it.Title, $it.Url)
    Write-Host ("      readme: {0}" -f ($it.Desc -replace "`n", ' / ')) -ForegroundColor DarkGray
  }
}

if ($missing.Count -gt 0) {
  Write-Host ''
  Write-Host ("警告：以下版本目录缺少 readme.txt（已填占位文案）：{0}" -f ($missing -join ', ')) -ForegroundColor Yellow
}

if ($noSnapshot.Count -gt 0) {
  Write-Host ''
  Write-Host ("警告：以下历史版本目录里没有 WaveApp.html 快照，卡片链接会 404。" -f $null) -ForegroundColor Yellow
  Write-Host ("      请把该版本的页面文件（WaveApp.html / wc.css / presets.js / js/*.js 等）复制进去：{0}" -f ($noSnapshot -join ', ')) -ForegroundColor Yellow
}

if ($badRefs.Count -gt 0) {
  Write-Host ''
  Write-Host '警告：以下快照里有解析不到的本地资源引用（页面能打开，但会缺 CSS / 缺脚本）：' -ForegroundColor Yellow
  foreach ($b in $badRefs) {
    Write-Host ("      {0}：{1}" -f $b.Ver, ($b.Refs -join ', ')) -ForegroundColor Yellow
  }
  Write-Host '      常见原因：快照比原位置深了若干层，指向快照目录之外的相对路径会指错目录。' -ForegroundColor Yellow
  Write-Host '      修法：把缺失的文件一起复制进该快照目录（WaveApp.html / wc.css / presets.js / style.css / js/*.js），' -ForegroundColor Yellow
  Write-Host '            或把引用改成能正确解析的相对路径。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host ("已写入：{0}（{1} 字节）" -f $outFile, (Get-Item $outFile).Length) -ForegroundColor Cyan

if (-not $NoPause) {
  Write-Host ''
  Write-Host '按任意键关闭...' -ForegroundColor DarkGray
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
}
