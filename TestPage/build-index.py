# -*- coding: utf-8 -*-
"""
扫描本目录下的 *.html（不含 index.html），自动生成索引页 index.html。

  * 顶部：一排按钮，每个按钮显示一个文件名，点了直接跳过去
  * 下面：列表，显示 文件名 / 页面标题 / 体积 / 修改时间

浏览器不允许 file:// 页面读取目录内容，所以"自动索引"在构建期完成：
新增 html 之后重新跑一次本脚本即可。

用法:  python build-index.py
产物:  index.html（纯静态、零依赖，双击即可打开）
"""

import html
import os
import re
import sys
import time
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "index.html")
SELF = "index.html"

TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.I | re.S)
TAG_RE = re.compile(r"<[^>]+>")


def clean(text):
    """去掉标签、还原实体、把空白压成一个空格。"""
    text = TAG_RE.sub("", text or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


# 分类：按文件名归组，列表会按这个顺序分区显示。
# 没命中的文件一律进「其它」，所以新增页面不需要改这里也能正常出现。
CATEGORIES = [
    ("env",  "🖥 环境与能力", ["bt-check", "capability-check", "storage-check"]),
    ("proto","📡 协议与实现", ["ble-proto", "ai-ctrl-lab"]),
    ("data", "🎛 数据与波形", ["csv-preview"]),
    ("perf", "⏱ 时序与安全", ["tick-jitter", "safety-timing"]),
    ("net",  "🌐 远程与网络", ["net-diagnose", "ws-e2e", "remote-selftest",
                               "sync-trace", "room-lifecycle"]),
    ("infra","🧰 工程与巡检", ["ref-check"]),
]
OTHER = ("other", "📁 其它")

# 版本目录/历史归档用不上，但万一有也照样收进来


def category_of(name):
    """按文件名（不含扩展名）判断分类。"""
    stem = name.rsplit(".", 1)[0].lower()
    for key, label, names in CATEGORIES:
        if stem in names:
            return key, label
    return OTHER


def human_size(n):
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.1f KB" % (n / 1024.0)
    return "%.1f MB" % (n / 1048576.0)


def scan():
    """返回本目录下除 index.html 以外的全部 html，按文件名排序。"""
    rows = []
    for name in sorted(os.listdir(HERE), key=str.lower):
        if name.lower() == SELF or not name.lower().endswith(".html"):
            continue
        path = os.path.join(HERE, name)
        if not os.path.isfile(path):
            continue

        raw = ""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                raw = f.read()
        except OSError as exc:
            print("  !! 读取失败 %s: %s" % (name, exc))

        title = ""
        m = TITLE_RE.search(raw)
        if m:
            title = clean(m.group(1))
        if not title:
            m = H1_RE.search(raw)
            if m:
                title = clean(m.group(1))

        st = os.stat(path)
        rows.append({
            "name": name,
            "title": title,
            "size": st.st_size,
            "mtime": st.st_mtime,
        })
    return rows


CSS = r"""
  *, *::before, *::after { box-sizing: border-box; }
  body{
    margin:0 auto; max-width:900px; padding:28px 20px 60px;
    background:#0f1729; color:#e0e0e0; line-height:1.7;
    font-family:system-ui,"Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  h1{ font-size:1.5rem; color:#a78bfa; margin:0; }
  .top{
    display:flex; align-items:baseline; justify-content:space-between;
    gap:8px 16px; flex-wrap:wrap; margin:0 0 8px;
  }
  .back{
    color:#8899aa; font-size:13px; text-decoration:none; white-space:nowrap;
    border-bottom:1px dotted #4a5670;
    transition:color .18s ease,border-color .18s ease;
  }
  .back:hover{ color:#a78bfa; border-bottom-color:#a78bfa; }
  .back:focus-visible{ outline:2px solid #a78bfa; outline-offset:2px; }
  .badge{
    display:inline-block; vertical-align:middle; margin-left:6px;
    padding:2px 9px; border-radius:10px; font-size:12px; font-weight:400;
    font-family:Consolas,"Courier New",monospace;
    background:#1a1a2e; border:1px solid #0f3460; color:#8899aa;
  }
  .sub{ margin:0 0 22px; color:#8899aa; font-size:13px; }
  .sub code{
    padding:1px 6px; border-radius:3px; font-size:12px; color:#a78bfa;
    background:#1a1a2e; font-family:Consolas,"Courier New",monospace;
  }
  h2{ font-size:1rem; font-weight:600; color:#8899aa; margin:0 0 12px; }
  .cat{ margin-bottom:26px; }
  .cat[hidden]{ display:none; }
  .catn{
    display:inline-block; vertical-align:middle; margin-left:6px;
    padding:1px 8px; border-radius:9px; font-size:11px; font-weight:400;
    font-family:Consolas,"Courier New",monospace;
    background:#1a1a2e; border:1px solid #0f3460; color:#8899aa;
  }

  /* ---- 搜索 ---- */
  .search{ display:flex; gap:10px; align-items:center; margin:0 0 20px; flex-wrap:wrap; }
  .search input{
    flex:1; min-width:200px; padding:9px 12px; border-radius:6px; font-size:14px;
    background:#16213e; border:1px solid #0f3460; color:#e0e0e0;
    font-family:Consolas,"Courier New",monospace;
  }
  .search input::placeholder{ color:#5d6884; }
  .search input:focus{ outline:2px solid #a78bfa; outline-offset:1px; }
  #hitCount{ font-size:12px; color:#8899aa; font-family:Consolas,"Courier New",monospace; white-space:nowrap; }
  .noresult{ padding:16px; border-radius:8px; color:#8899aa; font-size:13px;
             background:#16213e; border:1px dashed #0f3460; }
  .noresult[hidden]{ display:none; }

  /* ---- 顶部按钮：每个按钮 = 一个文件名 ---- */
  .btns{ display:flex; flex-wrap:wrap; gap:10px; margin:0 0 28px; }
  .btn{
    display:inline-block; padding:9px 14px; border-radius:6px;
    background:#16213e; border:1px solid #0f3460; color:#e0e0e0;
    font-family:Consolas,"Courier New",monospace; font-size:13.5px;
    text-decoration:none; white-space:nowrap;
    transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease;
  }
  .btn:hover{ background:#0f3460; border-color:#a855f7; color:#fff; transform:translateY(-1px); }
  .btn:active{ transform:none; }
  .btn:focus-visible{ outline:2px solid #a78bfa; outline-offset:2px; }

  /* ---- 下方列表 ---- */
  .list{ display:flex; flex-direction:column; gap:8px; }
  .item{
    display:flex; align-items:baseline; gap:14px; padding:12px 14px;
    background:#16213e; border:1px solid #0f3460; border-radius:8px;
    color:inherit; text-decoration:none;
    transition:background .18s ease,border-color .18s ease;
  }
  .item:hover{ background:#1b2a4d; border-color:#a855f7; }
  .item:focus-visible{ outline:2px solid #a78bfa; outline-offset:2px; }
  .fn{ flex:0 0 auto; color:#a78bfa; font-size:13.5px; font-family:Consolas,"Courier New",monospace; }
  .ti{ flex:1 1 auto; min-width:0; color:#c8c8d4; font-size:14px;
       overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ti.none{ color:#5d6884; font-style:italic; }
  .meta{ flex:0 0 auto; color:#8899aa; font-size:12px; font-family:Consolas,"Courier New",monospace; }
  .empty{
    margin:0; padding:16px; border-radius:8px; color:#8899aa; font-size:13px;
    background:#16213e; border:1px dashed #0f3460;
  }
  .foot{
    margin-top:30px; padding-top:14px; font-size:12px; color:#66708a;
    border-top:1px solid #0f3460;
  }

  @media (max-width:620px){
    body{ padding:20px 14px 44px; }
    h1{ font-size:1.28rem; }
    .btn{ font-size:13px; padding:8px 12px; }
    .item{ flex-wrap:wrap; gap:3px 12px; }
    .ti{ flex-basis:100%; white-space:normal; }
    .meta{ flex-basis:100%; }
  }
"""

TPL = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>TestPage 索引</title>
<style>
/*{{CSS}}*/
</style>
</head>
<body>

<div class="top">
<h1>TestPage 索引<span class="badge">{{COUNT}}</span></h1>
<a class="back" href="../index.html">← 返回 UFO Player 首页</a>
</div>
<p class="sub">本页由 <code>build-index.py</code> 扫描本目录自动生成 · 新增 html 文件后重新运行一次即可刷新</p>

<div class="search">
  <input type="search" id="q" placeholder="搜索文件名或标题…（例如 ble、远程、时序）" autocomplete="off">
  <span id="hitCount"></span>
</div>

<h2>快速跳转</h2>
<div class="btns">
{{BTNS}}
</div>

<h2>文件列表</h2>
<div id="cats">
{{ITEMS}}
</div>
<p class="noresult" id="noresult" hidden>没有匹配的页面。换个关键词，或清空搜索框。</p>

<div class="foot">
  生成于 {{STAMP}}
</div>

<script>
(function () {
  var q = document.getElementById('q');
  var items = Array.prototype.slice.call(document.querySelectorAll('.item'));
  var btns  = Array.prototype.slice.call(document.querySelectorAll('.btn'));
  var cats  = Array.prototype.slice.call(document.querySelectorAll('.cat'));
  var hits  = document.getElementById('hitCount');
  var none  = document.getElementById('noresult');

  function norm(s) { return String(s || '').toLowerCase(); }
  function targetOf(el) {
    try { return decodeURIComponent(el.getAttribute('href') || ''); }
    catch (e) { return el.getAttribute('href') || ''; }
  }

  function apply() {
    var key = norm(q.value).trim();
    var visible = {};

    cats.forEach(function (cat) {
      // 分区标题也算匹配条件：搜「远程」应该把整个「远程与网络」都列出来，
      // 而不是只命中标题里恰好带「远程」的那两条。
      var catHit = !!key && norm(cat.querySelector('h2').textContent).indexOf(key) >= 0;
      var any = false;
      Array.prototype.forEach.call(cat.querySelectorAll('.item'), function (el) {
        var hit = !key || catHit || norm(el.textContent).indexOf(key) >= 0;
        el.style.display = hit ? '' : 'none';
        if (hit) { any = true; visible[targetOf(el)] = 1; }
      });
      cat.hidden = !any;
    });

    // 顶部按钮跟着列表走，两边永远一致
    btns.forEach(function (el) {
      el.style.display = visible[targetOf(el)] ? '' : 'none';
    });

    var shown = Object.keys(visible).length;
    hits.textContent = key ? ('匹配 ' + shown + ' / ' + items.length) : ('共 ' + items.length + ' 个页面');
    none.hidden = !(key && shown === 0);
  }

  q.addEventListener('input', apply);
  q.addEventListener('keydown', function (e) { if (e.key === 'Escape') { q.value = ''; apply(); } });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  });
  apply();
})();
</script>

</body>
</html>
"""


def main():
    rows = scan()

    if rows:
        btns = "\n".join(
            '  <a class="btn" href="%s">%s</a>'
            % (html.escape(quote(r["name"]), quote=True), html.escape(r["name"]))
            for r in rows
        )

        def item_html(r):
            return (
                '  <a class="item" href="%s">\n'
                '    <span class="fn">%s</span>\n'
                '    <span class="ti%s">%s</span>\n'
                '    <span class="meta">%s · %s</span>\n'
                '  </a>'
                % (
                    html.escape(quote(r["name"]), quote=True),
                    html.escape(r["name"]),
                    "" if r["title"] else " none",
                    html.escape(r["title"]) if r["title"] else "（未提取到 &lt;title&gt;）",
                    human_size(r["size"]),
                    time.strftime("%Y-%m-%d %H:%M", time.localtime(r["mtime"])),
                )
            )

        # 按分类分组，组内保持文件名升序
        groups = {}
        for r in rows:
            groups.setdefault(category_of(r["name"]), []).append(r)

        order = [(k, lbl) for k, lbl, _ in CATEGORIES] + [OTHER]
        blocks = []
        for key, label in order:
            got = groups.get((key, label))
            if not got:
                continue
            blocks.append(
                '<div class="cat">\n'
                '  <h2>%s<span class="catn">%d</span></h2>\n'
                '  <div class="list">\n%s\n  </div>\n'
                '</div>'
                % (html.escape(label), len(got), "\n".join(item_html(r) for r in got))
            )
        items = "\n".join(blocks)
    else:
        btns = '  <p class="empty">本目录下暂时没有可跳转的 html 文件。</p>'
        items = '  <p class="empty">本目录下暂时没有其它 html 文件。</p>'

    out = (TPL
           .replace("/*{{CSS}}*/", CSS)
           .replace("{{COUNT}}", str(len(rows)))
           .replace("{{BTNS}}", btns)
           .replace("{{ITEMS}}", items)
           .replace("{{STAMP}}", time.strftime("%Y-%m-%d %H:%M")))

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)

    print("目录      : %s" % HERE)
    print("输出      : %s  (%d 字节)" % (OUT, len(out.encode("utf-8"))))
    print("收录 %d 个 html（已排除 index.html）:" % len(rows))
    for r in rows:
        flag = "" if r["title"] else "   <- 没有 <title>"
        print("  %-22s %8s  %s%s" % (r["name"], human_size(r["size"]), r["title"], flag))
    if not rows:
        print("  (无)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
