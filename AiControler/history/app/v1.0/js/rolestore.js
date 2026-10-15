// ============================================================
// rolestore.js - 角色卡存储
//   **与波形完全同一套方案**（见 WaveControler/js/store.js）：
//     ufo.ai.role.index.v1      { v:1, items:[元数据] }
//     ufo.ai.role.item.v1.<id>   单个角色卡的完整内容
//   内置角色不写进存储（在 roles-preset.js 里，只读）；
//   用户想改内置角色，走「另存副本」——和波形库一样的规矩。
//   接口全是 async，将来换 IndexedDB 只改这个文件。
// ============================================================
(function () {
  'use strict';
  var AI = window.AI = window.AI || {};

  var K_INDEX = 'ufo.ai.role.index.v1';
  var K_ITEM = 'ufo.ai.role.item.v1.';
  var PROBE = 'ufo.ai.role.__probe';
  var HARD_LIMIT = 512 * 1024;      // 角色卡是纯文本，给 512KB 已经很宽裕

  var ls = null, available = false, reason = '';

  function bytesOf(s) { return s ? s.length * 2 : 0; }   // UTF-16 粗估
  function isStr(v) { return typeof v === 'string'; }
  function newId() { return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6); }
  function clip(s, n) { return String(s === null || s === undefined ? '' : s).slice(0, n); }

  function init() {
    try {
      if (typeof window.localStorage === 'undefined' || window.localStorage === null) throw new Error('浏览器未提供 localStorage');
      window.localStorage.setItem(PROBE, '1');
      if (window.localStorage.getItem(PROBE) !== '1') throw new Error('写入后读取不一致');
      window.localStorage.removeItem(PROBE);
      ls = window.localStorage; available = true; reason = '';
    } catch (e) {
      ls = null; available = false;
      reason = '本地存储不可用（' + (e.message || e) + '）';
    }
    return available;
  }

  // 规整成合法角色卡（不改入参）
  function normalize(raw, opts) {
    opts = opts || {};
    if (!raw || typeof raw !== 'object') throw new Error('角色数据不是对象');
    var hints = raw.waveHint;
    if (!Array.isArray(hints)) hints = hints ? [hints] : [];
    var name = clip(raw.name, 40).trim();
    if (!name) throw new Error('角色需要一个名称');
    return {
      id: raw.id || opts.id || newId(),
      name: name,
      emoji: clip(raw.emoji || '🙂', 8),
      background: clip(raw.background, 4000),
      aiRole: clip(raw.aiRole, 4000),
      userRole: clip(raw.userRole, 4000),
      extra: clip(raw.extra, 6000),
      waveHint: hints.filter(isStr).map(function (s) { return clip(s, 40); }).slice(0, 12),
      builtin: false,                       // 用户存储里的一律不是内置
      createdAt: raw.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }

  function readIndex() {
    if (!ls) return { v: 1, items: [] };
    try {
      var raw = ls.getItem(K_INDEX);
      if (!raw) return { v: 1, items: [] };
      var o = JSON.parse(raw);
      if (!o || !Array.isArray(o.items)) return { v: 1, items: [] };
      return o;
    } catch (e) {
      console.log('角色索引损坏，已重置：', e);
      return { v: 1, items: [] };
    }
  }

  function writeIndex(idx) {
    if (!ls) throw new Error('本地存储不可用');
    ls.setItem(K_INDEX, JSON.stringify(idx));
  }

  function metaOf(r, size) {
    return {
      id: r.id, name: r.name, emoji: r.emoji, builtin: false,
      updatedAt: r.updatedAt || Date.now(), size: size || 0
    };
  }

  function usage() {
    var idx = readIndex(), i, total = bytesOf(JSON.stringify(idx));
    for (i = 0; i < idx.items.length; i++) total += (idx.items[i].size || 0);
    return { bytes: total, hard: HARD_LIMIT, count: idx.items.length };
  }

  AI.rolestore = {
    keys: { INDEX: K_INDEX, ITEM: K_ITEM },
    init: init,
    available: function () { return available; },
    reason: function () { return reason; },
    normalize: normalize,
    newId: newId,
    usage: usage,

    list: async function () {
      return readIndex().items.slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'zh');
      });
    },

    get: async function (id) {
      if (!ls) return null;
      var raw = ls.getItem(K_ITEM + id);
      if (!raw) return null;
      try { return normalize(JSON.parse(raw), { id: id }); }
      catch (e) { console.log('角色卡损坏，已跳过：', id, e); return null; }
    },

    put: async function (role) {
      if (!ls) throw new Error('本地存储不可用，无法保存角色');
      var r = normalize(role, { id: role.id });
      var text = JSON.stringify(r), size = bytesOf(text), u = usage();
      if (u.bytes + size > HARD_LIMIT) {
        throw new Error('本地存储将超限（' + Math.round((u.bytes + size) / 1024) + 'KB / 上限 ' + Math.round(HARD_LIMIT / 1024) + 'KB）');
      }
      ls.setItem(K_ITEM + r.id, text);
      var idx = readIndex(), i, found = false;
      for (i = 0; i < idx.items.length; i++) {
        if (idx.items[i].id === r.id) { idx.items[i] = metaOf(r, size); found = true; break; }
      }
      if (!found) idx.items.push(metaOf(r, size));
      writeIndex(idx);
      return r;
    },

    remove: async function (id) {
      if (!ls) return false;
      ls.removeItem(K_ITEM + id);
      var idx = readIndex(), out = [], i;
      for (i = 0; i < idx.items.length; i++) if (idx.items[i].id !== id) out.push(idx.items[i]);
      idx.items = out;
      writeIndex(idx);
      return true;
    },

    clear: async function () {
      if (!ls) return false;
      var idx = readIndex(), i;
      for (i = 0; i < idx.items.length; i++) ls.removeItem(K_ITEM + idx.items[i].id);
      writeIndex({ v: 1, items: [] });
      return true;
    }
  };

  // ============================================================
  // AI.roles - 角色库（内置 + 用户），与波形库同一套语义：
  //   内置只读、可以「另存副本」；用户卡可增删改查；当前角色记在配置里。
  // ============================================================
  function presets() {
    var arr = window.UFO_AI_ROLES || [], out = [], i, r;
    for (i = 0; i < arr.length; i++) {
      r = arr[i];
      out.push({
        id: r.id, name: r.name, emoji: r.emoji, builtin: true,
        background: r.background || '', aiRole: r.aiRole || '',
        userRole: r.userRole || '', extra: r.extra || '',
        waveHint: (r.waveHint || []).slice(), updatedAt: 0
      });
    }
    return out;
  }

  function fromPreset(id) {
    var p = presets(), i;
    for (i = 0; i < p.length; i++) if (p[i].id === id) return p[i];
    return null;
  }

  AI.roles = {
    presets: presets,
    fromPreset: fromPreset,

    // 列表：内置在前，用户卡在后（按名称排序）
    listAll: async function () {
      var out = presets(), mine = [];
      try { mine = await AI.rolestore.list(); } catch (e) { }
      for (var i = 0; i < mine.length; i++) {
        out.push({ id: mine[i].id, name: mine[i].name, emoji: mine[i].emoji || '🙂', builtin: false, updatedAt: mine[i].updatedAt });
      }
      return out;
    },

    // 取完整角色卡：内置优先（存的卡永远不能顶掉内置 id）
    get: async function (id) {
      var p = fromPreset(id);
      if (p) return p;
      try { return await AI.rolestore.get(id); } catch (e) { return null; }
    },

    // 当前角色 id（存在配置里）
    currentId: function () {
      var c = AI.settings.get();
      return (c.ui && c.ui.roleId) || 'role-gentle';
    },
    setCurrent: function (id) { AI.settings.set('ui.roleId', id); },

    current: async function () {
      var r = await this.get(this.currentId());
      if (r) return r;
      return fromPreset('role-gentle');       // 兜底：配置里的 id 失效了也不至于没有角色
    },

    // 保存用户卡（内置卡只能走 duplicate）
    save: async function (role) {
      if (role && role.builtin) throw new Error('内置角色不能直接修改，请用「另存副本」');
      return AI.rolestore.put(role);
    },

    remove: async function (id) {
      if (fromPreset(id)) throw new Error('内置角色不能删除');
      var cur = this.currentId();
      var r = await AI.rolestore.remove(id);
      if (cur === id) this.setCurrent('role-gentle');
      return r;
    },

    // 另存副本：内置 → 用户卡；用户卡 → 再来一份
    duplicate: async function (id, newName) {
      var src = await this.get(id);
      if (!src) throw new Error('找不到要复制的角色');
      var copy = {
        name: (newName || (src.name + ' 副本')).slice(0, 40),
        emoji: src.emoji, background: src.background, aiRole: src.aiRole,
        userRole: src.userRole, extra: src.extra, waveHint: (src.waveHint || []).slice()
      };
      return AI.rolestore.put(copy);           // put 会分配新 id，并强制 builtin=false
    }
  };
})();
