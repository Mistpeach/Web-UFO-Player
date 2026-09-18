// ============================================================
// format.js - 波形数据模型 / 采样 / CSV·JSON 编解码
// 内部模型(ufo-wave/1)：
//   { id, format, name, loop, duration(秒), mode:'hold'|'linear', base,
//     channels:{ A:[[t,v],...], B:[[t,v],...] }, notes, builtin }
//   v: -127..127 带符号（负 = 反转）; t: 秒、升序
//   循环语义：从最后一个断点保持到 duration，然后回绕到第一个断点
// ============================================================
(function () {
  'use strict';
  var WC = window.WC = window.WC || {};

  var FORMAT_ID = 'ufo-wave/1';
  var LIMIT = 127;          // BLE 指令值域绝对值上限（与 app.js 的 enc() 一致）
  var DEFAULT_DUR = 0.5;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function r3(t) { return Math.round(t * 1000) / 1000; }
  function newId() { return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }

  // ---------- 规整数据 → 合法波形对象（不改入参） ----------
  function normalize(raw, opts) {
    opts = opts || {};
    if (!raw || typeof raw !== 'object') throw new Error('波形数据不是对象');

    var names = ['A', 'B'], src = raw.channels || {}, chs = { A: [], B: [] }, i, j, ch, pts, p, t, v;

    for (i = 0; i < 2; i++) {
      ch = names[i];
      pts = src[ch] || src[ch.toLowerCase()] || [];
      if (!Array.isArray(pts)) pts = [];
      for (j = 0; j < pts.length; j++) {
        p = pts[j];
        if (Array.isArray(p)) { t = num(p[0]); v = num(p[1]); }
        else if (p && typeof p === 'object') { t = num(p.t); v = num(p.v); }
        else continue;
        if (t === null || v === null || t < 0) continue;
        chs[ch].push([r3(t), Math.round(clamp(v, -LIMIT, LIMIT))]);
      }
      chs[ch].sort(function (a, b) { return a[0] - b[0]; });
      var ded = [];
      for (j = 0; j < chs[ch].length; j++) {
        if (ded.length && ded[ded.length - 1][0] === chs[ch][j][0]) ded[ded.length - 1] = chs[ch][j];
        else ded.push(chs[ch][j]);
      }
      chs[ch] = ded;
    }

    var maxT = 0;
    for (i = 0; i < 2; i++) {
      if (chs[names[i]].length) maxT = Math.max(maxT, chs[names[i]][chs[names[i]].length - 1][0]);
    }
    var dur = num(raw.duration);
    if (!dur || dur <= 0) dur = maxT || DEFAULT_DUR;
    if (dur < maxT) dur = maxT;

    return {
      id: raw.id || opts.id || newId(),
      format: FORMAT_ID,
      name: String(raw.name || opts.name || '未命名波形').slice(0, 40),
      loop: raw.loop === false ? false : true,
      duration: r3(dur),
      mode: (raw.mode === 'linear' ? 'linear' : 'hold'),
      base: Math.round(clamp(num(raw.base) || LIMIT, 1, LIMIT)),
      channels: chs,
      notes: String(raw.notes || ''),
      builtin: !!raw.builtin,
      createdAt: raw.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }

  function durationOf(w) { return w && w.duration > 0 ? w.duration : DEFAULT_DUR; }

  // ---------- 采样（引擎与示波器共用同一个函数，保证"所见即所发"） ----------
  function sampleWave(wave, ch, t) {
    if (!wave) return 0;
    var pts = (wave.channels && wave.channels[ch]) || [];
    if (!pts.length) return 0;
    var dur = durationOf(wave);
    if (t < 0) t = 0;
    if (wave.loop !== false) { t = t % dur; if (t < 0) t += dur; }
    else if (t >= dur) return 0;

    if (wave.mode === 'linear' && pts.length > 1) {
      if (t <= pts[0][0]) return pts[0][1];
      for (var i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          var t0 = pts[i - 1][0], v0 = pts[i - 1][1], t1 = pts[i][0], v1 = pts[i][1];
          var span = t1 - t0;
          if (span <= 0) return v1;
          return v0 + (v1 - v0) * ((t - t0) / span);
        }
      }
      return pts[pts.length - 1][1];
    }

    // hold：阶梯保持
    if (t < pts[0][0]) return 0;
    var lo = 0, hi = pts.length - 1, idx = 0;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (t >= pts[m][0]) { idx = m; lo = m + 1; } else { hi = m - 1; }
    }
    return pts[idx][1];
  }

  // 原始速度 × 强度 → 实际发送的整数指令（带夹取），全应用只用这一个出口
  function sampleScaled(wave, ch, t, intensity) {
    var k = (intensity === undefined || intensity === null) ? 1 : intensity;
    return Math.round(clamp(sampleWave(wave, ch, t) * k, -LIMIT, LIMIT));
  }

  // 相位：以 performance.now() 为时钟（抗抖动/抗节流漂移）
  function phaseAt(startAtMs, nowMs, duration, phaseRatio) {
    var d = duration > 0 ? duration : DEFAULT_DUR;
    var t = ((nowMs - startAtMs) / 1000) + (phaseRatio || 0) * d;
    t = t % d;
    if (t < 0) t += d;
    return t;
  }

  // 峰值 |v|（用于界面显示"原始速度"）
  function peakOf(wave, ch) {
    var pts = (wave && wave.channels && wave.channels[ch]) || [], m = 0;
    for (var i = 0; i < pts.length; i++) m = Math.max(m, Math.abs(pts[i][1]));
    return m;
  }

  function describe(wave) {
    if (!wave) return '未选择波形';
    var pa = peakOf(wave, 'A'), pb = peakOf(wave, 'B');
    var onlyOne = (wave.channels.A.length === 0 || wave.channels.B.length === 0);
    return wave.duration.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + 's · ' +
      (onlyOne ? '单通道' : '双通道') + ' · 原始峰值 ' + pa + (pb !== pa ? ' / ' + pb : '') +
      ' · ' + (wave.mode === 'linear' ? '线性' : '阶梯');
  }

  // ============================ CSV 编解码 ============================
  // 兼容 app.js 的脚本 CSV：ts(0.1s) | 方向(0正/1反) | 速度 | [方向 | 速度]
  function splitLine(line) {
    if (line.indexOf(',') >= 0) return line.split(',');
    if (line.indexOf('\t') >= 0) return line.split('\t');
    if (line.indexOf(';') >= 0) return line.split(';');
    return [line];
  }

  function dirSpeed(dirCell, spdCell) {
    var spd = num(spdCell);
    if (spd === null) return { v: 0, neg: false, bad: true };
    var d = String(dirCell).trim();
    var neg = (d === '1' || d === '-1' || d === '反' || d === 'reverse' || d === '-');
    return { v: neg ? -Math.abs(Math.round(spd)) : Math.abs(Math.round(spd)), neg: neg, bad: false };
  }

  function fromCSV(text, opts) {
    opts = opts || {};
    var warnings = [];
    var lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    var meta = { unit: 0.1, name: null, duration: null, mode: null, base: null };
    var rows = [], skipped = 0, clamped = 0, negCount = 0, cols = {}, i;

    for (i = 0; i < lines.length; i++) {
      var line = (lines[i] || '').trim();
      if (!line) continue;
      if (line.charAt(0) === '#') {
        var m = /^#\s*([A-Za-z_]+)\s*[=:]\s*(.+)$/.exec(line);
        if (m) {
          var k = m[1].toLowerCase(), v = m[2].trim();
          if (k === 'unit') {
            if (/^(s|sec|secs|second|seconds|秒)$/i.test(v)) meta.unit = 1;
            else { var u = parseFloat(v); if (isFinite(u) && u > 0) meta.unit = u; }
          } else if (k === 'name') meta.name = v;
          else if (k === 'duration' || k === 'length') meta.duration = parseFloat(v);
          else if (k === 'mode') meta.mode = (v === 'linear' ? 'linear' : 'hold');
          else if (k === 'base') meta.base = parseFloat(v);
        }
        continue;
      }
      var c = splitLine(line).map(function (s) { return s.trim(); });
      var ts = num(c[0]);
      if (ts === null || ts < 0 || !/^[0-9]/.test(c[0])) { skipped++; continue; }
      var t = ts * meta.unit, a, b, r;
      if (c.length >= 5) {
        r = dirSpeed(c[1], c[2]); if (r.bad) { skipped++; continue; }
        a = r.v; if (r.neg) negCount++;
        r = dirSpeed(c[3], c[4]); if (r.bad) { skipped++; continue; }
        b = r.v; if (r.neg) negCount++;
        cols['5'] = 1;
      } else if (c.length >= 3) {
        r = dirSpeed(c[1], c[2]); if (r.bad) { skipped++; continue; }
        a = b = r.v; if (r.neg) negCount++;
        cols['3'] = 1;
      } else if (c.length === 2) {
        a = b = Math.round(num(c[1]) || 0);
        cols['2'] = 1;
      } else { skipped++; continue; }
      if (Math.abs(a) > LIMIT) { a = clamp(a, -LIMIT, LIMIT); clamped++; }
      if (Math.abs(b) > LIMIT) { b = clamp(b, -LIMIT, LIMIT); clamped++; }
      rows.push([r3(t), a, b]);
    }

    if (!rows.length) throw new Error('CSV 里没有可解析的数据行（需要至少 3 列：时间戳 | 方向 | 速度）');
    rows.sort(function (x, y) { return x[0] - y[0]; });

    // 压缩成断点表：连续相同的值只留第一个（阶梯语义下无损，体积更小）
    var chA = [], chB = [], la = null, lb = null;
    for (i = 0; i < rows.length; i++) {
      if (chA.length === 0 || rows[i][1] !== la) { chA.push([rows[i][0], rows[i][1]]); la = rows[i][1]; }
      if (chB.length === 0 || rows[i][2] !== lb) { chB.push([rows[i][0], rows[i][2]]); lb = rows[i][2]; }
    }
    var maxT = Math.max(chA[chA.length - 1][0], chB[chB.length - 1][0]);
    var dur = (meta.duration && meta.duration > 0) ? meta.duration : maxT;
    if (dur < maxT) dur = maxT;
    var name = (opts.name || meta.name || (opts.filename || '').replace(/\.[^.]+$/, '') || 'CSV 波形').slice(0, 40);

    var wave = normalize({
      name: name, duration: dur, mode: meta.mode || 'hold', base: meta.base || LIMIT,
      channels: { A: chA, B: chB }, notes: '由 CSV 转换而来'
    }, { id: opts.id });

    warnings.push({ level: 'warn', text: '这是 CSV 波形文件：本程序底层统一使用 JSON（' + FORMAT_ID + '），已自动转换。CSV 只作为交换格式，转换结果请结合下面的提示与预览核对。' });
    warnings.push({ level: 'info', text: '时间单位按「1 单位 = ' + meta.unit + ' 秒」解析（原脚本约定：时间戳 6636 = 663.6 秒）。据此推导出循环时长 = ' + wave.duration + ' 秒；若这个时长明显不对，说明原文件用的不是 0.1 秒单位——可在文件头加一行 #unit=s 表示以秒为单位，再重新导入。' });
    if (cols['3']) warnings.push({ level: 'info', text: '检测到 3 列格式（时间戳 | 方向 | 速度）：A/B 两通道会使用完全相同的波形（对应原脚本「左右同步」的语义）；想要左右不同请用 5 列格式。' });
    if (cols['2']) warnings.push({ level: 'info', text: '检测到 2 列格式（时间戳 | 带符号速度）：需正负号已写对，A/B 使用同一波形。' });
    if (negCount) warnings.push({ level: 'info', text: '有 ' + negCount + ' 个「方向 = 1(反转)」的点已转换为负值（本程序 JSON 用正负号表达正转/反转，不再有方向列）。' });
    if (clamped) warnings.push({ level: 'warn', text: '有 ' + clamped + ' 个速度值超过 ±127（BLE 指令上限），已夹取到 ±127，实际会比原文件弱一点。' });
    if (skipped) warnings.push({ level: 'warn', text: '有 ' + skipped + ' 行无法解析（空行、缺列或非数字），已跳过。' });
    if (Math.abs(dur - maxT) < 0.001) warnings.push({ level: 'warn', text: '最后一个断点在 t=' + maxT + ' 秒，正好等于循环结束点：循环回绕时它不会被实际播放。若末尾需要一个停顿，请把时长改成 ' + r3(maxT * 2) + ' 秒，或在末尾再补一个断点。' });
    warnings.push({ level: 'info', text: 'CSV 无法表达的信息已用默认值补齐：名称取文件名、模式 = 阶梯保持(hold)、时长 = 最后一个时间戳。可在「管理」里改名称/时长，或导出成 JSON 后再编辑。' });
    return { waves: [wave], warnings: warnings, source: 'csv' };
  }

  // 导出取值：同一时刻优先用该通道自己的断点原值（CSV 往返无损），
  // 否则按采样规则取值；t 到达 duration 时不参与回绕
  function valueAt(wave, ch, t) {
    var pts = (wave.channels && wave.channels[ch]) || [], i;
    for (i = 0; i < pts.length; i++) if (Math.abs(pts[i][0] - t) < 1e-6) return pts[i][1];
    var dur = durationOf(wave);
    return sampleWave(wave, ch, (t >= dur) ? dur - 1e-6 : t);
  }

  function toCSV(wave) {
    var out = [];
    out.push('#ufo-wave-csv/1');
    out.push('#name=' + wave.name);
    out.push('#duration=' + wave.duration);
    out.push('#mode=' + wave.mode);
    out.push('#base=' + wave.base);
    out.push('#unit=0.1s');
    out.push('# 列顺序: 时间戳(0.1秒) 左方向(0正/1反) 左速度 右方向(0正/1反) 右速度  [左=通道A 右=通道B]');
    var A = wave.channels.A || [], B = wave.channels.B || [];
    var times = [], i;
    for (i = 0; i < A.length; i++) times.push(A[i][0]);
    for (i = 0; i < B.length; i++) if (times.indexOf(B[i][0]) < 0) times.push(B[i][0]);
    times.sort(function (x, y) { return x - y; });
    for (i = 0; i < times.length; i++) {
      var t = times[i];
      var va = valueAt(wave, 'A', t), vb = valueAt(wave, 'B', t);
      out.push([
        Math.round(t * 10),
        va < 0 ? 1 : 0, Math.abs(Math.round(va)),
        vb < 0 ? 1 : 0, Math.abs(Math.round(vb))
      ].join(','));
    }
    return out.join('\n') + '\n';
  }

  // ============================ JSON ============================
  function expandJSON(obj, opts) {
    opts = opts || {};
    var list = [], warnings = [], i;
    if (Array.isArray(obj)) list = obj;
    else if (obj && Array.isArray(obj.waves)) list = obj.waves;
    else if (obj && obj.channels) list = [obj];
    else if (obj && obj.wave && obj.wave.channels) list = [obj.wave];
    else throw new Error('无法识别的 JSON 结构：既不是单个波形，也不是波形包 { waves: [...] }');

    var out = [];
    for (i = 0; i < list.length; i++) {
      var w = normalize(list[i], { name: opts.name });
      if (!w.channels.A.length && !w.channels.B.length) {
        warnings.push({ level: 'warn', text: '「' + w.name + '」没有任何断点，已跳过。' });
        continue;
      }
      out.push(w);
    }
    if (!out.length) throw new Error('JSON 里没有可用的波形');
    return { waves: out, warnings: warnings, source: 'json' };
  }

  // 自动嗅探：以 { 或 [ 开头视为 JSON，否则按 CSV 解析
  function parseText(text, opts) {
    var s = String(text).replace(/^\uFEFF/, '');
    var first = s.replace(/^\s+/, '').charAt(0);
    if (first === '{' || first === '[') return expandJSON(JSON.parse(s), opts);
    return fromCSV(s, opts);
  }

  function bundleOf(waves) {
    return { format: 'ufo-wave-bundle/1', exportedAt: new Date().toISOString(), waves: waves };
  }

  WC.format = {
    FORMAT_ID: FORMAT_ID, BUNDLE_ID: 'ufo-wave-bundle/1', LIMIT: LIMIT, DEFAULT_DUR: DEFAULT_DUR,
    clamp: clamp, newId: newId, normalize: normalize, durationOf: durationOf,
    sampleWave: sampleWave, sampleScaled: sampleScaled, phaseAt: phaseAt,
    peakOf: peakOf, describe: describe, toCSV: toCSV,
    fromCSV: fromCSV, expandJSON: expandJSON, parseText: parseText, bundleOf: bundleOf
  };


})();
