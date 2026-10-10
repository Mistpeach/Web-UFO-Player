// ============================================================
// chat.js - 会话状态机（完整版）
//
//   一次真实往返：
//     send(text)
//       → 推入 user 消息 → 组装 system(L1+L2+L3) + 裁剪后的历史
//       → llm.send（流式）→ 每来一段增量就用 ctrlproto.parse 重算"可见文本"
//         （控制块从第一个字符起就不会上屏，最终文本与流式过程完全一致）
//       → 结束后 buildTurn(全文)：解析 → 门禁 → 应用到引擎
//       → 原文（含控制块）留在历史里，让模型看到自己的格式、保持一致
//
//   门禁顺序（任一不过即拒绝，见 gate()）：
//     ⓪ 没有控制块 → 弱提示  ① 急停闩锁  ② AI 控制总开关
//     ③ ctrl 校验  ④ 上限乘数  ⑤ 蓝牙就绪  ⑥ 写引擎
// ============================================================
(function () {
  'use strict';
  var AI = window.AI = window.AI || {};

  var state = {
    messages: [],
    turnNo: 0,
    aiControlEnabled: true,
    userMaxPct: 50,
    roleId: 'role-gentle',
    flip: false,               // 交换左右电机（在 ui 层包装 WC.ble.send 实现）
    latched: false,            // 急停闩锁（**本应用自己持有**，见 isLatched 的说明）
    streaming: false,
    draft: null,               // 流式中的 { text, record }
    lastRecord: null,
    lastError: null,
    lastRequest: null
  };

  var log = [], subs = [], abortCtl = null;

  function nowTs() { return Date.now(); }
  function emit(type, payload) {
    var ev = { type: type };
    if (payload) for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) ev[k] = payload[k];
    for (var i = 0; i < subs.length; i++) { try { subs[i](ev); } catch (e) { } }
  }
  function pushLog(kind, title, payload) {
    log.push({ ts: nowTs(), kind: kind, title: title, payload: payload });
    if (log.length > 40) log.shift();
    emit('log');
  }
  function pushMessage(m) {
    m.ts = m.ts || nowTs();
    state.messages.push(m);
    emit('message', { message: m });
    return m;
  }

  // ---------- 配置同步 ----------
  function cfg() { return AI.settings.get(); }

  function applySettings() {
    var c = cfg();
    state.userMaxPct = Math.max(0, Math.min(100, parseInt(c.safety.userMaxPct, 10) || 0));
    state.aiControlEnabled = !!c.safety.aiControlEnabled;
    state.roleId = (c.ui && c.ui.roleId) || 'role-gentle';
    applyWhitelist();
  }

  // 白名单 = 全部波形 − 用户取消勾选的（新波形自动纳入）
  function applyWhitelist() {
    if (!AI.prompt) return;
    var c = cfg(), dis = (c.waves && c.waves.disabled) || [];
    var all = AI.prompt.all(), ids = [], i;
    for (i = 0; i < all.length; i++) if (dis.indexOf(all[i].id) < 0) ids.push(all[i].id);
    AI.prompt.setWhitelist(ids);
  }

  // ---------- 引擎 / 蓝牙 ----------
  function bleReady() {
    var ble = window.WC && window.WC.ble;
    if (!ble) return false;
    try { return !!ble.isReady(); } catch (e) { return false; }
  }
  function outputOn() {
    var eng = window.WC && window.WC.engine;
    if (!eng) return false;
    return !!(eng.isRunning() && (eng.ch.A.enabled || eng.ch.B.enabled));
  }
  function currentWaveName() {
    var eng = window.WC && window.WC.engine;
    if (!eng) return '';
    if (eng.ch.A.wave) return eng.ch.A.wave.name;
    if (eng.ch.B.wave) return eng.ch.B.wave.name;
    return '';
  }
  // 急停闩锁。**以本应用自己的 state.latched 为准**，引擎那个只作兜底：
  //   engine.start() 内部会把引擎的 latched 清掉（引擎既有语义，供"重新开始"用），
  //   任何"把引擎拉起来"的路径都会顺手解除锁定 —— 那是不能接受的，
  //   所以锁定状态必须由应用层持有，恢复只能走显式的 resume()。
  function isLatched() {
    var eng = window.WC && window.WC.engine;
    return !!(state.latched || (eng && eng.isLatched && eng.isLatched()));
  }

  // L3 的输入（刻意不含用户上限与实际输出）
  function l3info() {
    return {
      bleReady: bleReady(),
      outputOn: outputOn(),
      waveName: currentWaveName(),
      turnNo: state.turnNo + 1,
      latched: isLatched()
    };
  }

  function ensureEngineRunning() {
    var eng = window.WC && window.WC.engine;
    if (!eng) return false;
    // ⚠ 急停锁定中绝不因为"要开输出"而把引擎拉起来：
    //   engine.start() 内部会清掉 latched（引擎既有实现），必须在这里拦一道。
    if (isLatched()) return false;
    if (!eng.isRunning()) {
      eng.start();
      if (window.WC.scope && window.WC.scope.startLoop) { try { window.WC.scope.startLoop(); } catch (e) { } }
      return true;
    }
    return false;
  }

  // ---------- 应用控制 ----------
  // 语义：on=false → 停全部通道（不管 ch）；on=true → 只开 ch 里的通道，其余关掉。
  function applyCtrl(ctrl) {
    var eng = window.WC.engine;
    var maxRatio = Math.max(0, Math.min(1, state.userMaxPct / 100));
    var k = Math.max(0, Math.min(1, ctrl.aiRatio * maxRatio));
    var names = ['A', 'B'], i, n, out = { k: k, channels: [], started: false };

    if (!ctrl.on) {
      for (i = 0; i < 2; i++) eng.setEnabled(names[i], false);
      out.channels = names.slice();
      try { window.WC.ble.send(0, 0); } catch (e) { }
      return out;
    }
    out.started = ensureEngineRunning();
    for (i = 0; i < 2; i++) {
      n = names[i];
      if (ctrl.chans.indexOf(n) < 0) { eng.setEnabled(n, false); continue; }
      if (ctrl.wave) {
        eng.setWave(n, ctrl.wave);
        if (window.WC.scope && window.WC.scope.setWave) { try { window.WC.scope.setWave(n, ctrl.wave); } catch (e) { } }
      }
      eng.setIntensity(n, k);
      eng.setEnabled(n, true);
      out.channels.push(n);
    }
    return out;
  }

  // ---------- 门禁 ----------
  function gate(rec) {
    var g = {
      status: 'rejected', reason: '', code: '',
      aiPct: null, maxPct: state.userMaxPct, k: null, channels: [], started: false
    };
    if (!rec.hasBlock && rec.errors.length && rec.errors[0].code === 'no-block') {
      g.status = 'none'; g.code = 'no-block'; g.reason = '本条没有控制信息（设备保持原状）';
      return g;
    }
    if (isLatched()) {
      g.code = 'latched';
      g.reason = '已急停：本条控制未生效（需要你手动恢复 AI 控制）';
      return g;
    }
    if (!state.aiControlEnabled) {
      g.code = 'ai-off'; g.status = 'display-only';
      g.reason = '「允许 AI 控制」已关闭：本条控制只显示、不执行';
      return g;
    }
    if (!rec.ctrl) {
      g.code = (rec.flags && rec.flags.truncated) ? 'truncated' : 'invalid';
      g.reason = '控制信息不合法（' + describeErrors(rec.errors) + '）：本条控制未生效';
      return g;
    }
    g.aiPct = rec.ctrl.intensity;
    var r = applyCtrl(rec.ctrl);
    g.k = r.k; g.channels = r.channels; g.started = r.started;
    g.status = 'applied';
    if (!bleReady()) {
      g.code = 'no-ble';
      g.reason = '未连接蓝牙：控制已记录在界面上，但没有发到设备';
    } else { g.code = 'ok'; g.reason = ''; }
    return g;
  }

  var FIELD_TEXT = {
    'v': '协议版本', 'ctrl': '控制信息', 'ctrl.on': '开关', 'ctrl.ch': '通道',
    'ctrl.wave': '波形', 'ctrl.intensity': '强度', 'hint': '提示', 'branches': '分支'
  };
  var ERR_TEXT = {
    'no-block': '这条回复里没有控制块',
    'truncated-block': '控制块没有写完（被截断）',
    'bad-json': 'JSON 解析失败',
    'empty': '控制块是空的',
    'not-object': '控制块不是对象',
    'bad-version': '版本号不是整数',
    'unknown-version': '协议版本不认识',
    'missing-ctrl': '缺少 ctrl 部分',
    'bad-ctrl': 'ctrl 不是对象',
    'bad-on': '必须是 true 或 false',
    'bad-ch': '只能是 A / B / AB',
    'bad-wave': '必须是字符串',
    'unknown-wave': '不在可用清单里',
    'missing-wave': '开启输出时必须给出',
    'bad-intensity': '必须是整数',
    'intensity-out-of-range': '必须在 0-100 之间',
    'missing-intensity': '开启输出时必须给出',
    'bad-hint': '不是字符串',
    'bad-branches': '不是数组',
    'empty-branches': '里面没有可用内容'
  };

  function describeErrors(errors) {
    if (!errors || !errors.length) return '原因未知';
    var out = [], i, e, t, label;
    for (i = 0; i < errors.length && i < 4; i++) {
      e = errors[i];
      t = ERR_TEXT[e.code] || '格式不符';
      label = FIELD_TEXT[e.field] || '';
      if (label) t = label + '：' + t;
      if (e.got !== undefined && e.got !== null && e.got !== '') t += '（收到 ' + String(e.got).slice(0, 24) + '）';
      out.push(t);
    }
    if (errors.length > 4) out.push('等共 ' + errors.length + ' 处问题');
    return out.join('；');
  }

  // ---------- 吃一条 AI 原文：解析 → 门禁 → 应用 ----------
  function buildTurn(rawText, opts) {
    opts = opts || {};
    var rec = AI.ctrlproto.parse(rawText, { resolveWave: AI.prompt.resolveWave });
    rec.gate = gate(rec);
    state.lastRecord = rec;
    state.turnNo++;

    pushLog('parse', '第 ' + state.turnNo + ' 条 AI 回复 · 解析', {
      text: rec.text,
      ctrl: rec.ctrl ? {
        on: rec.ctrl.on, wave: rec.ctrl.waveKey, intensity: rec.ctrl.intensity,
        ch: rec.ctrl.ch, aiRatio: rec.ctrl.aiRatio
      } : null,
      hint: rec.hint, branches: rec.branches, errors: rec.errors, flags: rec.flags, gate: rec.gate
    });

    if (!opts.silent) {
      pushMessage({ role: 'assistant', text: rec.text, raw: rec.raw, record: rec });
    }
    return rec;
  }

  // ---------- 组装请求 ----------
  async function buildMessages() {
    var role = await AI.roles.current();
    var sys = AI.prompt.buildSystem(role, l3info());
    var limit = Math.max(1, parseInt((cfg().ui || {}).historyLimit, 10) || 20);
    var hist = state.messages.filter(function (m) { return m.role !== 'sys'; }).slice(-limit * 2);
    var out = [{ role: 'system', content: sys }];
    hist.forEach(function (m) {
      out.push({
        role: m.role,
        // 助手消息带原文（含控制块）：让模型看到自己的格式，保持输出一致
        content: (m.role === 'assistant') ? (m.raw || m.text) : m.text
      });
    });
    return out;
  }

  // ---------- 发一轮 ----------
  async function send(text, opts) {
    opts = opts || {};
    if (state.streaming) { pushSys('还在生成中…'); return null; }
    var t = String(text === null || text === undefined ? '' : text).trim();
    if (!t) return null;
    if (!opts.silent) pushUser(t, opts);

    var c = cfg();
    if (!AI.settings.available()) {
      return fail('storage', '浏览器的本地存储不可用，配置读不出来：' + AI.settings.reason());
    }
    if (!String(c.api.baseUrl || '').trim() || !String(c.api.model || '').trim()) {
      return fail('config', '还没有配置「接口地址」或「模型」：点工具栏的「⚙ 设置」填好并测试一下。');
    }

    var msgs;
    try { msgs = await buildMessages(); }
    catch (e) { return fail('prompt', '组装请求失败：' + (e && e.message || e)); }

    // 「等待 AI 期间保持当前动作」：关掉它就先归零再发请求（每轮都停一下，体感更割裂）
    if (!c.safety.keepRunningWhileWaiting) {
      try {
        window.WC.engine.setEnabled('A', false);
        window.WC.engine.setEnabled('B', false);
        window.WC.ble.send(0, 0);
      } catch (e) { }
    }

    state.streaming = true;
    state.draft = { text: '', record: null };
    state.lastError = null;
    abortCtl = new AbortController();
    emit('stream-start');

    try {
      var out = await AI.llm.send(c, msgs, {
        signal: abortCtl.signal,
        onDelta: function (d) {
          state.draft.text += d;
          // 每来一段都重算"可见文本"：控制块从第一个字符起就不会上屏
          state.draft.record = AI.ctrlproto.parse(state.draft.text, { resolveWave: AI.prompt.resolveWave });
          emit('delta');
        }
      });
      state.lastRequest = out.request;
      pushLog('llm', '接口返回 · ' + out.ms + 'ms · ' + out.chars + ' 字', {
        usage: out.usage, request: out.request, text: String(out.text).slice(0, 3000)
      });
      var rec = buildTurn(out.text);
      emit('turn-done', { record: rec });
      return rec;
    } catch (e) {
      var k = (e && e.AiClassified) || { kind: 'unknown', text: String(e && e.message || e), status: 0 };
      state.lastError = k;
      pushLog('llm-error', '接口失败 · ' + k.kind, k);
      pushSys('⚠ ' + k.text);
      emit('error', k);
      return null;
    } finally {
      state.streaming = false;
      state.draft = null;
      abortCtl = null;
      emit('stream-end');
    }
  }

  function fail(kind, text) {
    state.lastError = { kind: kind, text: text };
    pushSys('⚠ ' + text);
    emit('error', state.lastError);
    return null;
  }

  function stop() {
    if (abortCtl) { try { abortCtl.abort(); } catch (e) { } return true; }
    return false;
  }

  function pushUser(text, opts) {
    var t = String(text === null || text === undefined ? '' : text).trim();
    if (!t) return null;
    return pushMessage({ role: 'user', text: t, viaBranch: !!(opts && opts.viaBranch) });
  }
  function pushSys(text) { return pushMessage({ role: 'sys', text: String(text || '') }); }

  // 点分支：该句作为"用户的消息"发出去
  function pickBranch(i) {
    var rec = state.lastRecord;
    if (!rec || !rec.branches || !rec.branches[i]) return null;
    return send(rec.branches[i], { viaBranch: true });
  }

  // 重发上一轮
  async function regenerate() {
    if (state.streaming) return null;
    var i = state.messages.length - 1, j;
    while (i >= 0 && state.messages[i].role !== 'assistant') i--;
    if (i < 0) { pushSys('还没有可以重发的回复'); return null; }
    j = i - 1;
    while (j >= 0 && state.messages[j].role !== 'user') j--;
    if (j < 0) { pushSys('找不到对应的用户发言，无法重发'); return null; }
    var text = state.messages[j].text;
    state.messages.splice(j, 2);          // 同时去掉那条 user 与 assistant，重发时再推一遍
    state.turnNo = Math.max(0, state.turnNo - 1);
    emit('reset');
    return send(text);
  }

  function clearSession() {
    state.messages.length = 0;
    state.turnNo = 0;
    state.lastRecord = null;
    state.lastError = null;
    state.draft = null;
    emit('reset');
  }

  // ---------- 导出 ----------
  function exportText() {
    var lines = ['# AI 控制器 · 对话记录', '', '导出时间：' + new Date().toLocaleString(), ''];
    state.messages.forEach(function (m) {
      var r = m.record;
      if (m.role === 'user') lines.push('## 我', '', m.text, '');
      else if (m.role === 'assistant') {
        lines.push('## AI', '', m.text || '（没有正文）', '');
        if (r && r.ctrl) {
          lines.push('> 控制：' + (r.ctrl.on
            ? ((r.ctrl.wave ? r.ctrl.wave.name : r.ctrl.waveKey) + ' · AI ' + r.ctrl.intensity + '% · 通道 ' + r.ctrl.ch)
            : '停止输出') + (r.hint ? ' · ' + r.hint : ''), '');
        } else if (r && r.gate) {
          lines.push('> 控制：未生效（' + r.gate.reason + '）', '');
        }
        if (r && r.branches && r.branches.length) lines.push('> 当时给出的选项：' + r.branches.join(' / '), '');
      } else if (m.role === 'sys') lines.push('> ' + m.text, '');
    });
    return lines.join('\n');
  }

  function downloadSession() {
    var text = exportText();
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    a.href = url;
    a.download = 'ai-controler-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.md';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { } }, 0);
    return text;
  }

  // ============================================================
  // 内置脚本化假 AI（无需密钥也能演示 / 自检）
  // ============================================================
  var SCRIPT = [
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"心跳（双跳）","intensity":30,"ch":"AB"},"hint":"先轻轻试一下","branches":["再强一点","换个节奏","先停一下"]}\n```\n' +
    '好，先让你感受一下。深呼吸，跟着节律走。',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"心跳（双跳）","intensity":55,"ch":"AB"},"hint":"升一档","branches":["再快一点","就这样","太强了"]}\n```\n' +
    '那我往上加一档，注意身体的反馈。',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"随机抖动 3s","intensity":40,"ch":"AB"},"hint":"换个不可预测的","branches":["有意思","慢一点"]}\n```\n' +
    '换个花样，这次你猜不到下一秒。',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"心跳 (双跳)","intensity":35,"ch":"AB"},"hint":"回到心跳","branches":["继续"]}\n```\n' +
    '回到刚才的节律。',
    '```ufo\n{"v":1,"ctrl":{"on":false},"hint":"先停下休息","branches":["休息好了","再开一次"]}\n```\n' +
    '先停下来，休息一下。',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"不存在的波形","intensity":60,"ch":"AB"},"hint":"换个不存在的"}\n```\n' +
    '（这一条的控制信息是无效的，用来验证"非法波形不得触发"。）',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"方形脉冲","intensity":130,"ch":"AB"}}\n```\n' +
    '（这一条强度 130 越界，应当被拒绝。）',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"慢爬升 10s","intensity":25,},"hint":"尾随逗号"}\n```\n' +
    '（这一条 JSON 多了一个逗号，应当被修复。）',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"方形脉冲"\n```\n' +
    '（这一条控制块没写完，应当不生效。）',
    '```ufo\n{"v":1,"ctrl":{"wave":"方形脉冲","intensity":40}}\n```\n' +
    '（这一条少了开关字段，应当被拒绝。）',
    '这一条什么都没带，就是普通聊天。',
    '我建议你先坐好，慢慢来。\n\n```ufo\n{"v":1,"branches":["我准备好了","再等等"],"hint":"等你准备好"}\n```',
    '```ufo\n{"v":1,"ctrl":{"on":true,"wave":"双通道交替","intensity":45,"ch":"A"},"hint":"只开 A 通道","branches":["开 B 试试","两个都开"]}\n```\n' +
    '这次只用 A 通道。'
  ];
  var scriptIdx = 0;

  // 同步跑一条脚本（不发网络请求）：给自检与"跑一遍假 AI"用
  function demoNext() {
    var raw = SCRIPT[scriptIdx % SCRIPT.length];
    scriptIdx++;
    return buildTurn(raw);
  }

  // 演示模式的一轮：假装请求了一轮，然后喂脚本回复
  async function demoSend(text) {
    if (state.streaming) return null;
    pushUser(text);
    state.streaming = true;
    state.draft = { text: '', record: null };
    emit('stream-start');
    var raw = SCRIPT[scriptIdx % SCRIPT.length];
    scriptIdx++;
    // 逐段吐字，模拟流式（也顺便验证"控制块不上屏"在流式下同样成立）
    var i = 0, step = 7;
    while (i < raw.length) {
      state.draft.text += raw.substr(i, step);
      state.draft.record = AI.ctrlproto.parse(state.draft.text, { resolveWave: AI.prompt.resolveWave });
      emit('delta');
      i += step;
      await new Promise(function (r) { setTimeout(r, 12); });
    }
    state.streaming = false;
    state.draft = null;
    emit('stream-end');
    var rec = buildTurn(raw);
    emit('turn-done', { record: rec });
    return rec;
  }

  AI.chat = {
    state: state,
    // 生命周期
    applySettings: applySettings, applyWhitelist: applyWhitelist,
    // 会话
    send: send, demoSend: demoSend, stop: stop, regenerate: regenerate,
    clearSession: clearSession, pickBranch: pickBranch,
    buildTurn: buildTurn, buildMessages: buildMessages, applyCtrl: applyCtrl, gate: gate,
    pushUser: pushUser, pushSys: pushSys,
    // 查询
    bleReady: bleReady, outputOn: outputOn, isLatched: isLatched,
    currentWaveName: currentWaveName, l3info: l3info, describeErrors: describeErrors,
    errText: ERR_TEXT, fieldText: FIELD_TEXT,
    // 导出与日志
    exportText: exportText, downloadSession: downloadSession,
    log: function () { return log.slice(); },
    clearLog: function () { log.length = 0; emit('log'); },
    subscribe: function (fn) { subs.push(fn); },
    // 演示脚本
    script: function () { return SCRIPT.slice(); },
    demoNext: demoNext,
    demoReset: function () { scriptIdx = 0; },
    demoIndex: function () { return scriptIdx; }
  };
})();
