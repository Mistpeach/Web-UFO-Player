// ============================================================
// ui.js - 界面装配（完整版）
//   对话渲染 / 控制徽章 / 分支按钮 / 状态条 / 手动控制 + 示波器 /
//   AI 可用波形白名单 / 设置 / 角色管理 / 急停（0.8s 双击 → 恢复需确认）/ 调试面板
//
//   急停的时间窗实现与 WaveControler/js/ui.js:368-388 一致
//   （两次 click + 时间窗，不用 ondblclick —— 触屏上 dblclick 不可靠）。
// ============================================================
(function () {
  'use strict';
  var AI = window.AI = window.AI || {};
  var WC = window.WC || {};

  var demoMode = /(^|[?&])demo=1(&|$)/.test(location.search);

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
  }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function parseInt10(v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var M = { manualInt: 100, askCb: null, testing: false, lastPrompt: null, testTimer: null };

  // ---------- 提示条 ----------
  function toast(msg, level) {
    var el = $('toast');
    if (!el) return;
    el.className = 'toast show ' + (level || 'info');
    el.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = 'toast'; }, level === 'warn' ? 6000 : 3200);
  }

  // ---------- 统一确认 / 提示弹窗 ----------
  function ask(title, text, onOk, okLabel) {
    $('askTitle').textContent = title || '请确认';
    $('askText').innerHTML = text || '';
    $('askOk').textContent = okLabel || '确定';
    M.askCb = onOk || null;
    $('askModal').classList.add('open');
  }
  function askClose() { $('askModal').classList.remove('open'); M.askCb = null; }
  function info(title, html) {
    $('infoTitle').textContent = title || '提示';
    $('infoBody').innerHTML = html || '';
    $('infoModal').classList.add('open');
  }
  function infoClose() { $('infoModal').classList.remove('open'); }

  // ============================================================
  // 消息渲染
  // ============================================================
  function badgeHtml(rec) {
    var g = rec.gate || {}, c = rec.ctrl, cls = 'ctrlBadge', parts = [];
    if (g.status === 'none') {
      cls += ' off'; parts.push('— 本条没有控制信息');
    } else if (g.status === 'display-only') {
      cls += ' off'; parts.push('🚫 未执行（AI 控制已关闭）');
      if (c) parts.push('AI 意向 <span class="kv">' + c.intensity + '%</span>');
    } else if (g.status === 'rejected') {
      cls += ' bad'; parts.push('❌ 本条控制无效'); parts.push(esc(g.reason));
    } else {
      cls += (c && c.on) ? ' on' : ' off';
      if (c && c.on) {
        parts.push('🔺 <b>' + esc(c.wave ? c.wave.name : c.waveKey) + '</b>');
        parts.push('AI <span class="kv">' + g.aiPct + '%</span> × 上限 <span class="kv">' + g.maxPct + '%</span>' +
          ' = 实际 <span class="kv">' + Math.round((g.k || 0) * 100) + '%</span>');
        parts.push('通道 ' + esc(c.ch));
        parts.push('输出中');
      } else {
        parts.push('⏹ 已停止输出');
        if (c) parts.push('通道 ' + esc(c.ch));
      }
      if (g.code === 'no-ble') parts.push('<span class="kv">⚠ 未连接蓝牙，未发到设备</span>');
    }
    if (rec.hint) parts.push('💭 ' + esc(rec.hint));
    return parts.length ? '<div class="' + cls + '">' + parts.join('<span class="sep2">·</span>') + '</div>' : '';
  }

  function branchHtml(rec, clickable) {
    if (!rec.branches || !rec.branches.length) return '';
    var h = '<div class="branchRow">', i;
    for (i = 0; i < rec.branches.length; i++) {
      h += '<button class="branchChip"' + (clickable ? '' : ' disabled') +
        (clickable ? ' onclick="AI.ui.pickBranch(' + i + ')"' : ' title="只有最新一条回复的选项可以点"') +
        '>' + esc(rec.branches[i]) + '</button>';
    }
    return h + '</div>';
  }

  function messageHtml(m, isLastAssistant, streaming) {
    if (m.role === 'user') {
      return '<div class="msg user"><div class="msgHead">你</div><div class="bubble">' + esc(m.text) + '</div></div>';
    }
    if (m.role === 'sys') {
      return '<div class="msg sys"><div class="bubble">' + esc(m.text) + '</div></div>';
    }
    var rec = m.record || {};
    var body = rec.text ? esc(rec.text) : '<span style="color:#666">（这条回复没有正文）</span>';
    var h = '<div class="msg ai"><div class="msgHead">AI</div><div class="bubble">' + body + '</div>' +
      badgeHtml(rec) + branchHtml(rec, isLastAssistant && !streaming);
    if (isLastAssistant && !streaming) {
      h += '<div class="msgTools"><button onclick="AI.ui.regenerate()">↻ 重发这一轮</button>' +
        '<button onclick="AI.ui.showLastPrompt()">📜 看这一轮的提示词</button></div>';
    }
    return h + '</div>';
  }

  function lastAssistantIndex() {
    var msgs = AI.chat.state.messages, i;
    for (i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') return i;
    return -1;
  }

  function renderMessages() {
    var list = $('chatList');
    if (!list) return;
    var msgs = AI.chat.state.messages, i, last = lastAssistantIndex();
    var html = '';
    for (i = 0; i < msgs.length; i++) html += messageHtml(msgs[i], i === last, false);
    list.innerHTML = html;
    renderDraft();
    scrollBottom();
  }

  // 流式草稿：每来一段增量只更新这一个节点
  function renderDraft() {
    var list = $('chatList');
    if (!list) return;
    var d = $('draftMsg'), st = AI.chat.state;
    if (!st.streaming || !st.draft) { if (d && d.parentNode) d.parentNode.removeChild(d); return; }
    var txt = (st.draft.record && st.draft.record.text) || '';
    var html = '<div class="msg ai"><div class="msgHead">AI</div><div class="bubble">' +
      (txt ? esc(txt) : '<span style="color:#666">正在生成…</span>') +
      '<span class="cursor"></span></div>' +
      (st.draft.record ? badgeHtml(st.draft.record) : '') + '</div>';
    if (!d) {
      d = document.createElement('div');
      d.id = 'draftMsg';
      list.appendChild(d);
    }
    d.innerHTML = html;
    scrollBottom();
  }

  function scrollBottom() {
    var s = $('chatScroll');
    if (s) s.scrollTop = s.scrollHeight;
  }

  // ============================================================
  // 状态条
  // ============================================================
  function renderStatus() {
    var eng = WC.engine, st = AI.chat.state, cfg = AI.settings.get();
    var latched = AI.chat.isLatched();

    var w = AI.chat.currentWaveName();
    $('stWave').innerHTML = '波形 <b>' + (w ? esc(w) : '—') + '</b>';
    $('stOut').innerHTML = AI.chat.outputOn() ? '<span class="ok">▶ 输出中</span>' : '⏸ 未输出';
    $('stBle').innerHTML = AI.chat.bleReady() ? '<span class="ok">🟢 蓝牙已连接</span>' : '⚪ 未连接';
    $('stAi').innerHTML = 'AI 控制 <b>' + (st.aiControlEnabled ? '<span class="ok">开</span>' : '<span class="warn">关</span>') + '</b>' +
      (latched ? ' <span class="bad">｜已急停锁定</span>' : '');
    $('stRole').innerHTML = '角色 <b id="stRoleName">' + esc(M.roleName || '—') + '</b>';

    var btn = $('btnStop');
    if (latched) {
      btn.classList.add('latched');
      btn.textContent = '⛔ 已急停 · 点这里恢复 AI 控制';
      btn.title = '恢复需要二次确认；恢复后不会自动重放上一轮的控制，输出保持关闭';
    } else {
      btn.classList.remove('latched');
      btn.textContent = '⏹ 急 停（连点两次）';
      btn.title = '防误触：0.8 秒内连点两次才会立即归零';
    }
    $('chkAiControl').checked = !!st.aiControlEnabled;
    $('btnBleDisc').disabled = !(WC.ble && WC.ble.connected);
    $('btnSend').disabled = st.streaming;
    $('btnStopGen').disabled = !st.streaming;
    $('chkOut').checked = !!(eng && eng.isRunning() && (eng.ch.A.enabled || eng.ch.B.enabled));
    renderDbgSummary();
  }

  function refreshRoleName() {
    AI.roles.current().then(function (r) {
      M.roleName = r ? (r.emoji + ' ' + r.name) : '—';
      var el = $('stRoleName');
      if (el) el.textContent = M.roleName;
      else renderStatus();
    });
  }

  // ============================================================
  // 手动控制 + 示波器
  // ============================================================
  function currentWaveObj() {
    var id = $('selWave').value;
    if (!id) return null;
    var it = AI.prompt.byId(id);
    return it ? it.wave : null;
  }

  function userMaxPct() { return clamp(parseInt10(AI.settings.get().safety.userMaxPct, 50), 0, 100); }
  function manualK() { return clamp(Math.min(M.manualInt, userMaxPct()), 0, 100) / 100; }

  function fillWaveSelect() {
    var sel = $('selWave'), all = AI.prompt.all(), keep = sel.value, i, it;
    var html = [];
    for (i = 0; i < all.length; i++) {
      it = all[i];
      html.push('<option value="' + esc(it.id) + '">' + (it.builtin ? '📦 ' : '✏️ ') + esc(it.display) + '</option>');
    }
    sel.innerHTML = html.join('') || '<option value="">（没有波形）</option>';
    if (keep) sel.value = keep;
    if (!sel.value && all.length) sel.value = all[0].id;
    updateWaveNote();
  }

  function updateWaveNote() {
    var it = AI.prompt.byId($('selWave').value);
    var el = $('waveNote');
    if (!it) { el.textContent = ''; return; }
    el.innerHTML = esc(AI.prompt.durText(it.duration) + ' ' + AI.prompt.modeText(it.mode)) +
      ' · ' + (it.builtin ? '内置' : '自定义') +
      (it.notes ? '<br>' + esc(it.notes) : '');
  }

  function manualOut(on) {
    var eng = WC.engine, names = ['A', 'B'], i, n, w;
    if (on) {
      if (AI.chat.isLatched()) { toast('已急停锁定：先点底部「恢复 AI 控制」', 'warn'); $('chkOut').checked = false; return; }
      w = currentWaveObj();
      if (!w) { toast('先选一个波形', 'warn'); $('chkOut').checked = false; return; }
      if (!eng.isRunning()) { eng.start(); if (WC.scope) WC.scope.startLoop(); }
      for (i = 0; i < 2; i++) {
        n = names[i];
        eng.setWave(n, w);
        if (WC.scope) WC.scope.setWave(n, w);
        eng.setIntensity(n, manualK());
        eng.setEnabled(n, true);
      }
      toast('手动输出已开启（' + Math.round(manualK() * 100) + '%）');
    } else {
      for (i = 0; i < 2; i++) eng.setEnabled(names[i], false);
      try { WC.ble.send(0, 0); } catch (e) { }
    }
    renderStatus();
  }

  function cancelTest() { if (M.testTimer) { clearTimeout(M.testTimer); M.testTimer = null; } }

  function testPulse() {
    var w = currentWaveObj();
    if (!w) { toast('先选一个波形', 'warn'); return; }
    if (AI.chat.isLatched()) { toast('已急停锁定：先恢复 AI 控制', 'warn'); return; }
    cancelTest();
    manualOut(true);
    var ms = Math.max(600, (parseFloat(w.duration) || 1) * 2 * 1000);
    toast('试听 ' + Math.round(ms / 100) / 10 + ' 秒（2 个波形周期），结束自动停');
    M.testTimer = setTimeout(function () { M.testTimer = null; manualOut(false); }, ms);
  }

  // ---------- AI 可用波形白名单 ----------
  function renderWaveList() {
    var all = AI.prompt.all();
    var cfg = AI.settings.get();
    var dis = cfg.waves.disabled || [], notes = cfg.waves.notes || {};
    var box = $('waveList'), i, it, on;
    var html = [], nOn = 0;
    for (i = 0; i < all.length; i++) {
      it = all[i];
      on = dis.indexOf(it.id) < 0;
      if (on) nOn++;
      html.push(
        '<div class="waveItem' + (on ? '' : ' off') + '">' +
        '<div class="wTop">' +
        '<input type="checkbox" data-wid="' + esc(it.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="wName">' + esc(it.display) + '</span>' +
        '<span class="wMeta">' + esc(AI.prompt.durText(it.duration) + ' ' + AI.prompt.modeText(it.mode)) +
        (it.builtin ? ' · 内置' : ' · 自定义') + '</span>' +
        '</div>' +
        '<div class="wNote"><input type="text" data-nid="' + esc(it.id) + '" maxlength="60"' +
        ' placeholder="' + esc(it.notes && !/^(由编辑器新建|由 csv 转换而来)$/i.test(it.notes.trim()) ? it.notes : 'AI 说明（留空则用自动信息）') + '"' +
        ' value="' + esc(notes[it.id] || '') + '"></div>' +
        '</div>');
    }
    box.innerHTML = html.join('') || '<div class="sideHint">没有读到任何波形</div>';
    $('waveCount').textContent = nOn + ' / ' + all.length;

    box.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.onchange = function () {
        var id = cb.getAttribute('data-wid'), c = AI.settings.get();
        var arr = (c.waves.disabled || []).slice();
        var idx = arr.indexOf(id);
        if (cb.checked) { if (idx >= 0) arr.splice(idx, 1); }
        else if (idx < 0) arr.push(id);
        AI.settings.set('waves.disabled', arr);
        AI.chat.applyWhitelist();
        cb.parentNode.parentNode.className = 'waveItem' + (cb.checked ? '' : ' off');
        renderWaveList();
        toast(cb.checked ? '已允许 AI 使用这个波形' : 'AI 将看不到也用不了这个波形');
      };
    });
    box.querySelectorAll('input[type=text]').forEach(function (inp) {
      inp.onchange = function () {
        var id = inp.getAttribute('data-nid'), c = AI.settings.get();
        var m = {};
        for (var k in (c.waves.notes || {})) if (Object.prototype.hasOwnProperty.call(c.waves.notes, k)) m[k] = c.waves.notes[k];
        if (inp.value.trim()) m[id] = inp.value.trim(); else delete m[id];
        AI.settings.set('waves.notes', m);
        toast('已记录 AI 说明（下一轮生效）');
      };
    });
  }

  function reloadWaves() {
    return AI.prompt.loadWaves().then(function (s) {
      AI.chat.applyWhitelist();
      fillWaveSelect();
      renderWaveList();
      toast('波形已刷新：共 ' + s.total + ' 个（内置 ' + s.builtin + ' / 自定义 ' + s.custom + '），AI 可用 ' + s.enabled + ' 个');
      renderStatus();
      return s;
    });
  }

  // ============================================================
  // 急停 / 恢复
  // ============================================================
  var STOP_WINDOW_MS = 800;
  var stopArm = { armed: false, timer: null };

  function clearStopArm() {
    stopArm.armed = false;
    if (stopArm.timer) { clearTimeout(stopArm.timer); stopArm.timer = null; }
    var b = $('btnStop');
    if (b) b.classList.remove('confirm', 'armed');
  }

  function emergencyStop(silent) {
    cancelTest();
    var eng = WC.engine;
    if (eng) {
      eng.stop('emergency');                       // 内部会发 0,0
      if (WC.scope && WC.scope.stopLoop) { try { WC.scope.stopLoop(); } catch (e) { } }
    }
    AI.chat.state.latched = true;                  // 应用层闩锁（权威）
    if (!silent) {
      AI.chat.pushSys('⛔ 已急停并归零。从现在起 AI 的控制会被拒绝，直到你点底部的「恢复 AI 控制」。');
      toast('已急停并归零', 'warn');
    }
    renderStatus();
  }

  function resumeAi() {
    AI.chat.state.latched = false;
    var eng = WC.engine;
    // 清掉引擎内部的 latched：start() 会清，但立刻 stop 掉，保证不留输出
    try { eng.start(); eng.stop('user'); } catch (e) { }
    AI.chat.pushSys('✅ 已恢复：AI 可以重新控制输出。（输出保持关闭，等 AI 或你手动开启。）');
    toast('已恢复 AI 控制');
    renderStatus();
  }

  function requestStop() {
    if (AI.chat.isLatched()) {
      ask('恢复 AI 控制？',
        '恢复后 AI 可以重新开启输出。<br>注意：<b>不会自动重放上一轮的控制</b>，输出保持关闭。',
        function () { resumeAi(); }, '确认恢复');
      return;
    }
    var eng = WC.engine;
    if (!eng || !eng.isRunning()) { emergencyStop(); return; }
    if (stopArm.armed) { clearStopArm(); emergencyStop(); return; }
    stopArm.armed = true;
    var b = $('btnStop');
    if (b) { b.classList.add('confirm'); b.classList.add('armed'); }
    toast('⚠ 防误触：请在 0.8 秒内再点一次「急停」才会立即归零', 'warn');
    stopArm.timer = setTimeout(clearStopArm, STOP_WINDOW_MS);
  }

  // ============================================================
  // 设置弹窗
  // ============================================================
  function openCfg() {
    cfgToForm();
    $('cfgTestOut').textContent = '';
    $('cfgTestOut').className = 'testOut';
    $('cfgModal').classList.add('open');
  }
  function closeCfg() { $('cfgModal').classList.remove('open'); }

  function cfgToForm() {
    var a = AI.settings.get().api;
    $('fBaseUrl').value = a.baseUrl || '';
    $('fPath').value = a.path || '';
    $('fApiKey').value = a.apiKey || '';
    $('fModel').value = a.model || '';
    $('fAuthHeader').value = a.authHeader || '';
    $('fAuthScheme').value = a.authScheme || '';
    $('fTemp').value = (a.params && a.params.temperature !== null && a.params.temperature !== undefined) ? a.params.temperature : '';
    $('fMaxTok').value = (a.params && a.params.maxTokens !== null && a.params.maxTokens !== undefined) ? a.params.maxTokens : '';
    $('fTopP').value = (a.params && a.params.topP !== null && a.params.topP !== undefined) ? a.params.topP : '';
    $('fTimeout').value = a.timeoutMs || '';
    $('fStream').checked = !!a.stream;
    $('fHeaders').value = JSON.stringify(a.headers || {}, null, 0) === '{}' ? '' : JSON.stringify(a.headers, null, 2);
    $('fQuery').value = JSON.stringify(a.query || {}, null, 0) === '{}' ? '' : JSON.stringify(a.query, null, 2);
    $('fBodyExtra').value = JSON.stringify(a.bodyExtra || {}, null, 0) === '{}' ? '' : JSON.stringify(a.bodyExtra, null, 2);
    $('fRespPath').value = a.responsePath || '';
    $('fDeltaPath').value = a.streamDeltaPath || '';
    var s = AI.settings.get();
    $('fMax').value = s.safety.userMaxPct;
    $('fMaxVal').textContent = s.safety.userMaxPct + '%';
    $('fAiCtl').checked = !!s.safety.aiControlEnabled;
    $('fKeepRun').checked = !!s.safety.keepRunningWhileWaiting;
    $('fHistory').value = s.ui.historyLimit;
    $('fShowDebug').checked = !!s.ui.showDebug;
    $('fApiKey').type = 'password';
    $('fShowKey').checked = false;
  }

  function parseJsonField(id, label) {
    var v = ($(id).value || '').trim();
    if (!v) return {};
    try {
      var o = JSON.parse(v);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('必须是 JSON 对象');
      return o;
    } catch (e) {
      throw new Error(label + ' 不是合法的 JSON 对象：' + (e && e.message || e));
    }
  }

  // 表单 → 配置对象（不落盘；测试连接也用它）
  function formToCfg() {
    var cfg = JSON.parse(JSON.stringify(AI.settings.get()));
    var a = cfg.api;
    a.baseUrl = ($('fBaseUrl').value || '').trim();
    a.path = ($('fPath').value || '').trim();
    a.apiKey = $('fApiKey').value || '';
    a.model = ($('fModel').value || '').trim();
    a.authHeader = ($('fAuthHeader').value || '').trim();
    a.authScheme = ($('fAuthScheme').value || '').trim();
    a.timeoutMs = clamp(parseInt10($('fTimeout').value, 60000), 3000, 600000);
    a.stream = !!$('fStream').checked;
    a.headers = parseJsonField('fHeaders', '追加请求头');
    a.query = parseJsonField('fQuery', '追加 URL 参数');
    a.bodyExtra = parseJsonField('fBodyExtra', '追加请求体字段');
    a.responsePath = ($('fRespPath').value || '').trim() || 'choices.0.message.content';
    a.streamDeltaPath = ($('fDeltaPath').value || '').trim() || 'choices.0.delta.content';
    a.params = {};
    var t = ($('fTemp').value || '').trim(), mt = ($('fMaxTok').value || '').trim(), tp = ($('fTopP').value || '').trim();
    if (t !== '') a.params.temperature = parseFloat(t);
    if (mt !== '') a.params.maxTokens = parseInt10(mt, 800);
    else a.params.maxTokens = null;
    if (tp !== '') a.params.topP = parseFloat(tp); else a.params.topP = null;
    cfg.safety.userMaxPct = clamp(parseInt10($('fMax').value, 50), 0, 100);
    cfg.safety.aiControlEnabled = !!$('fAiCtl').checked;
    cfg.safety.keepRunningWhileWaiting = !!$('fKeepRun').checked;
    cfg.ui.historyLimit = clamp(parseInt10($('fHistory').value, 20), 1, 100);
    cfg.ui.showDebug = !!$('fShowDebug').checked;
    return cfg;
  }

  function saveCfg() {
    var cfg;
    try { cfg = formToCfg(); }
    catch (e) { toast(e.message, 'warn'); return; }
    var cur = AI.settings.get();
    // 逐字段写回（保留 waves 等不在表单里的部分）
    cur.api = cfg.api; cur.safety = cfg.safety; cur.ui = cfg.ui;
    AI.settings.save();
    AI.chat.applySettings();
    syncMaxUi();
    closeCfg();
    toast('配置已保存');
    renderStatus();
  }

  function testCfg() {
    if (M.testing) return;
    var cfg;
    try { cfg = formToCfg(); }
    catch (e) { toast(e.message, 'warn'); return; }
    if (!cfg.api.baseUrl || !cfg.api.model) { toast('先填「接口地址」和「模型」', 'warn'); return; }
    M.testing = true;
    var out = $('cfgTestOut');
    out.className = 'testOut';
    out.textContent = '正在测试…';
    AI.llm.testConnection(cfg).then(function (r) {
      M.testing = false;
      if (r.ok) {
        out.className = 'testOut ok';
        out.innerHTML = '✅ 接口可用 · ' + r.ms + 'ms ｜ 模型回了：<b>' + esc(String(r.text).slice(0, 40)) + '</b>' +
          (r.usage ? (' ｜ ' + esc(JSON.stringify(r.usage))) : '');
      } else {
        out.className = 'testOut bad';
        out.innerHTML = '❌ ' + esc(AI.llm.KINDS[r.kind] || r.text) +
          (r.status ? ' <span class="kv">（HTTP ' + r.status + '）</span>' : '') +
          (r.raw ? '<br><span class="kv">服务端原文：' + esc(String(r.raw).slice(0, 200)) + '</span>' : '');
      }
    });
  }

  // ============================================================
  // 角色弹窗
  // ============================================================
  var roleEditId = null;

  function openRole() {
    $('roleModal').classList.add('open');
    renderRoleList().then(function () { editRole(AI.roles.currentId()); });
  }
  function closeRole() { $('roleModal').classList.remove('open'); }

  function renderRoleList() {
    return AI.roles.listAll().then(function (list) {
      var cur = AI.roles.currentId(), i, r, html = [], group = '';
      for (i = 0; i < list.length; i++) {
        r = list[i];
        var g = r.builtin ? '内置角色（只读）' : '我的角色';
        if (g !== group) { group = g; html.push('<div class="roleGroup">' + g + '</div>'); }
        html.push('<div class="roleItem' + (r.id === cur ? ' on' : '') + '" data-rid="' + esc(r.id) + '">' +
          '<span>' + esc(r.emoji || '🙂') + '</span><span>' + esc(r.name) + '</span>' +
          (r.id === cur ? '<span class="tag">使用中</span>' : '') + '</div>');
      }
      var box = $('roleList');
      box.innerHTML = html.join('');
      box.querySelectorAll('.roleItem').forEach(function (el) {
        el.onclick = function () { editRole(el.getAttribute('data-rid')); };
      });
    });
  }

  function editRole(id) {
    roleEditId = id;
    AI.roles.get(id).then(function (r) {
      if (!r) { toast('这个角色读不出来', 'warn'); return; }
      $('rName').value = r.name || '';
      $('rEmoji').value = r.emoji || '';
      $('rBackground').value = r.background || '';
      $('rAiRole').value = r.aiRole || '';
      $('rUserRole').value = r.userRole || '';
      $('rExtra').value = r.extra || '';
      $('rWaveHint').value = (r.waveHint || []).join('、');
      $('rDel').disabled = !!r.builtin;
      $('rSave').disabled = !!r.builtin;
      $('rState').innerHTML = r.builtin
        ? '这是<b>内置角色</b>，不能直接修改或删除。想改就点「📄 另存副本」，然后在副本上编辑。'
        : '这是<b>你自己的角色</b>，可以随意修改。当前角色：' + esc(AI.roles.currentId() === r.id ? '是' : '不是');
      renderRoleList();
    });
  }

  function formToRole() {
    return {
      id: roleEditId,
      name: ($('rName').value || '').trim(),
      emoji: ($('rEmoji').value || '').trim() || '🙂',
      background: $('rBackground').value,
      aiRole: $('rAiRole').value,
      userRole: $('rUserRole').value,
      extra: $('rExtra').value,
      waveHint: ($('rWaveHint').value || '').split(/[、,，]/).map(function (s) { return s.trim(); }).filter(Boolean)
    };
  }

  function saveRole() {
    var r = formToRole();
    if (!r.name) { toast('角色需要一个名称', 'warn'); return; }
    AI.roles.save(r).then(function (saved) {
      roleEditId = saved.id;
      toast('角色已保存');
      return renderRoleList();
    }).catch(function (e) { toast(e.message, 'warn'); });
  }

  function dupRole() {
    var r = formToRole();
    var src = roleEditId;
    // 先按当前表单内容复制（内置角色改了文案也能带走）
    AI.roles.save({
      name: (r.name || '角色') + ' 副本', emoji: r.emoji, background: r.background,
      aiRole: r.aiRole, userRole: r.userRole, extra: r.extra, waveHint: r.waveHint
    }).then(function (saved) {
      toast('已另存为副本');
      roleEditId = saved.id;
      return renderRoleList();
    }).then(function () { editRole(roleEditId); })
      .catch(function (e) { toast(e.message, 'warn'); });
  }

  function useRole() {
    if (!roleEditId) return;
    AI.roles.setCurrent(roleEditId);
    AI.chat.state.roleId = roleEditId;
    toast('已切换角色（下一轮生效；对话历史保持不动）');
    renderRoleList().then(refreshRoleName);
  }

  function delRole() {
    if (!roleEditId) return;
    AI.roles.get(roleEditId).then(function (r) {
      if (!r) return;
      if (r.builtin) { toast('内置角色不能删除', 'warn'); return; }
      ask('删除角色？', '「' + esc(r.name) + '」将被永久删除，无法撤销。', function () {
        AI.roles.remove(roleEditId).then(function () {
          toast('已删除');
          roleEditId = null;
          return renderRoleList();
        }).then(function () { editRole(AI.roles.currentId()); })
          .catch(function (e) { toast(e.message, 'warn'); });
      }, '删除');
    });
  }

  // ============================================================
  // 调试面板
  // ============================================================
  function openDbg(open) {
    var p = $('debugPanel');
    p.classList.toggle('open', open);
    p.setAttribute('aria-hidden', open ? 'false' : 'true');
    $('btnDebug').classList.toggle('active', open);
    if (open) { renderDbgSummary(); renderDbgLog(); }
  }

  function renderDbgSummary() {
    var el = $('dbgSummary');
    if (!el || !$('debugPanel').classList.contains('open')) return;
    var s = AI.prompt.summary(), st = AI.chat.state, eng = WC.engine;
    var h = [];
    h.push('波形：共 <b>' + s.total + '</b>（内置 ' + s.builtin + ' / 自定义 ' + s.custom + '），AI 可用 <b>' + s.enabled + '</b>');
    if (s.errors.length) h.push('<span class="bad">波形读取问题：' + esc(s.errors.join(' / ')) + '</span>');
    h.push('引擎 ' + (eng && eng.isRunning() ? '<span class="ok">运行中</span>' : '未运行') +
      '，输出 ' + (eng ? esc(JSON.stringify(eng.out())) : '-') + '，强度 ' +
      (eng ? (eng.ch.A.intensity + ' / ' + eng.ch.B.intensity) : '-'));
    h.push('蓝牙 ' + (AI.chat.bleReady() ? '<span class="ok">已连接</span>' : '未连接') +
      '｜AI 控制 ' + (st.aiControlEnabled ? '<span class="ok">开</span>' : '关') +
      '｜上限 <b>' + st.userMaxPct + '%</b>' +
      '｜急停 ' + (AI.chat.isLatched() ? '<span class="bad">已锁定</span>' : '未触发'));
    h.push('轮次 <b>' + st.turnNo + '</b>｜消息 ' + st.messages.length + ' 条｜左右' + (st.flip ? '已交换' : '正常'));
    if (st.lastError) h.push('<span class="bad">最近一次接口错误：' + esc(st.lastError.kind) + ' · ' + esc(st.lastError.text) + '</span>');
    if (demoMode) h.push('<span class="ok">演示模式（?demo=1）：AI 由内置脚本扮演，走的是同一条链路</span>');
    el.innerHTML = h.join('<br>');
  }

  function renderDbgLog() {
    var box = $('dbgLog');
    if (!box || !$('debugPanel').classList.contains('open')) return;
    var logs = AI.chat.log(), html = '', i, e, st, cls;
    for (i = logs.length - 1; i >= 0; i--) {
      e = logs[i];
      st = (e.payload && e.payload.gate) ? e.payload.gate.status : '';
      cls = st === 'applied' ? 'ok' : (st === 'rejected' ? 'bad' : '');
      html += '<div class="dbgItem"><div class="dh">' + esc(e.title) +
        ' <span class="' + cls + '">[' + esc(st || e.kind) + ']</span></div>' +
        '<pre>' + esc(JSON.stringify(e.payload, null, 2)) + '</pre></div>';
    }
    box.innerHTML = html || '<div style="color:#666">还没有日志</div>';
  }

  function showLastPrompt() {
    var role = null;
    AI.roles.current().then(function (r) {
      role = r;
      var sys = AI.prompt.buildSystem(role, AI.chat.l3info());
      M.lastPrompt = sys;
      info('本轮 system 提示词（只读）',
        '<div style="max-height:56dvh;overflow:auto;background:#101828;border:1px solid #0f3460;border-radius:6px;padding:10px">' +
        '<pre style="margin:0;white-space:pre-wrap;font-size:11.5px;line-height:1.7;color:#cfcfe6">' + esc(sys) + '</pre></div>' +
        '<div class="sideHint">L1 = 系统契约（不可改）｜L2 = 角色卡｜L3 = 本轮实时状态（不含上限与实际输出）</div>');
    });
  }

  function runScript() {
    var n = AI.chat.script().length, i;
    AI.chat.demoReset();
    if (demoMode) {
      // 演示模式下走"真实链路"（逐段吐字 + 流式隐藏），一条一条串起来
      var chain = Promise.resolve();
      for (i = 0; i < n; i++) {
        chain = chain.then(function () { return AI.chat.demoSend('（演示）第 ' + AI.chat.demoIndex() + ' 句用户发言'); });
      }
      chain.then(function () { toast('已跑完 ' + n + ' 条内置假 AI 回复'); });
      return;
    }
    for (i = 0; i < n; i++) {
      AI.chat.pushUser('（演示）第 ' + (i + 1) + ' 句用户发言');
      AI.chat.demoNext();
    }
    toast('已跑完 ' + n + ' 条内置假 AI 回复');
  }

  // ============================================================
  // 发送
  // ============================================================
  function sendFromComposer() {
    var inp = $('chatInput');
    var text = (inp.value || '').trim();
    if (!text) { toast('先写点什么', 'warn'); return; }
    if (AI.chat.state.streaming) { toast('还在生成中…', 'warn'); return; }
    var c = AI.settings.get();
    if (!demoMode && (!String(c.api.baseUrl || '').trim() || !String(c.api.model || '').trim())) {
      toast('还没有配置接口：先填「⚙ 设置」并测试连接', 'warn');
      openCfg();
      return;
    }
    inp.value = '';
    var p = demoMode ? AI.chat.demoSend(text) : AI.chat.send(text);
    Promise.resolve(p).catch(function (e) { console.error('[AI] 发送失败', e); });
  }

  // ============================================================
  // 初始化
  // ============================================================
  function syncMaxUi() {
    var m = userMaxPct();
    $('rngMax').value = m;
    $('maxVal').textContent = m + '%';
    $('fMax').value = m;
    $('fMaxVal').textContent = m + '%';
    $('intVal').textContent = Math.min(M.manualInt, m) + '%';
    $('rngInt').value = M.manualInt;
  }

  function init() {
    // ---- 存储与配置 ----
    if (!AI.settings.init()) toast('本地存储不可用：配置与角色无法保存', 'warn');
    AI.rolestore.init();
    AI.settings.load();
    AI.chat.applySettings();

    // ---- 左右交换：与 ScriptPlayer 一样在"发送那一刻"交换 ----
    var origSend = WC.ble.send;
    WC.ble.send = function (a, b) {
      if (AI.chat.state.flip) return origSend.call(WC.ble, b, a);
      return origSend.call(WC.ble, a, b);
    };

    // ---- 示波器 ----
    try {
      if (WC.scope && WC.scope.attach) {
        WC.scope.attach('A', $('scope-A'));
        WC.scope.attach('B', $('scope-B'));
        WC.scope.resize();
      }
    } catch (e) { }

    // ---- 蓝牙 ----
    $('btnBle').onclick = function () {
      if (WC.ble.connected) { toast('已经连接了'); return; }
      toast('请在系统弹窗里选择 UFO-TW 设备');
      Promise.resolve(WC.ble.connect()).then(function () { renderStatus(); });
    };
    $('btnBleDisc').onclick = function () {
      if (WC.engine && WC.engine.isRunning()) { WC.engine.stop('user'); }
      try { WC.ble.disconnect(); } catch (e) { }
      toast('已断开蓝牙（输出已归零）', 'warn');
      renderStatus();
    };
    $('btnBleRe').onclick = function () {
      // ble.js 是逐字节复制的，没有对外暴露 device，也没有"免选择框直连"的接口。
      // 所以「重连」走的就是同一条连接流程（会弹出系统设备选择框）——与 ScriptPlayer 完全一致。
      if (WC.ble.connected) { toast('已经连接了'); return; }
      toast('重新连接：请在系统弹窗里再选一次 UFO-TW');
      Promise.resolve(WC.ble.connect()).then(function () { renderStatus(); });
    };
    WC.ble.onState = function (on, detail) {
      var el = $('bleLabel');
      el.textContent = on ? '已连接' : '未连接';
      el.className = 'badge ' + (on ? 'on' : 'off');
      if (detail) toast(detail, on ? 'info' : 'warn');
      if (!on) {
        // 断线 → 安全停机
        if (WC.engine && WC.engine.isRunning()) {
          WC.engine.stop('failsafe');
          AI.chat.pushSys('⚠ 蓝牙已断开，输出已停止。重连后需要重新确认。');
        }
      }
      renderStatus();
    };
    WC.engine.onStop = function (reason) {
      cancelTest();
      if (reason === 'emergency') renderStatus();
    };

    // ---- 急停 ----
    $('btnStop').onclick = requestStop;
    $('askOk').onclick = function () { var cb = M.askCb; askClose(); if (cb) cb(); };
    $('askCancel').onclick = askClose;
    $('askModal').onclick = function (e) { if (e.target === this) askClose(); };
    $('infoOk').onclick = infoClose;
    $('infoModal').onclick = function (e) { if (e.target === this) infoClose(); };

    // ---- AI 控制总开关 ----
    $('chkAiControl').onchange = function () {
      AI.settings.set('safety.aiControlEnabled', !!this.checked);
      AI.chat.state.aiControlEnabled = !!this.checked;
      toast(this.checked ? 'AI 控制已开启' : 'AI 控制已关闭（AI 仍可聊天，但控制不会执行）',
        this.checked ? 'info' : 'warn');
      renderStatus();
    };

    // ---- 面板开合 ----
    $('btnSide').onclick = function () {
      var s = $('side');
      var open = !s.classList.contains('open');
      s.classList.toggle('open', open);
      s.setAttribute('aria-hidden', open ? 'false' : 'true');
      $('btnSide').classList.toggle('active', open);
      AI.settings.set('ui.sideOpen', open);
      if (open && WC.scope) setTimeout(function () { try { WC.scope.resize(); WC.scope.renderOnce(); } catch (e) { } }, 30);
    };
    $('sideClose').onclick = function () { $('btnSide').click(); };
    $('btnDebug').onclick = function () { openDbg(!$('debugPanel').classList.contains('open')); };
    $('dbgClose').onclick = function () { openDbg(false); };
    $('dbgBtnClear').onclick = function () { AI.chat.clearLog(); renderDbgLog(); };
    $('dbgBtnScenario').onclick = runScript;
    $('dbgBtnPrompt').onclick = showLastPrompt;

    // ---- 手动控制 ----
    $('selWave').onchange = updateWaveNote;
    $('btnWaveRefresh').onclick = function () { reloadWaves(); };
    $('btnReloadWaves').onclick = function () { reloadWaves(); };
    $('rngMax').oninput = function () {
      var m = clamp(parseInt10(this.value, 50), 0, 100);
      AI.settings.set('safety.userMaxPct', m);
      AI.chat.applySettings();
      $('maxVal').textContent = m + '%';
      $('fMax').value = m;
      $('fMaxVal').textContent = m + '%';
      $('intVal').textContent = Math.min(M.manualInt, m) + '%';
    };
    $('rngInt').oninput = function () {
      M.manualInt = clamp(parseInt10(this.value, 100), 0, 100);
      this.value = M.manualInt;
      $('intVal').textContent = Math.min(M.manualInt, userMaxPct()) + '%';
      if ($('chkOut').checked) manualOut(true);      // 输出中改强度要立刻生效
    };
    $('chkOut').onchange = function () { manualOut(!!this.checked); };
    $('btnTest').onclick = testPulse;
    $('btnFlip').onclick = function () {
      AI.chat.state.flip = !AI.chat.state.flip;
      this.classList.toggle('on', AI.chat.state.flip);
      toast(AI.chat.state.flip ? '已交换左右电机' : '已恢复左右');
      renderStatus();
    };
    $('btnExport').onclick = $('btnExport2').onclick = function () {
      AI.chat.downloadSession();
      toast('对话已导出为 Markdown');
    };
    $('btnClear').onclick = $('btnClear2').onclick = function () {
      ask('清空对话？', '所有消息记录将被清除（角色与配置不受影响）。', function () {
        AI.chat.clearSession();
        toast('对话已清空');
      }, '清空');
    };

    // ---- 设置 ----
    $('btnSettings').onclick = openCfg;
    $('cfgClose').onclick = $('cfgClose2').onclick = closeCfg;
    $('cfgModal').onclick = function (e) { if (e.target === this) closeCfg(); };
    $('cfgSave').onclick = saveCfg;
    $('cfgTest').onclick = testCfg;
    $('fShowKey').onchange = function () { $('fApiKey').type = this.checked ? 'text' : 'password'; };
    $('fMax').oninput = function () {
      $('fMaxVal').textContent = this.value + '%';
      $('rngMax').value = this.value;
      $('maxVal').textContent = this.value + '%';
      $('intVal').textContent = Math.min(M.manualInt, parseInt10(this.value, 50)) + '%';
    };
    $('btnEmergencyFromCfg').onclick = function () { closeCfg(); emergencyStop(); };
    $('btnResetCfg').onclick = function () {
      ask('恢复默认配置？', '接口地址、密钥、模型、安全设置都会回到默认值（角色与波形不动）。', function () {
        AI.settings.reset();
        AI.settings.load();
        AI.chat.applySettings();
        cfgToForm();
        syncMaxUi();
        renderStatus();
        toast('配置已恢复默认');
      }, '恢复默认');
    };
    document.querySelectorAll('.mTab').forEach(function (t) {
      t.onclick = function () {
        var tab = t.getAttribute('data-tab');
        document.querySelectorAll('.mTab').forEach(function (x) { x.classList.toggle('on', x === t); });
        document.querySelectorAll('.mPane').forEach(function (p) { p.classList.toggle('on', p.getAttribute('data-pane') === tab); });
      };
    });

    // ---- 角色 ----
    $('btnRole').onclick = openRole;
    $('roleClose').onclick = closeRole;
    $('roleModal').onclick = function (e) { if (e.target === this) closeRole(); };
    $('rSave').onclick = saveRole;
    $('rDup').onclick = dupRole;
    $('rUse').onclick = useRole;
    $('rDel').onclick = delRole;

    // ---- 对话 ----
    $('btnSend').onclick = sendFromComposer;
    $('btnStopGen').onclick = function () { if (AI.chat.stop()) toast('已请求停止', 'warn'); };
    $('chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendFromComposer(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      clearStopArm();
      closeCfg(); closeRole(); infoClose();
      if ($('askModal').classList.contains('open')) askClose();
      if ($('side').classList.contains('open')) $('btnSide').click();
      openDbg(false);
    });
    window.addEventListener('resize', function () {
      if (WC.scope) { try { WC.scope.resize(); WC.scope.renderOnce(); } catch (e) { } }
    });

    // ---- 会话事件 ----
    AI.chat.subscribe(function (ev) {
      if (ev.type === 'message') { renderMessages(); renderStatus(); }
      else if (ev.type === 'delta') { renderDraft(); }
      else if (ev.type === 'stream-start') { renderStatus(); }
      else if (ev.type === 'stream-end') { renderMessages(); renderStatus(); }
      else if (ev.type === 'reset') { renderMessages(); renderStatus(); }
      else if (ev.type === 'log') { renderDbgLog(); }
      else if (ev.type === 'error') { renderDbgSummary(); }
      else if (ev.type === 'turn-done') { setEditorHint(); }
    });

    // ---- 演示模式 ----
    if (demoMode) {
      $('chatInput').placeholder = '演示模式：随便说点什么，内置脚本会扮演 AI…';
      $('composerHint').innerHTML = '当前是 <b>演示模式（?demo=1）</b>：AI 由内置脚本扮演，' +
        '控制块解析、门禁、引擎、蓝牙都走真实链路。去掉地址栏的 <code>?demo=1</code> 即为正常模式。';
    } else if (!String(AI.settings.get().api.baseUrl || '').trim()) {
      $('composerHint').innerHTML = '还没配置接口：点右上角 <b>⚙ 设置</b> 填「接口地址 / 密钥 / 模型」，' +
        '点「测试连接」通过后就能聊天了。也可以先用 <code>?demo=1</code> 看演示。';
    }

    // ---- 启动 ----
    renderMessages();
    syncMaxUi();
    renderStatus();
    refreshRoleName();
    if (AI.settings.get().ui.sideOpen) $('btnSide').click();
    if (AI.settings.get().ui.showDebug) openDbg(true);

    AI.chat.pushSys('欢迎使用 AI 控制器。' +
      (demoMode ? '演示模式已开启：直接发消息即可。' : '先点「⚙ 设置」配置接口，再点「🔵 连接蓝牙」。'));

    reloadWaves().catch(function (e) { console.log('波形读取失败', e); });
    setInterval(renderStatus, 500);
  }

  function setEditorHint() { /* 占位：保留给后续阶段（例如自动滚动到分支） */ }

  AI.ui = {
    init: init,
    // 供内联 onclick 使用
    pickBranch: function (i) { AI.chat.pickBranch(i); },
    regenerate: function () { AI.chat.regenerate(); },
    showLastPrompt: showLastPrompt,
    // 供测试与外部调用
    renderMessages: renderMessages, renderStatus: renderStatus,
    fillWaveSelect: fillWaveSelect, renderWaveList: renderWaveList, reloadWaves: reloadWaves,
    manualOut: manualOut, testPulse: testPulse,
    emergencyStop: emergencyStop, resumeAi: resumeAi, requestStop: requestStop,
    openCfg: openCfg, closeCfg: closeCfg, openRole: openRole, closeRole: closeRole,
    openDbg: openDbg, toast: toast, info: info, ask: ask,
    syncMaxUi: syncMaxUi, formToCfg: formToCfg, cfgToForm: cfgToForm, saveCfg: saveCfg,
    sendFromComposer: sendFromComposer,
    M: M
  };

  function boot() {
    try { init(); } catch (e) {
      console.log('AI 控制器初始化失败：', e);
      try { toast('初始化失败：' + (e && e.message || e), 'warn'); } catch (e2) { }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
