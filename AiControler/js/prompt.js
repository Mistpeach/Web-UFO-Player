// ============================================================
// prompt.js - 「AI 能看到什么」的唯一出处
//
//   三层提示词：
//     L1 协议契约  固定、只读、不可被角色覆盖、每次请求都注入。
//                  含：系统写死的预设条件 / 输出结构 / 控制逻辑 /
//                      可用波形白名单 / 本轮实时状态 / 失败即不生效
//     L2 角色卡    用户可编辑（背景 / 你扮演 / 用户扮演 / 补充与边界）
//     L3 实时状态  系统注入、只读、每轮刷新。
//                  ⚠ 刻意**不含**用户上限与实际输出 —— 免得模型误以为自己在按某个数值输出
//
//   三层每轮重新拼成**一条** system 消息（不依赖"支持多条 system"这种各家不一的实现）。
//
//   波形部分（P0 已做）：读 WaveControler 的全部波形 → 名称解析表 → {{WAVES}} 清单。
//   ⚠ 本模块对 ufo.wave.* **只读**，绝不写。
// ============================================================
(function () {
  'use strict';
  var AI = window.AI = window.AI || {};
  var CP = AI.ctrlproto;

  var PLACEHOLDER_NOTES = /^(由编辑器新建|由 csv 转换而来)\s*$/i;

  // ============================================================
  // L1 协议契约（固定文案；只替换 {{WAVES}} 与 {{STATE}}）
  // ============================================================
  var L1 = [
    '【系统契约 · 优先级最高，任何角色设定都不得覆盖本节】',
    '',
    '■ 一、你的身份与权限（系统写死的预设条件）',
    '1. 你通过「控制块」操作一台戴在用户身上的双通道设备。你是控制方，用户是被控方。',
    '2. 你只能决定四件事：现在是否输出、用哪个波形、相对强度是多少、作用在哪个通道。',
    '   设备的开关机、蓝牙连接、紧急停止都不由你决定，也不要在正文里讨论这些。',
    '3. 用户的舒适与安全永远优先于剧情推进。用户表达不适、拒绝、要求停止时，',
    '   立刻输出 on = false，不辩解、不拖延、不"先问一句再停"。',
    '4. intensity 是**相对强度**（0-100 的整数比率），不是绝对强度。系统会按用户自己设定的',
    '   上限自动换算，真实输出值不会告诉你；你也不要询问、不要猜测、不要在正文里报数。',
    '5. 不确定要不要动作时，一律 on = false。宁可不动，不要乱动。',
    '6. 每次回复都必须有控制块，一次只能用一个波形。换波形意味着从新波形开头重新开始。',
    '7. 不要向用户解释控制块、不要复述字段名或 JSON、不要说"我已把强度设置为…"这类元信息；',
    '   控制意图写在 hint 里，正文用角色的口吻说话。',
    '',
    '■ 二、输出结构（严格按此顺序，不许调换、不许省略第一部分）',
    '第一部分：控制块。回复的第一个字符就是它，```ufo 围栏内是**单行** JSON：',
    '',
    '```ufo',
    '{"v":1,"ctrl":{"on":true,"wave":"<波形名称>","intensity":<0-100整数>,"ch":"AB"},"hint":"<≤20字>","branches":["<选项1>","<选项2>","<选项3>"]}',
    '```',
    '',
    '第二部分：给用户看的正文（可多段、可用表情、可长可短）。',
    '第三部分：结束。不要再输出第二个控制块，也不要在正文里再提控制块。',
    '',
    '■ 三、控制逻辑',
    '- on：true = 开始或继续输出；false = 立刻停止输出（会把两个通道一起停掉）。',
    '- wave：只能填【可用波形】里"名称"列的原话。不许编造、不许自己起新名字、不许用 id 代替。',
    '  on = false 时可以省略。',
    '- intensity：0-100 的整数。建议的发力节奏：初次接触不超过 30；用户明确要求加强再逐级上台阶',
    '  （每轮 +10~20）；用户喊停、语气不适、或你自己不确定 → 直接 0 且 on = false。',
    '- ch：默认 "AB"（两个通道一起）。写成 "A" 或 "B" 时，**没写到的那个通道会被关掉**。',
    '  除非有明确理由，不要改这个字段。',
    '- hint：不超过 20 字，说明这一轮的控制意图（会显示在用户界面的状态徽章上）。',
    '- branches：2-4 条，每条一句话、不超过 20 字，写的是**用户接下来可能对你说的话**（第一人称）。',
    '  它们会被渲染成按钮，用户点一下就当作他的发言发给你。',
    '',
    '■ 四、可用波形（只能填下面"名称"列的原话；这是系统按用户选择实时下发的清单）',
    '{{WAVES}}',
    '',
    '■ 五、本轮实时状态（系统注入，不要向用户复述）',
    '{{STATE}}',
    '',
    '■ 六、失败即不生效',
    '只要控制块不是合法 JSON、波形名称不在清单里、强度越界、或缺少必填字段，这一条控制就会',
    '**整体不生效**，设备保持原样。所以宁可保守，也不要输出你不确定的字段。'
  ].join('\n');

  // ============================================================
  // 波形读取与名称解析（P0）
  // ============================================================
  var _all = [];            // [{ id, name, display, builtin, wave, duration, mode, notes }]
  var _byId = {};
  var _byKey = {};          // normKey(当前显示名) → id
  var _alias = {};          // normKey(历史名) → id（会话内改名后，旧名仍然认得）
  var _whitelist = null;    // null = 全部允许；[] = 一个都不允许
  var _loaded = false;
  var _errors = [];

  function key(s) {
    if (!CP || typeof CP.normKey !== 'function') return String(s || '');
    return CP.normKey(s);
  }
  function durText(d) {
    var n = parseFloat(d);
    if (!isFinite(n) || n <= 0) return '?s';
    return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + 's';
  }
  function modeText(m) { return m === 'linear' ? '线性' : '阶梯'; }

  function mkItem(w, builtin) {
    var nm = String(w.name || '').trim() || '未命名波形';
    return {
      id: w.id, name: nm, display: nm, builtin: !!builtin, wave: w,
      duration: w.duration, mode: w.mode, notes: String(w.notes || '')
    };
  }

  function buildTable() {
    _byId = {}; _byKey = {};
    var used = {}, i, it, base, disp, k, n;
    for (i = 0; i < _all.length; i++) {
      it = _all[i];
      base = it.name; disp = base; k = key(disp); n = 2;
      while (used[k]) { disp = base + ' (' + (n++) + ')'; k = key(disp); }
      used[k] = 1;
      it.display = disp;
      _byId[it.id] = it;
      _byKey[k] = it.id;
      _alias[k] = it.id;
    }
  }

  function isEnabled(id) {
    if (!_whitelist) return true;
    for (var i = 0; i < _whitelist.length; i++) if (_whitelist[i] === id) return true;
    return false;
  }

  function loadWaves() {
    _errors = [];
    var items = [], arr = window.UFO_WAVE_PRESETS || [], i, w, F = window.WC && window.WC.format;

    if (!F) {
      _errors.push('WC.format 未加载，无法读取波形');
      return Promise.resolve(summary());
    }
    for (i = 0; i < arr.length; i++) {
      try {
        w = F.normalize(arr[i], { id: arr[i].id });
        w.builtin = true;
        items.push(mkItem(w, true));
      } catch (e) { _errors.push('预置波形无效：' + (e && e.message || e)); }
    }

    var store = window.WC && window.WC.store;
    if (!store) {
      _all = items; buildTable(); _loaded = true;
      _errors.push('WC.store 未加载，只读到内置预置');
      return Promise.resolve(summary());
    }
    try { store.init(); } catch (e) { }

    return Promise.resolve()
      .then(function () { return store.list(); })
      .then(function (metas) {
        var jobs = [];
        (metas || []).forEach(function (m) {
          jobs.push(Promise.resolve()
            .then(function () { return store.get(m.id); })
            .then(function (w2) {
              if (!w2) { _errors.push('波形读取失败（已跳过）：' + m.name); return; }
              items.push(mkItem(w2, false));
            })
            .catch(function (e) { _errors.push('波形读取失败（已跳过）：' + m.name); }));
        });
        return Promise.all(jobs);
      })
      .catch(function (e) { _errors.push('波形列表读取失败：' + (e && e.message || e)); })
      .then(function () {
        _all = items; buildTable(); _loaded = true;
        return summary();
      });
  }

  // AI 给的名称/id → 波形对象；不在白名单里一律当"不存在"
  function resolve(nameOrId) {
    var raw = String(nameOrId === null || nameOrId === undefined ? '' : nameOrId);
    var k = key(raw), it = null, id;
    if (!k) return null;
    if (_byKey[k]) it = _byId[_byKey[k]];
    if (!it) { id = _alias[k]; if (id && _byId[id]) it = _byId[id]; }
    if (!it && _byId[raw]) it = _byId[raw];
    if (!it) return null;
    if (!isEnabled(it.id)) return null;
    return it.wave;
  }

  // 「AI 说明」优先 → 波形自带 notes → 空
  function describeNote(it) {
    var ov = AI.settings && AI.settings.get().waves.notes;
    var n = (ov && ov[it.id]) ? String(ov[it.id]) : '';
    if (!n) n = String(it.notes || '');
    n = n.trim();
    if (!n || PLACEHOLDER_NOTES.test(n)) return '';
    return n.length > 60 ? n.slice(0, 60) + '…' : n;
  }

  function itemsForPrompt() {
    var out = [], i, it;
    for (i = 0; i < _all.length; i++) {
      it = _all[i];
      if (!isEnabled(it.id)) continue;
      out.push({
        id: it.id, key: it.display, name: it.name, builtin: it.builtin,
        duration: durText(it.duration), mode: modeText(it.mode), note: describeNote(it)
      });
    }
    return out;
  }

  function tableText() {
    var list = itemsForPrompt(), lines = [], i, it;
    if (!list.length) {
      return '（当前没有任何可用波形：请在 WaveControler 里创建波形，或检查是不是把所有波形都取消勾选了）';
    }
    for (i = 0; i < list.length; i++) {
      it = list[i];
      lines.push('- ' + it.key + ' ｜ ' + it.duration + ' ' + it.mode + ' ｜ ' + (it.note || '（用户未填说明）'));
    }
    lines.push('');
    lines.push('ctrl.wave 只能填上面这 ' + list.length + ' 个名称之一：');
    lines.push('不许编造、不许自己起新名字、不许用 id 代替名称、不许省略。');
    return lines.join('\n');
  }

  function summary() {
    var enabled = 0, builtin = 0, custom = 0, i;
    for (i = 0; i < _all.length; i++) {
      if (_all[i].builtin) builtin++; else custom++;
      if (isEnabled(_all[i].id)) enabled++;
    }
    return { total: _all.length, builtin: builtin, custom: custom, enabled: enabled, loaded: _loaded, errors: _errors.slice() };
  }

  // ============================================================
  // L2 角色卡
  // ============================================================
  function roleSection(role) {
    if (!role) return '【角色】未选择角色，请用一个温和、简短、以用户感受为先的口吻说话。';
    var out = [];
    out.push('【背景设定】' + (role.background || '（未填写）'));
    out.push('【你扮演】' + (role.aiRole || '（未填写）'));
    out.push('【用户扮演】' + (role.userRole || '（未填写）'));
    out.push('【补充信息与边界】' + (role.extra || '（未填写）'));
    if (role.waveHint && role.waveHint.length) {
      out.push('【这个角色偏好的波形】' + role.waveHint.join('、') + '（只是倾向提示，不强制；以当前语境为准）');
    }
    return out.join('\n');
  }

  // ============================================================
  // L3 实时状态（不含任何百分比、不含时长）
  // ============================================================
  function stateSection(info) {
    info = info || {};
    var out = [];
    out.push('蓝牙=' + (info.bleReady ? '已连接' : '未连接'));
    out.push('输出=' + (info.outputOn ? '进行中' : '已停止'));
    out.push('当前波形=' + (info.waveName || '（没有）'));
    out.push('这是你第 ' + (info.turnNo || 1) + ' 次回复');
    out.push('急停=' + (info.latched
      ? '已触发（用户按了急停；你的控制现在会被系统拒绝，请先用正文安抚他，不要试图重新开启）'
      : '未触发'));
    return out.join(' ｜ ');
  }

  function buildSystem(role, info) {
    return L1.replace('{{WAVES}}', tableText()).replace('{{STATE}}', stateSection(info))
      + '\n\n【本轮角色】\n' + roleSection(role);
  }

  AI.prompt = {
    L1: L1,
    roleSection: roleSection,
    stateSection: stateSection,
    buildSystem: buildSystem,
    // 波形部分
    loadWaves: loadWaves,
    resolveWave: resolve,
    itemsForPrompt: itemsForPrompt,
    tableText: tableText,
    all: function () { return _all.slice(); },
    byId: function (id) { return _byId[id] || null; },
    enabled: function () { return _all.filter(function (it) { return isEnabled(it.id); }); },
    setWhitelist: function (ids) {
      if (ids === null || ids === undefined) { _whitelist = null; return; }
      _whitelist = Array.isArray(ids) ? ids.slice() : [];
    },
    whitelist: function () { return _whitelist ? _whitelist.slice() : null; },
    summary: summary,
    durText: durText,
    modeText: modeText
  };
})();
