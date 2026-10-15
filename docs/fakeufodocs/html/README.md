# fakeUFO 教程 · 网页版

把 `../1.md` 渲染成带左侧可折叠目录的静态网页。**只做排版，不改动任何文字。**

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` | 最终页面（CSS/JS 全部内嵌，**零第三方依赖**，双击即可打开） |
| `build.py` | 生成器：解析 `../1.md` → 输出 `index.html` |
| `../1.md` | 唯一的内容来源（本目录不含正文副本） |
| `../*.png` | 文档引用的 32 张截图，仍在上一级目录，**未复制、未移动** |

## 打开方式

**不需要本地服务器。** 直接双击 `index.html`，或用浏览器打开：

```
file:///D:/乱七八糟/ufo伪装器/github/Web-UFO-Player/docs/fakeufodocs/html/index.html
```

之所以能脱离服务器，是因为页面在**构建时**就已经渲染成 HTML，运行时不 `fetch` 任何文件，
也不从 CDN 加载 marked.js / highlight.js 之类的库。

### 图片路径

`index.html` 在 `html/` 子目录里，而图片在它的上一级，所以生成时把
`image.png` 统一改写成了 `../image.png`：

```
docs/fakeufodocs/
├── 1.md                 源文档
├── image.png … image-31.png
├── 1783102920-…png
└── html/
    └── index.html       ← 用 ../ 引用上面的图片
```

因此**不要单独把 `index.html` 拷到别处**，否则图片会全部失效。
如果确实需要单文件分发，把 `../*.png` 一起复制到 `html/` 下，再把 `build.py` 里的
`resolve_src()` 改成返回 `src` 原值后重新生成即可。

## 重新生成

改完 `../1.md` 后重跑生成器：

```powershell
& "C:\Users\YumFish\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" build.py
```

或任意 Python 3.8+：

```bash
python build.py
```

退出码 `0` 表示成功。脚本每次都会做**文字零改动校验**：逐行比对 184 个正文行、
41 个标题以及全文 6872 个字符，任何一处不一致都会打印差异并以退出码 `1` 结束。

## 页面功能

- **左侧导航**：自动从编号标题（`0.` `1.1` `2.4.1.1` …）生成，按层级嵌套（一级→四级）
- **折叠**：带 `▾` 的父节点可展开/收起；点击标题跳转，滚动时自动高亮当前章节并展开其祖先
- **窄屏**：≤1023px 时目录收为抽屉，点左上角 `☰` 滑出，点遮罩或 `✕` 关闭
- **图片**：点击任意截图可全屏放大，`Esc` 关闭
- **其它**：顶部阅读进度条、右下角回到顶部、`@media print` 打印样式

## 可选：给未来的代码块加高亮

本文档目前没有代码块（已确认 `1.md` 中不含反引号），`pre`/`code` 的样式已备好。
若以后加了代码，在 `</head>` 前补上：

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/atom-one-dark.min.css">
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/common.min.js"></script>
<script>hljs.highlightAll();</script>
```

注意这会引入 CDN 依赖，`file://` 下无网络时高亮失效但不影响正文显示。

## 设计语言

配色/字体/控件风格取自项目根目录的 `style.css`：

| 用途 | 取值 |
|---|---|
| 页面底色 | `#1a1a2e` |
| 面板/侧栏 | `#16213e` |
| 描边 | `#0f3460` |
| 强调色 | `#a78bfa` / 渐变 `linear-gradient(135deg,#533483,#a855f7)` |
| 正文 | `#e0e0e0` / 次要 `#a8a8bd` |
| 字体 | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif` |
