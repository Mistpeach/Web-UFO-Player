// ============================================================
// ctrlproto.js - AI 控制块的定位 / 剥离 / 解析 / 校验
//
// 协议（v1，与 L1 契约逐字对应）：
//   AI 回复的**第一个** ```ufo 围栏块内是一个单行 JSON：
//   {"v":1,
//    "ctrl":{"on":true,"wave":"心跳（双跳）","intensity":45,"ch":"AB"},
//    "hint":"试探着开始",
//    "branches":["再快一点","轻一些","先停一下"]}
//
// 三条硬规则：
//   ① 围栏块**永远不上屏**（哪怕内容是垃圾）—— 剥离与解析是否成功无关；
//   ② ctrl 内任一字段不合法 → **整个 ctrl 丢弃**（原子，不做"部分生效"、
//      不做"钳制后执行"）。hint / branches 各自独立，互不牵连；
//   ③ 本模块是纯函数：不碰 DOM、不碰引擎、不认识 localStorage。
//      波形是否存在由调用方通过 opts.resolveWave(key) 注入。
// ============================================================
(function () {
  'use strict';
  var AI = window.AI = window.AI || {};

  var VERSION = 1;
  var MAX_HINT = 40;          // hint 超长就截断（风格问题，不是安全问题）
  var MAX_BRANCH = 40;        // 单条分支超长截断
  var MAX_BRANCHES = 4;       // 最多保留几条分支
  var BARE_JSON_TRIES = 20;   // 裸 JSON 兜底最多尝试几个候选对象

  // 认作"控制块"的围栏标签
  var CTRL_TAGS = { ufo: 1, 'ufo-control': 1, ufo_ctrl: 1, ufoctrl: 1 };
  // 允许"降级接受"的围栏标签（内容里必须真的有 ctrl 键，否则当普通代码块）
  var LOOSE_TAGS = { '': 1, json: 1, jsonc: 1, json5: 1 };

  // ---------- 基础判定 ----------
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string'; }
  function isBool(v) { return typeof v === 'boolean'; }
  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // 名称规范化：全角 → 半角、去掉所有空白、ASCII 折大小写。
  //   用于比对「AI 输出的波形名称」和「真实波形名称」：模型经常会自己加空格、
  //   把括号打成全角（心跳（双跳） vs 心跳(双跳)）、或者大小写不一致。
  //   只做规范化后的**精确**匹配，不做模糊/前缀匹配 —— 宁可拒绝，不可猜错。
  function normKey(s) {
    s = String(s === null || s === undefined ? '' : s);
    s = s.replace(/[\uFF01-\uFF5E]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/[\s\u3000\u00A0]+/g, '');
    return s.toLowerCase();
  }

  // ---------- 围栏块定位 ----------
  // 返回 [{ tag, body, start, end }]，按出现顺序。
  // 兼容三种写法：```ufo\n{...}\n``` / ```ufo{...}``` / ```json\n{...}\n```
  function findFences(text) {
    var out = [], re = /```([^\n`]*)\r?\n?([\s\S]*?)```/g, m;
    while ((m = re.exec(text)) !== null) {
      var info = trim(m[1]), body = m[2];
      // ```ufo{...}``` 这种把内容写在 info 行里的写法：把 info 拆成「标签 + 剩余内容」
      var im = /^([A-Za-z0-9_-]*)([\s\S]*)$/.exec(info);
      var tag = (im ? im[1] : '').toLowerCase();
      var rest = im ? im[2] : '';
      if (rest) body = rest + '\n' + body;
      out.push({ tag: tag, body: body, start: m.index, end: re.lastIndex });
    }
    return out;
  }

  // 未闭合的围栏（流式被截断时很常见）：返回起始下标，找不到返回 -1。
  //   ⚠ 必须按"配对计数"判断，不能用"最后一个 ``` 之后没有 ``` 了"来判断 ——
  //   后者会把一个**正常的闭合围栏**（如 ```js 代码块 的结尾）误判成未闭合的开头，
  //   于是把它后面的正文整段吃掉。
  function findOpenFence(text) {
    var re = /```/g, m, open = -1, inside = false;
    while ((m = re.exec(text)) !== null) {
      if (!inside) { inside = true; open = m.index; }
      else { inside = false; open = -1; }
    }
    return open;
  }

  // ---------- JSON 解析（允许一次温和修复） ----------
  function parseJsonLoose(body) {
    var s = trim(body);
    if (!s) return { err: 'empty' };
    try { return { value: JSON.parse(s), repaired: '' }; } catch (e) { }
    // 温和修复：去掉对象/数组结尾多余的逗号（模型最常见的格式失误）
    var fixed = s.replace(/,(\s*[}\]])/g, '$1');
    if (fixed !== s) {
      try { return { value: JSON.parse(fixed), repaired: 'trailing-comma' }; } catch (e2) { }
    }
    return { err: 'bad-json' };
  }

  // ---------- 裸 JSON 兜底 ----------
  // 在全文里找第一个「能解析成对象且带 ctrl 键」的配对花括号块。
  // 只在完全没有 ufo 围栏时才启用，避免把正文里正常的 {} 误当控制块。
  function findBareCtrl(text) {
    var i = 0, tries = 0;
    while (tries < BARE_JSON_TRIES) {
      var s = text.indexOf('{', i);
      if (s < 0) return null;
      var depth = 0, inStr = false, esc = false, end = -1, j;
      for (j = s; j < text.length; j++) {
        var c = text.charAt(j);
        if (inStr) {
          if (esc) { esc = false; }
          else if (c === '\\') { esc = true; }
          else if (c === '"') { inStr = false; }
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
      }
      if (end < 0) return null;                 // 花括号没配平 → 不再往后猜
      tries++;
      var chunk = text.slice(s, end);
      var r = parseJsonLoose(chunk);
      if (r.value && isObj(r.value) && hasOwn(r.value, 'ctrl')) {
        return { start: s, end: end, value: r.value, repaired: r.repaired || '' };
      }
      i = end;
    }
    return null;
  }

  // ---------- 字段规整 ----------
  function normHint(raw, errors) {
    if (raw === undefined || raw === null) return '';
    if (!isStr(raw)) { errors.push({ field: 'hint', code: 'bad-hint' }); return ''; }
    var s = trim(raw);
    if (!s) return '';
    if (s.length > MAX_HINT) s = s.slice(0, MAX_HINT);
    return s;
  }

  function normBranches(raw, errors) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) { errors.push({ field: 'branches', code: 'bad-branches' }); return []; }
    var out = [], i, s;
    for (i = 0; i < raw.length && out.length < MAX_BRANCHES; i++) {
      if (!isStr(raw[i])) continue;             // 非字符串项直接跳过，不算错
      s = trim(raw[i]);
      if (!s) continue;
      if (s.length > MAX_BRANCH) s = s.slice(0, MAX_BRANCH);
      out.push(s);
    }
    if (!out.length && raw.length) errors.push({ field: 'branches', code: 'empty-branches' });
    return out;
  }

  // 通道：只接受 A / B / AB（大小写与空白无所谓）
  function normChannel(raw, errors) {
    if (raw === undefined || raw === null) return 'AB';
    var s = String(raw).toUpperCase().replace(/[\s,+/]/g, '');
    if (s === 'BA') s = 'AB';
    if (s === 'AA') s = 'A';
    if (s === 'BB') s = 'B';
    if (s === 'A' || s === 'B' || s === 'AB') return s;
    errors.push({ field: 'ctrl.ch', code: 'bad-ch', got: raw });
    return null;
  }

  // ---------- ctrl 校验 ----------
  // 返回 { ctrl, dropped }；dropped 里是导致整体丢弃的原因。
  function validateCtrl(raw, opts) {
    var e = [], c, on, wave = null, waveKey = '', intensity = null, chan;

    if (!isObj(raw)) return { ctrl: null, errors: [{ field: 'ctrl', code: 'bad-ctrl' }] };
    c = raw;

    if (!hasOwn(c, 'on') || !isBool(c.on)) e.push({ field: 'ctrl.on', code: 'bad-on', got: c.on });
    on = (c.on === true);

    chan = normChannel(c.ch, e);

    // 波形：填了就必须能解析出来（无论 on 真假 —— 出现垃圾值说明模型糊涂了）
    if (hasOwn(c, 'wave') && c.wave !== null && c.wave !== '') {
      if (!isStr(c.wave)) {
        e.push({ field: 'ctrl.wave', code: 'bad-wave', got: c.wave });
      } else {
        waveKey = trim(c.wave);
        try { wave = opts.resolveWave ? opts.resolveWave(waveKey) : null; } catch (err) { wave = null; }
        if (!wave) e.push({ field: 'ctrl.wave', code: 'unknown-wave', got: waveKey });
      }
    } else if (on) {
      e.push({ field: 'ctrl.wave', code: 'missing-wave' });
    }

    // 强度：必须是 0-100 的整数。越界一律拒绝（不做钳制后执行）
    if (hasOwn(c, 'intensity') && c.intensity !== null) {
      if (!isInt(c.intensity)) e.push({ field: 'ctrl.intensity', code: 'bad-intensity', got: c.intensity });
      else if (c.intensity < 0 || c.intensity > 100) {
        e.push({ field: 'ctrl.intensity', code: 'intensity-out-of-range', got: c.intensity });
      } else intensity = c.intensity;
    } else if (on) {
      e.push({ field: 'ctrl.intensity', code: 'missing-intensity' });
    }

    if (e.length) return { ctrl: null, errors: e };

    var ratio = (intensity === null ? 0 : intensity) / 100;
    return {
      ctrl: {
        on: on,
        wave: wave,                  // 波形对象（由 resolveWave 给出）
        waveKey: waveKey,            // AI 原话里的名称（用于界面显示与调试）
        intensity: (intensity === null ? 0 : intensity),
        aiRatio: ratio,              // 0..1，AI 的意向比率
        ch: chan,
        chans: (chan === 'AB' ? ['A', 'B'] : [chan])
      },
      errors: []
    };
  }

  // 顶层块校验
  function validateBlock(obj, opts) {
    var errors = [], ctrl = null, hint = '', branches = [];
    if (!isObj(obj)) return { ctrl: null, hint: '', branches: [], errors: [{ field: '', code: 'not-object' }] };

    // 协议版本不认识 → 整块作废：连 hint / branches 一起丢。
    //   v 变了意味着字段语义可能已经变了，这时候"只信一半"比"全不信"更危险 ——
    //   fail-closed 是这里唯一说得通的选择。
    var versionBad = false;
    if (hasOwn(obj, 'v') && obj.v !== null && obj.v !== undefined) {
      if (!isInt(obj.v)) { errors.push({ field: 'v', code: 'bad-version', got: obj.v }); versionBad = true; }
      else if (obj.v !== VERSION) { errors.push({ field: 'v', code: 'unknown-version', got: obj.v }); versionBad = true; }
    }
    if (versionBad) return { ctrl: null, hint: '', branches: [], errors: errors };

    hint = normHint(obj.hint, errors);
    branches = normBranches(obj.branches, errors);

    if (!hasOwn(obj, 'ctrl')) {
      errors.push({ field: 'ctrl', code: 'missing-ctrl' });
    } else {
      var r = validateCtrl(obj.ctrl, opts || {});
      ctrl = r.ctrl;
      errors = errors.concat(r.errors);
    }
    return { ctrl: ctrl, hint: hint, branches: branches, errors: errors };
  }

  // ---------- 剥离 ----------
  function cutRanges(text, ranges) {
    if (!ranges.length) return text;
    ranges = ranges.slice().sort(function (a, b) { return a.start - b.start; });
    var merged = [], i, last;
    for (i = 0; i < ranges.length; i++) {
      last = merged[merged.length - 1];
      if (last && ranges[i].start <= last.end) { if (ranges[i].end > last.end) last.end = ranges[i].end; }
      else merged.push({ start: ranges[i].start, end: ranges[i].end });
    }
    var out = '', pos = 0;
    for (i = 0; i < merged.length; i++) {
      out += text.slice(pos, merged[i].start);
      pos = merged[i].end;
    }
    out += text.slice(pos);
    return out;
  }

  // ============================================================
  // 主入口
  //   parse(text, opts) -> record
  //   opts.resolveWave: function(name) -> 波形对象 | null
  // ============================================================
  function parse(text, opts) {
    opts = opts || {};
    var src = String(text === null || text === undefined ? '' : text);

    var fences = findFences(src);
    var strip = [], chosenTs = null, chosenBlock = null, flags = {
      fence: 'none', repaired: '', truncated: false, degraded: false
    };
    var i, f, r;

    // ① 第一个 ufo 围栏就是控制块（无论它是否合法）—— 权威且唯一
    for (i = 0; i < fences.length; i++) {
      f = fences[i];
      if (!CTRL_TAGS[f.tag]) continue;
      strip.push({ start: f.start, end: f.end });
      if (!chosenTs) {
        flags.fence = 'ufo';
        chosenTs = f;
      }
    }

    if (chosenTs) {
      r = parseJsonLoose(chosenTs.body);
      if (r.err) {
        chosenBlock = { parseError: r.err };
        flags.repaired = '';
      } else {
        chosenBlock = r.value;
        flags.repaired = r.repaired || '';
      }
    } else {
      // ② 没有 ufo 围栏：接受 ```json / 无标签 且**内容里真的有 ctrl 键**的块（降级）
      for (i = 0; i < fences.length; i++) {
        f = fences[i];
        if (!LOOSE_TAGS[f.tag]) continue;
        r = parseJsonLoose(f.body);
        if (r.value && isObj(r.value) && hasOwn(r.value, 'ctrl')) {
          chosenBlock = r.value;
          flags.fence = f.tag ? 'loose' : 'plain';
          flags.degraded = true;
          flags.repaired = r.repaired || '';
          strip.push({ start: f.start, end: f.end });
          break;
        }
      }
      // ③ 仍然没有：全文里找第一个配平的、带 ctrl 键的裸 JSON
      if (!chosenBlock) {
        var bare = findBareCtrl(src);
        if (bare) {
          chosenBlock = bare.value;
          flags.fence = 'bare';
          flags.degraded = true;
          flags.repaired = bare.repaired || '';
          strip.push({ start: bare.start, end: bare.end });
        }
      }
    }

    // ④ 未闭合的围栏（流式截断）：从起点截掉，别把半截 JSON 显示出来
    if (!strip.length) {
      var open = findOpenFence(src);
      if (open >= 0) {
        var tailInfo = /^```([^\n`]*)/.exec(src.slice(open));
        var tailTag = tailInfo ? trim(tailInfo[1]).toLowerCase() : '';
        if (CTRL_TAGS[tailTag] || tailTag === '') {
          strip.push({ start: open, end: src.length });
          flags.truncated = true;
          if (!chosenBlock) { flags.fence = CTRL_TAGS[tailTag] ? 'ufo' : 'plain'; }
        }
      }
    }

    var shown = trim(cutRanges(src, strip));

    var out = {
      ok: false,
      hasBlock: !!chosenBlock && !chosenBlock.parseError,
      text: shown,
      raw: src,
      ctrl: null,
      hint: '',
      branches: [],
      errors: [],
      flags: flags
    };

    if (!chosenBlock) {
      if (flags.truncated) out.errors.push({ field: '', code: 'truncated-block' });
      else out.errors.push({ field: '', code: 'no-block' });
      return out;
    }
    if (chosenBlock.parseError) {
      out.errors.push({ field: '', code: chosenBlock.parseError });   // bad-json / empty
      return out;
    }

    var v = validateBlock(chosenBlock, opts);
    out.ctrl = v.ctrl;
    out.hint = v.hint;
    out.branches = v.branches;
    out.errors = v.errors;
    out.ok = !!v.ctrl;
    return out;
  }

  AI.ctrlproto = {
    VERSION: VERSION,
    MAX_HINT: MAX_HINT,
    MAX_BRANCH: MAX_BRANCH,
    MAX_BRANCHES: MAX_BRANCHES,
    parse: parse,
    // 拆开导出，方便用例直接打点
    normKey: normKey,
    findFences: findFences,
    findOpenFence: findOpenFence,
    findBareCtrl: findBareCtrl,
    parseJsonLoose: parseJsonLoose,
    validateBlock: validateBlock,
    validateCtrl: validateCtrl,
    cutRanges: cutRanges
  };
})();
