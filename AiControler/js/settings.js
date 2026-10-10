// ============================================================
// settings.js - 应用配置（API / 安全 / 界面 / 波形白名单）
//   一个键：ufo.ai.settings.v1
//   密钥存在浏览器本地（localStorage），**不上传任何地方**，只发给用户自己填的 baseUrl。
//   本模块只负责读写与合并默认值，不做网络请求。
// ============================================================
(function () {
  'use strict';
  var AI = window.AI = window.AI || {};

  var KEY = 'ufo.ai.settings.v1';
  var PROBE = 'ufo.ai.__probe';

  // 默认配置：新装即用（只有 baseUrl / model / apiKey 必须用户自己填）
  function defaults() {
    return {
      v: 1,
      api: {
        baseUrl: '',                       // 例：https://api.deepseek.com/v1
        path: '/chat/completions',
        apiKey: '',
        authHeader: 'Authorization',       // 可改成 api-key / x-api-key …
        authScheme: 'Bearer',              // 留空则只发 header，不加前缀
        model: '',
        headers: {},                       // 追加/覆盖请求头
        query: {},                         // 追加 URL 参数（如 Azure 的 api-version）
        bodyExtra: {},                     // 追加/覆盖请求体字段
        params: { temperature: 0.9, maxTokens: 800, topP: null },
        stream: true,
        timeoutMs: 60000,
        responsePath: 'choices.0.message.content',
        streamDeltaPath: 'choices.0.delta.content'
      },
      safety: {
        userMaxPct: 50,                    // 用户最大强度（0-100）；实际 = AI比率 × 这个值
        aiControlEnabled: true,
        keepRunningWhileWaiting: true      // 等 AI 期间保持当前动作
      },
      ui: {
        historyLimit: 20,                  // 送给模型的历史轮数上限
        showDebug: false,
        sideOpen: false,
        roleId: 'role-gentle'
      },
      waves: {
        disabled: [],                      // 不暴露给 AI 的波形 id（默认全开，新波形自动纳入）
        notes: {}                          // waveId → 「AI 说明」（不写进 WaveControler 的数据）
      }
    };
  }

  var ls = null, available = false, reason = '';
  var cache = null;

  function init() {
    try {
      if (typeof window.localStorage === 'undefined' || window.localStorage === null) throw new Error('浏览器未提供 localStorage');
      window.localStorage.setItem(PROBE, '1');
      if (window.localStorage.getItem(PROBE) !== '1') throw new Error('写入后读取不一致');
      window.localStorage.removeItem(PROBE);
      ls = window.localStorage; available = true; reason = '';
    } catch (e) {
      ls = null; available = false;
      reason = '本地存储不可用（' + (e.message || e) + '）：配置与角色都无法保存';
    }
    return available;
  }

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // 只做"浅层三段 + 深层一层"的合并：够用，且不会把用户填的值意外覆盖掉
  function merge(def, cur) {
    if (!isObj(cur)) return def;
    var out = {}, k;
    for (k in def) {
      if (!Object.prototype.hasOwnProperty.call(def, k)) continue;
      if (isObj(def[k])) out[k] = merge(def[k], cur[k]);
      else out[k] = (cur[k] === undefined) ? def[k] : cur[k];
    }
    // 允许用户加了默认里没有的键（例如 params 里自己塞了 frequency_penalty）
    for (k in cur) {
      if (!Object.prototype.hasOwnProperty.call(cur, k)) continue;
      if (out[k] === undefined) out[k] = cur[k];
    }
    return out;
  }

  function load() {
    var def = defaults();
    if (!ls) { cache = def; return cache; }
    try {
      var raw = ls.getItem(KEY);
      cache = raw ? merge(def, JSON.parse(raw)) : def;
    } catch (e) {
      console.log('配置损坏，已重置为默认值：', e);
      cache = def;
    }
    return cache;
  }

  function get() { return cache || load(); }

  function save() {
    if (!ls) return false;
    try { ls.setItem(KEY, JSON.stringify(get())); return true; }
    catch (e) { console.log('配置保存失败：', e); return false; }
  }

  // 点路径写入：set('api.stream', false)
  function set(path, value) {
    var cfg = get(), parts = String(path).split('.'), o = cfg, i;
    for (i = 0; i < parts.length - 1; i++) {
      if (!isObj(o[parts[i]])) o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
    save();
    return cfg;
  }

  function reset() { cache = defaults(); save(); return cache; }

  AI.settings = {
    KEY: KEY,
    defaults: defaults,
    init: init,
    available: function () { return available; },
    reason: function () { return reason; },
    load: load, get: get, save: save, set: set, reset: reset,
    merge: merge
  };
})();
