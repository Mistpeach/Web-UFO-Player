# -*- coding: utf-8 -*-
"""
把 ../1.md（fakeUFO 教程）渲染成带左侧可折叠导航栏的静态网页。

设计原则（对应任务硬性约束）：
  * 只改排版，不改文字：原文每一行都原样输出（HTML 转义除外），
    不删除/新增/替换任何字符；标题的"编号"只是被包进 <span> 以便着色，
    拼接后的文本与原文逐字一致。
  * 换行语义保留：原文每一个非空行 -> 一个独立的 <p class="ln">，
    并配合 white-space: pre-wrap，行内多个空格也不会被压缩。
  * 图片路径可用：<img src="../xxx.png">（html/ 的上一级就是图片所在目录）。

用法：  python build.py
产物：  index.html（纯静态、零第三方库、file:// 双击即可打开）
"""

import html
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))   # docs/fakeufodocs/html
DOCDIR = os.path.dirname(HERE)                      # docs/fakeufodocs
SRC = os.path.join(DOCDIR, "1.md")
OUT = os.path.join(HERE, "index.html")

# --------------------------------------------------------------------------
# 1. 解析
# --------------------------------------------------------------------------

# 编号标题：0.写在前面 / 1.1 电烙铁 / 2.4.1.1 登录或注册 / 3.2.2 烧录固件
#   末尾的 \.? 用来吃掉"0.写在前面"里那个充当分隔符的点（它属于原文，必须保留在文字里）
HEAD_RE = re.compile(r"^(\d+(?:\.\d+)*\.?)([ \t\u3000]*)(.*)$")

MAX_HEAD_LEN = 42          # 标题不可能很长；用来挡掉 "10克以内焊锡丝…" 这类正文
BAD_TAIL = "。"            # 标题不会以句号结尾


def num_core(num):
    """去掉可能存在的结尾点：'0.' -> '0'，'2.4.1' -> '2.4.1'。"""
    return num.rstrip(".")


def num_level(num):
    return len(num_core(num).split("."))


def num_anchor(num):
    return "sec-" + num_core(num).replace(".", "-")


def as_heading(line):
    """判断一行是否是编号标题，是则返回 (编号, 分隔空白, 余下文字)。"""
    if not line or line[0] in " \t":
        return None
    m = HEAD_RE.match(line)
    if not m:
        return None
    num, sep, rest = m.group(1), m.group(2), m.group(3)
    if not rest or len(line) > MAX_HEAD_LEN:
        return None
    if BAD_TAIL in rest:
        return None
    parts = num_core(num).split(".")
    if len(parts) > 4 or any(len(p) > 2 for p in parts):
        return None
    # 编号后没有空白时，必须紧跟非 ASCII 字符：
    # 挡掉 "3.5mm耳机插座母座…"（3.5 + m）和 "3d打印外壳文件在这里面"（3 + d）
    if not sep:
        c = rest[0]
        if c.isascii() and (c.isalnum() or c in "_-+."):
            return None
    return num, sep, rest


# 图片与裸链接
IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
TOKEN_RE = re.compile(
    r"!\[(?P<alt>[^\]]*)\]\((?P<src>[^)\s]+)\)"
    r"|(?P<url>https?://[^\s<>\"'()\[\]{}（）【】《》，。；！？、]+)"
)


def split_blocks(raw):
    """把原文切成 (类型, 数据) 序列：h=标题 / p=正文段落组 / fig=纯图片行。"""
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    items, para = [], []

    def flush():
        if para:
            items.append(("p", list(para)))
            del para[:]

    for line in lines:
        if line.strip() == "":
            flush()
            continue
        head = as_heading(line)
        if head:
            flush()
            items.append(("h", head))
            continue
        rest = IMG_RE.sub("", line)
        if rest.strip() == "" and IMG_RE.search(line):
            flush()
            items.append(("fig", IMG_RE.findall(line)))
            continue
        para.append(line)
    flush()
    return items


# --------------------------------------------------------------------------
# 2. 工具
# --------------------------------------------------------------------------

def esc_text(s):
    """正文转义：只动 & < >，引号等一律原样保留。"""
    return html.escape(s, quote=False)


def esc_attr(s):
    return html.escape(s, quote=True)


def is_external(src):
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", src)) or src.startswith("//")


def resolve_src(src):
    """把文档里的相对图片路径改成相对 html/ 的路径（图片在上一级目录）。"""
    if is_external(src) or src.startswith("/") or src.startswith("#"):
        return src
    if src.startswith("./"):
        src = src[2:]
    if src.startswith("../"):
        return src
    return "../" + src


def png_size(path):
    """读 PNG 头部拿原始宽高，写进 width/height 属性以避免图片加载时跳动。"""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    return (int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big"))


MISSING = []


def img_tag(src, alt, inline=False):
    rel = resolve_src(src)
    if not is_external(src):
        p = os.path.join(DOCDIR, src.replace("/", os.sep))
        if not os.path.isfile(p):
            MISSING.append(src)
            return "<!-- missing image: %s -->" % esc_text(src)
        size = png_size(p)
    else:
        size = None
    cls = "doc-img doc-img-inline" if inline else "doc-img"
    out = '<img class="%s" src="%s" alt="%s" loading="lazy" decoding="async"' % (
        cls, esc_attr(rel), esc_attr(alt))
    if size:
        out += ' width="%d" height="%d"' % size
    return out + ">"


def render_line(line, inline_images=True):
    """一行文本 -> HTML：图片转 <img>，裸链接转 <a>，其余原样转义。"""
    out, pos = [], 0
    for m in TOKEN_RE.finditer(line):
        out.append(esc_text(line[pos:m.start()]))
        if m.group("alt") is not None:
            out.append(img_tag(m.group("src"), m.group("alt"), inline=inline_images))
        else:
            url = m.group("url")
            out.append('<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>'
                       % (esc_attr(url), esc_text(url)))
        pos = m.end()
    out.append(esc_text(line[pos:]))
    return "".join(out)


# --------------------------------------------------------------------------
# 3. 导航树
# --------------------------------------------------------------------------

class Node(object):
    def __init__(self, num, sep, rest, level):
        self.num, self.sep, self.rest, self.level = num, sep, rest, level
        self.text = num + sep + rest           # 与原文逐字一致
        self.anchor = num_anchor(num)
        self.children = []
        self.parent = None


def build_tree(heads):
    roots, stack = [], []
    for num, sep, rest in heads:
        node = Node(num, sep, rest, num_level(num))
        while stack and stack[-1].level >= node.level:
            stack.pop()
        if stack:
            node.parent = stack[-1]
            stack[-1].children.append(node)
        else:
            roots.append(node)
        stack.append(node)
    return roots


def render_nav(node, out):
    has_kids = bool(node.children)
    cls = "nav-item open" if has_kids else "nav-item"
    out.append('<li class="%s" data-lvl="%d">' % (cls, node.level))
    out.append('<div class="nav-row">')
    out.append('<a class="nav-link" href="#%s">%s</a>'
               % (node.anchor, esc_text(node.text)))
    if has_kids:
        out.append('<button class="nav-caret" type="button" aria-expanded="true"'
                   ' aria-label="展开或收起此章节"><i></i></button>')
    out.append("</div>")
    if has_kids:
        out.append('<ul class="nav-sub">')
        for child in node.children:
            render_nav(child, out)
        out.append("</ul>")
    out.append("</li>")


# --------------------------------------------------------------------------
# 4. 正文
# --------------------------------------------------------------------------

def render_body(items):
    out, open_sec = [], False
    for kind, data in items:
        if kind == "h":
            num, sep, rest = data
            level = num_level(num)
            anchor = num_anchor(num)
            if open_sec:
                out.append("</section>")
            out.append('<section class="sec lvl%d" id="%s">' % (level, anchor))
            open_sec = True
            tag = "h%d" % min(level, 6)
            tight = "" if sep else " hnum-tight"
            out.append('<%s class="doc-h lvl%d"><span class="hnum%s">%s</span>%s</%s>'
                       % (tag, level, tight, esc_text(num), esc_text(sep + rest), tag))
            continue
        if kind == "fig":
            if not open_sec:
                out.append('<section class="sec sec-intro">')
                open_sec = True
            out.append('<div class="fig">')
            for alt, src in data:
                out.append(img_tag(src, alt))
            out.append("</div>")
            continue
        # 正文段落组
        if not open_sec:
            out.append('<section class="sec sec-intro">')
            open_sec = True
        out.append('<div class="blk">')
        for line in data:
            bullet = " ln-bullet" if line[:1] in ("●", "•", "·") else ""
            out.append('<p class="ln%s">%s</p>' % (bullet, render_line(line)))
        out.append("</div>")
    if open_sec:
        out.append("</section>")
    return "".join(out)


# --------------------------------------------------------------------------
# 5. 模板
# --------------------------------------------------------------------------

CSS = r"""
*, *::before, *::after { box-sizing: border-box; }
:root{
  --bg:#1a1a2e; --panel:#16213e; --line:#0f3460; --line-soft:#22304d;
  --text:#e0e0e0; --text-dim:#a8a8bd; --muted:#888; --faint:#666;
  --accent:#a78bfa; --accent-2:#a855f7; --violet:#533483;
  --grad:linear-gradient(135deg,#533483,#a855f7);
  --code-bg:#131322;
  --sbw:302px; --topbar:56px;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',
         'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
}
html,body{ height:100%; }
body{
  margin:0; font-family:var(--font); background:var(--bg); color:var(--text);
  display:flex; flex-direction:column; height:100vh; height:100dvh; overflow:hidden;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
::selection{ background:rgba(168,85,247,.35); color:#fff; }
a{ color:var(--accent); }

/* ---------- 顶栏 ---------- */
#topbar{
  position:relative; z-index:50; flex:0 0 auto;
  display:flex; align-items:center; gap:10px; height:var(--topbar);
  padding:0 14px;
  padding-left:calc(14px + env(safe-area-inset-left));
  padding-right:calc(14px + env(safe-area-inset-right));
  background:var(--panel); border-bottom:1px solid var(--line);
}
.spacer{ flex:1 1 auto; min-width:0; }
.doc-label{
  color:#fff; font-size:14.5px; font-weight:600; text-decoration:none;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:52vw;
}
.doc-label:hover{ color:var(--accent); }
.icon-btn{
  display:inline-flex; align-items:center; justify-content:center;
  flex:0 0 auto; width:32px; height:32px; padding:0;
  border:1px solid var(--line); border-radius:6px;
  background:var(--bg); color:var(--text); cursor:pointer; text-decoration:none;
  transition:background .2s ease,color .2s ease,border-color .2s ease;
}
.icon-btn:hover{ background:var(--line); color:#fff; }
.icon-btn:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }
.icon-btn svg{ width:18px; height:18px; display:block; }
#progress{
  position:absolute; left:0; bottom:-1px; height:2px; width:0;
  background:var(--grad); z-index:2; transition:width .08s linear;
}

/* ---------- 布局 ---------- */
#layout{ display:flex; flex:1 1 auto; min-height:0; position:relative; }
#sidebar{
  flex:0 0 var(--sbw); width:var(--sbw); min-width:0;
  display:flex; flex-direction:column; overflow:hidden;
  background:var(--panel); border-right:1px solid var(--line);
}
#sidebar.collapsed{ display:none; }
#sbHeader{
  display:none; align-items:center; gap:8px; flex:0 0 auto;
  height:var(--topbar); padding:0 12px; border-bottom:1px solid var(--line);
}
#navScroll{
  flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden;
  padding:10px 8px 44px; overscroll-behavior:contain;
  scrollbar-width:thin; scrollbar-color:#243254 transparent;
}
#navScroll::-webkit-scrollbar{ width:10px; }
#navScroll::-webkit-scrollbar-thumb{ background:#243254; border-radius:6px; }
#navScroll::-webkit-scrollbar-thumb:hover{ background:#2f4570; }
#navScroll::-webkit-scrollbar-track{ background:transparent; }

/* ---------- 导航树 ---------- */
#nav{ list-style:none; margin:0; padding:0; font-size:13.5px; }
#nav ul{ list-style:none; margin:0; padding:0; }
.nav-sub{ position:relative; padding-left:10px; }
.nav-sub::before{
  content:""; position:absolute; left:5px; top:0; bottom:2px; width:1px;
  background:var(--line);
}
.nav-item > .nav-sub{ display:none; }
.nav-item.open > .nav-sub{ display:block; }
.nav-row{ display:flex; align-items:flex-start; gap:2px; margin:1px 0; }
.nav-link{
  flex:1 1 auto; min-width:0; display:block; padding:6px 4px 6px 9px;
  border-left:2px solid transparent; border-radius:6px;
  color:var(--text-dim); text-decoration:none; line-height:1.45;
  overflow-wrap:break-word;
  transition:background .15s ease,color .15s ease;
}
.nav-link:hover{ background:rgba(15,52,96,.55); color:#fff; }
.nav-link.active{
  background:linear-gradient(90deg,rgba(83,52,131,.62),rgba(168,85,247,.14));
  color:#fff; border-left-color:var(--accent); font-weight:600;
}
.nav-caret{
  flex:0 0 auto; width:24px; height:26px; margin:1px 1px 0 0; padding:0;
  display:inline-flex; align-items:center; justify-content:center;
  background:none; border:0; border-radius:5px; cursor:pointer;
}
.nav-caret:hover{ background:rgba(15,52,96,.7); }
.nav-caret:focus-visible{ outline:2px solid var(--accent); outline-offset:-2px; }
.nav-caret i{
  display:block; width:6px; height:6px; margin-top:-3px;
  border-right:1.5px solid #8e8ea8; border-bottom:1.5px solid #8e8ea8;
  transform:rotate(-45deg); transition:transform .2s ease;
}
.nav-item.open > .nav-row .nav-caret i{ transform:rotate(45deg); margin-top:-1px; }
.nav-sub .nav-link{ font-size:13px; }
.nav-sub .nav-sub .nav-link{ font-size:12.5px; }
.nav-sub .nav-sub .nav-sub .nav-link{ font-size:12px; }

/* ---------- 内容区 ---------- */
#content{
  flex:1 1 auto; min-width:0; overflow-y:auto; overscroll-behavior:contain;
  scroll-behavior:smooth; scrollbar-width:thin; scrollbar-color:#243254 transparent;
}
#content::-webkit-scrollbar{ width:12px; }
#content::-webkit-scrollbar-thumb{ background:#243254; border-radius:6px; }
#content::-webkit-scrollbar-thumb:hover{ background:#2f4570; }
#doc{
  max-width:900px; margin:0 auto; padding:30px 30px 100px;
  font-size:15.5px; line-height:1.9; color:#dcdce8;
}
.sec, .doc-h{ scroll-margin-top:18px; }
.sec.lvl1{ margin-top:46px; padding-top:28px; border-top:1px solid var(--line); }
.sec.lvl1:first-of-type{ margin-top:0; padding-top:0; border-top:0; }
.sec.lvl2{ margin-top:32px; }
.sec.lvl3{ margin-top:24px; }
.sec.lvl4{ margin-top:20px; }
.doc-h{ margin:0; font-weight:700; line-height:1.45; }
.doc-h.lvl1{
  font-size:1.6rem; color:#fff; letter-spacing:.3px;
  padding-bottom:10px; border-bottom:1px solid var(--line);
}
.doc-h.lvl2{
  font-size:1.24rem; color:#ecebff;
  padding-left:12px; border-left:3px solid var(--violet);
}
.doc-h.lvl3{
  font-size:1.08rem; color:#dad4ff;
  padding-left:12px; border-left:2px solid #2a4a7f;
}
.doc-h.lvl4{
  font-size:1rem; color:#c8beff;
  padding-left:12px; border-left:2px solid var(--line-soft);
}
.hnum{ color:var(--accent); font-weight:800; font-variant-numeric:tabular-nums; }
.hnum-tight{ margin-right:.34em; }

.blk{ margin:0 0 14px; }
.sec > .blk:last-child{ margin-bottom:0; }
.ln{ margin:0; white-space:pre-wrap; overflow-wrap:break-word; }
.ln-bullet{ padding-left:1.5em; text-indent:-1.5em; }
.sec > .blk:first-of-type{ margin-top:12px; }
.doc-h + .blk{ margin-top:12px; }

/* ---------- 图片 ---------- */
.fig{
  margin:14px 0; display:flex; flex-wrap:wrap; gap:12px;
  align-items:flex-start; justify-content:center;
}
.doc-img{
  display:block; max-width:100%; height:auto; border-radius:8px;
  border:1px solid var(--line); background:#101020; cursor:zoom-in;
  box-shadow:0 6px 22px rgba(0,0,0,.38);
  transition:border-color .2s ease,box-shadow .2s ease;
}
.doc-img:hover{ border-color:var(--violet); box-shadow:0 8px 28px rgba(83,52,131,.45); }
.doc-img-inline{ display:inline-block; vertical-align:middle; margin:8px 4px; }

/* ---------- 富文本（本文档暂无，样式先备好） ---------- */
#doc a{
  color:var(--accent); text-decoration:underline;
  text-decoration-color:rgba(167,139,250,.4); text-underline-offset:3px;
  overflow-wrap:anywhere;
}
#doc a:hover{ color:#c4b5fd; text-decoration-color:#c4b5fd; }
blockquote{
  margin:14px 0; padding:10px 16px; color:#c9c9dd;
  border-left:3px solid var(--violet); border-radius:0 6px 6px 0;
  background:rgba(15,52,96,.35);
}
blockquote p{ margin:0; }
code{
  font-family:var(--mono); font-size:.9em; color:var(--accent);
  background:var(--code-bg); border:1px solid var(--line-soft);
  padding:1px 5px; border-radius:4px;
}
pre{
  margin:14px 0; padding:14px 16px; overflow:auto;
  background:var(--code-bg); border:1px solid var(--line-soft); border-radius:8px;
}
pre code{ background:none; border:0; padding:0; color:#c9d6f5; font-size:13px; line-height:1.7; }
table{ width:100%; border-collapse:collapse; margin:14px 0; font-size:14px; }
th,td{ border:1px solid var(--line); padding:8px 12px; text-align:left; vertical-align:top; }
th{ background:var(--panel); color:#fff; font-weight:600; }
tr:nth-child(even) td{ background:rgba(15,52,96,.28); }
hr{ border:0; border-top:1px solid var(--line); margin:24px 0; }

/* ---------- 浮层 ---------- */
#backdrop{
  position:fixed; inset:0; z-index:55; background:rgba(0,0,0,.55);
  opacity:0; visibility:hidden; pointer-events:none;
  transition:opacity .25s ease,visibility 0s linear .25s;
}
#backdrop.open{
  opacity:1; visibility:visible; pointer-events:auto;
  transition:opacity .25s ease,visibility 0s linear 0s;
}
#lightbox{
  position:fixed; inset:0; z-index:200; padding:24px; display:none;
  align-items:center; justify-content:center; cursor:zoom-out;
  background:rgba(6,6,14,.93);
}
#lightbox.open{ display:flex; }
#lightbox img{
  max-width:100%; max-height:100%; border-radius:6px;
  box-shadow:0 12px 60px rgba(0,0,0,.8);
}
#toTop{
  position:fixed; z-index:80; width:38px; height:38px;
  right:calc(18px + env(safe-area-inset-right));
  bottom:calc(18px + env(safe-area-inset-bottom));
  background:var(--panel); box-shadow:0 6px 20px rgba(0,0,0,.45);
  opacity:0; visibility:hidden; transform:translateY(8px);
  transition:opacity .2s ease,transform .2s ease,visibility 0s linear .2s;
}
#toTop.show{
  opacity:1; visibility:visible; transform:none;
  transition:opacity .2s ease,transform .2s ease,visibility 0s linear 0s;
}

/* ---------- 窄屏 ---------- */
@media (min-width:1024px){ #backdrop{ display:none !important; } }
@media (max-width:1023px){
  #sidebar{
    position:fixed; top:0; left:0; bottom:0; z-index:60;
    width:min(312px,86vw); flex:none;
    padding-left:env(safe-area-inset-left);
    transform:translateX(-100%); visibility:hidden; pointer-events:none;
    box-shadow:2px 0 14px rgba(0,0,0,.5);
    transition:transform .25s ease,visibility 0s linear .25s;
  }
  #sidebar.open{
    transform:none; visibility:visible; pointer-events:auto;
    transition:transform .25s ease,visibility 0s linear 0s;
  }
  #sidebar.collapsed{ display:flex; }
  #sbHeader{ display:flex; }
  #doc{ padding:20px 16px 84px; font-size:15px; }
  .doc-h.lvl1{ font-size:1.4rem; }
  .doc-h.lvl2{ font-size:1.16rem; }
  .doc-label{ max-width:44vw; font-size:14px; }
}
@media (max-width:480px){
  #topbar{ padding:0 10px; gap:8px; }
  #doc{ padding:16px 13px 72px; }
  .doc-h.lvl3{ font-size:1.04rem; }
  .nav-link{ padding:7px 4px 7px 8px; }
}
@media (min-width:1024px) and (max-width:1199px){
  :root{ --sbw:266px; }
}

/* ---------- 打印 ---------- */
@media print{
  body{ display:block; height:auto; overflow:visible; background:#fff; color:#111; }
  #topbar,#sidebar,#backdrop,#toTop,#lightbox,#progress{ display:none !important; }
  #layout{ display:block; }
  #content{ overflow:visible; height:auto; }
  #doc{ max-width:none; padding:0; color:#111; font-size:12pt; line-height:1.7; }
  .sec.lvl1{ border-top-color:#ccc; }
  .doc-h.lvl1,.doc-h.lvl2,.doc-h.lvl3,.doc-h.lvl4{ color:#111; border-color:#ccc; }
  .hnum{ color:#6b21a8; }
  .ln{ color:#111; }
  #doc a{ color:#5b21b6; }
  .doc-img{ border-color:#ccc; box-shadow:none; cursor:default; }
  .sec,.doc-h{ scroll-margin-top:0; }
}
"""

JS = r"""
(function () {
  var sidebar   = document.getElementById('sidebar'),
      backdrop  = document.getElementById('backdrop'),
      content   = document.getElementById('content'),
      navScroll = document.getElementById('navScroll'),
      navBtn    = document.getElementById('navBtn'),
      navClose  = document.getElementById('sbClose'),
      progress  = document.getElementById('progress'),
      toTop     = document.getElementById('toTop'),
      lightbox  = document.getElementById('lightbox'),
      lightImg  = lightbox ? lightbox.querySelector('img') : null;

  var mq = window.matchMedia('(min-width:1024px)');
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
  var secs  = Array.prototype.slice.call(document.querySelectorAll('.sec'));

  /* 章节 id -> 导航链接 */
  var linkById = {};
  links.forEach(function (a) {
    var id = (a.getAttribute('href') || '').slice(1);
    if (id) { linkById[id] = a; }
  });
  /* 文档中出现的全部章节（用于滚动高亮，按出现顺序） */
  var secIds = secs.map(function (s) { return s.id; });

  function isDesktop() { return mq.matches; }
  function openDrawer() {
    sidebar.classList.add('open');
    backdrop.classList.add('open');
    navBtn.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    sidebar.classList.remove('open');
    backdrop.classList.remove('open');
    navBtn.setAttribute('aria-expanded', 'false');
  }

  /* ---------- 目录显示 / 隐藏 ---------- */
  navBtn.addEventListener('click', function () {
    if (isDesktop()) {
      var hidden = sidebar.classList.toggle('collapsed');
      navBtn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      navBtn.setAttribute('aria-label', hidden ? '显示目录' : '隐藏目录');
    } else if (sidebar.classList.contains('open')) {
      closeDrawer();
    } else {
      openDrawer();
    }
  });
  if (navClose) { navClose.addEventListener('click', closeDrawer); }
  backdrop.addEventListener('click', closeDrawer);

  /* ---------- 展开 / 折叠 ---------- */
  Array.prototype.slice.call(document.querySelectorAll('.nav-caret')).forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var li = btn.closest('.nav-item');
      if (!li) { return; }
      var open = li.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  /* ---------- 点击导航跳转 ---------- */
  function scrollToSection(el) {
    if (!el) { return; }
    var top = el.getBoundingClientRect().top - content.getBoundingClientRect().top
              + content.scrollTop - 18;
    content.scrollTo({ top: top < 0 ? 0 : top, behavior: 'smooth' });
  }
  links.forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = (a.getAttribute('href') || '').slice(1);
      var target = id ? document.getElementById(id) : null;
      e.preventDefault();
      closeDrawer();
      if (target) {
        scrollToSection(target);
        setActive(id, true);
        if (window.history && history.replaceState) {
          history.replaceState(null, '', '#' + id);
        }
      }
    });
  });
  /* 顶栏标题 -> 回到顶部 */
  Array.prototype.slice.call(document.querySelectorAll('.doc-label')).forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      content.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  toTop.addEventListener('click', function () {
    content.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ---------- 高亮当前章节 ---------- */
  var activeId = null;
  function setActive(id, force) {
    if (!id || (id === activeId && !force)) { return; }
    activeId = id;
    links.forEach(function (a) {
      a.classList.toggle('active', (a.getAttribute('href') || '').slice(1) === id);
    });
    var link = linkById[id];
    if (!link) { return; }
    /* 自动展开所有祖先节点 */
    var li = link.closest('.nav-item');
    var p = li && li.parentElement ? li.parentElement.closest('.nav-item') : null;
    while (p) {
      p.classList.add('open');
      var c = p.querySelector('.nav-caret');
      if (c) { c.setAttribute('aria-expanded', 'true'); }
      p = p.parentElement ? p.parentElement.closest('.nav-item') : null;
    }
    /* 保证高亮项在目录可视范围内（只滚动目录，不动正文） */
    var lr = link.getBoundingClientRect();
    var nr = navScroll.getBoundingClientRect();
    if (lr.top < nr.top) {
      navScroll.scrollTop -= (nr.top - lr.top) + 10;
    } else if (lr.bottom > nr.bottom) {
      navScroll.scrollTop += (lr.bottom - nr.bottom) + 10;
    }
  }

  /* ---------- 滚动：进度条 + 高亮 + 回到顶部 ---------- */
  var ticking = false;
  function update() {
    ticking = false;
    var paneTop = content.getBoundingClientRect().top;
    var offset = Math.max(56, Math.min(140, content.clientHeight * 0.22));
    var current = null;
    for (var i = 0; i < secs.length; i++) {
      if (!linkById[secs[i].id]) { continue; }
      if (secs[i].getBoundingClientRect().top - paneTop <= offset) { current = secs[i]; }
      else { break; }
    }
    var max = content.scrollHeight - content.clientHeight;
    if (max > 0 && max - content.scrollTop < 4) {
      for (var j = secs.length - 1; j >= 0; j--) {
        if (linkById[secs[j].id]) { current = secs[j]; break; }
      }
    }
    if (current) { setActive(current.id); }
    progress.style.width = (max > 0 ? (content.scrollTop / max) * 100 : 0) + '%';
    toTop.classList.toggle('show', content.scrollTop > 420);
  }
  function onScroll() {
    if (ticking) { return; }
    ticking = true;
    var done = false;
    var fire = function () { if (done) { return; } done = true; update(); };
    window.requestAnimationFrame(fire);
    /* 兜底：标签页切到后台时 rAF 会被浏览器暂停，这里保证高亮/进度条仍能更新 */
    window.setTimeout(fire, 60);
  }
  content.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  /* ---------- 图片放大查看 ---------- */
  if (lightbox && lightImg) {
    Array.prototype.slice.call(document.querySelectorAll('.doc-img')).forEach(function (img) {
      img.addEventListener('click', function () {
        lightImg.src = img.getAttribute('src');
        lightImg.alt = img.getAttribute('alt') || '';
        lightbox.classList.add('open');
      });
    });
    lightbox.addEventListener('click', function () {
      lightbox.classList.remove('open');
      lightImg.removeAttribute('src');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        lightbox.classList.remove('open');
        lightImg.removeAttribute('src');
        closeDrawer();
      }
    });
  }

  /* ---------- 断点切换 ---------- */
  function onMq() {
    if (mq.matches) { closeDrawer(); }
    else { sidebar.classList.remove('collapsed'); navBtn.setAttribute('aria-expanded', 'true'); }
    update();
  }
  if (mq.addEventListener) { mq.addEventListener('change', onMq); }
  else if (mq.addListener) { mq.addListener(onMq); }

  /* ---------- 初始定位 ---------- */
  if (window.location.hash.length > 1) {
    var t = document.getElementById(window.location.hash.slice(1));
    if (t) {
      window.setTimeout(function () {
        content.scrollTop = t.getBoundingClientRect().top
          - content.getBoundingClientRect().top + content.scrollTop - 14;
      }, 60);
    }
  }
  update();
})();
"""

TPL = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="description" content="fakeUFO 教程">
<title>{{TITLE}}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23533483'/%3E%3Cpath d='M16 6c-3.3 0-6 2.7-6 6v6c0 3.3 2.7 6 6 6s6-2.7 6-6v-6c0-3.3-2.7-6-6-6zm0 3.2A2.8 2.8 0 0 1 18.8 12v6A2.8 2.8 0 0 1 16 20.8 2.8 2.8 0 0 1 13.2 18v-6A2.8 2.8 0 0 1 16 9.2z' fill='%23e9d5ff'/%3E%3C/svg%3E">
<style>
/*{{CSS}}*/
</style>
</head>
<body>

<header id="topbar">
  <button id="navBtn" class="icon-btn" type="button" aria-expanded="true" aria-label="显示或隐藏目录">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
  </button>
  <a class="doc-label" href="#top" title="{{TITLE}}">{{LABEL}}</a>
  <span class="spacer"></span>
  <a class="icon-btn" href="https://github.com/Mistpeach/Web-UFO-Player" target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库" title="GitHub">
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
  </a>
  <div id="progress"></div>
</header>

<div id="layout">
  <aside id="sidebar">
    <div id="sbHeader">
      <a class="doc-label" href="#top">{{LABEL}}</a>
      <span class="spacer"></span>
      <button id="sbClose" class="icon-btn" type="button" aria-label="关闭目录">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div id="navScroll">
      <ul id="nav">{{NAV}}</ul>
    </div>
  </aside>

  <div id="backdrop"></div>

  <main id="content">
    <article id="doc">{{CONTENT}}</article>
  </main>
</div>

<div id="lightbox"><img alt=""></div>

<button id="toTop" class="icon-btn" type="button" aria-label="回到顶部">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
</button>

<script>
/*{{JS}}*/
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------
# 6. main
# --------------------------------------------------------------------------

def main():
    with open(SRC, "r", encoding="utf-8-sig", newline="") as f:
        raw = f.read()

    items = split_blocks(raw)
    heads = [d for k, d in items if k == "h"]
    roots = build_tree(heads)

    nav = []
    for node in roots:
        render_nav(node, nav)
    nav_html = "".join(nav)

    content_html = render_body(items)

    label = heads[0][0] + heads[0][1] + heads[0][2] if heads else ""
    out = (TPL
           .replace("{{TITLE}}", esc_attr(label))
           .replace("{{LABEL}}", esc_text(label))
           .replace("{{NAV}}", nav_html)
           .replace("{{CONTENT}}", content_html)
           .replace("/*{{CSS}}*/", CSS)
           .replace("/*{{JS}}*/", JS))

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)

    # ---- 报告 ----
    n_p = sum(1 for k, _ in items if k == "p")
    n_fig = sum(1 for k, _ in items if k == "fig")
    n_img = sum(len(d) for k, d in items if k == "fig")
    print("源文件      : %s" % SRC)
    print("输出        : %s  (%d 字节)" % (OUT, len(out.encode("utf-8"))))
    print("正文段落组  : %d" % n_p)
    print("纯图片行    : %d（共 %d 张图）" % (n_fig, n_img))
    print("编号标题    : %d" % len(heads))
    print("--- 标题层级 ---")
    for num, sep, rest in heads:
        print("  L%d  %s" % (num_level(num), num + sep + rest))
    if MISSING:
        print("!! 缺失图片: %s" % ", ".join(MISSING))
    else:
        print("图片检查    : 全部存在")

    # ---- 文字零改动校验：逐行、逐标题比对 ----
    strip_tags = lambda s: re.sub(r"<[^>]+>", "", s)

    exp_lines = [ln for k, d in items if k == "p" for ln in d]
    got_lines = [html.unescape(strip_tags(x)) for x in
                 re.findall(r'<p class="ln[^"]*">(.*?)</p>', content_html, re.S)]

    exp_heads = [n + s + r for n, s, r in heads]
    got_heads = [html.unescape(a) + html.unescape(b) for a, b in
                 re.findall(r'<h[1-6] class="doc-h lvl\d"><span class="hnum[^"]*">'
                            r'(.*?)</span>(.*?)</h[1-6]>', content_html, re.S)]

    ok = True
    if exp_lines != got_lines:
        ok = False
        print("!! 正文行不一致：期望 %d 行 / 实际 %d 行"
              % (len(exp_lines), len(got_lines)))
        for i, (a, b) in enumerate(zip(exp_lines, got_lines)):
            if a != b:
                print("   第 %d 行:\n     原文 %r\n     输出 %r" % (i + 1, a, b))
                break
    if exp_heads != got_heads:
        ok = False
        print("!! 标题不一致：%r" % [x for x in zip(exp_heads, got_heads) if x[0] != x[1]][:3])

    src_text = re.sub(r"\s+", "", IMG_RE.sub("", raw))
    body_text = html.unescape(strip_tags(content_html))
    body_text = re.sub(r"\s+", "", body_text)
    if src_text != body_text:
        ok = False
        print("!! 全文字符不一致：原文 %d / 输出 %d" % (len(src_text), len(body_text)))
        for i in range(min(len(src_text), len(body_text))):
            if src_text[i] != body_text[i]:
                print("   首个差异 @%d: %r vs %r"
                      % (i, src_text[i - 40:i + 40], body_text[i - 40:i + 40]))
                break

    print("文字校验    : %s（%d 正文行 / %d 标题 / %d 字符）"
          % ("逐字一致" if ok else "有差异", len(exp_lines), len(exp_heads), len(src_text)))
    return 0 if ok and not MISSING else 1


if __name__ == "__main__":
    sys.exit(main())
