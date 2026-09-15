// ============================================================
// store.js - 用户数据存储：每个波形一个键 + 一个索引键
//   ufo.wave.index.v1       { v:1, items:[元数据] }
//   ufo.wave.item.v1.<id>   单个波形 JSON
//   ufo.wave.settings.v1    界面设置
// 全部接口都是 async —— 将来换 IndexedDB 只改这个文件
// ============================================================
(function () {
  'use strict';
  var WC = window.WC = window.WC || {};

  var K_INDEX = 'ufo.wave.index.v1';
  var K_ITEM = 'ufo.wave.item.v1.';
  var K_SET = 'ufo.wave.settings.v1';
  var PROBE = 'ufo.wave.__probe';
  var SOFT_LIMIT = 3.5 * 1024 * 1024;   // 超过就提醒导出备份
  var HARD_LIMIT = 4.7 * 1024 * 1024;   // 超过就拒绝继续写入

  var ls = null, available = false, reason = '';

  function bytesOf(s) { return s ? s.length * 2 : 0; }   // UTF-16 粗估

  function init() {
    try {
      if (typeof window.localStorage === 'undefined' || window.localStorage === null) throw new Error('浏览器未提供 localStorage');
      window.localStorage.setItem(PROBE, '1');
      if (window.localStorage.getItem(PROBE) !== '1') throw new Error('写入后读取不一致');
      window.localStorage.removeItem(PROBE);
      ls = window.localStorage;
      available = true;
      reason = '';
    } catch (e) {
      ls = null; available = false;
      reason = '本地存储不可用（' + (e.message || e) + '）';
    }
    return available;
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
      console.log('索引损坏，已重置：', e);
      return { v: 1, items: [] };
    }
  }

  function writeIndex(idx) {
    if (!ls) throw new Error('本地存储不可用');
    ls.setItem(K_INDEX, JSON.stringify(idx));
  }

  function metaOf(w, size) {
    return {
      id: w.id, name: w.name, duration: w.duration, mode: w.mode, base: w.base,
      points: (w.channels.A || []).length + (w.channels.B || []).length,
      builtin: !!w.builtin, notes: w.notes || '', updatedAt: w.updatedAt || Date.now(),
      size: size || 0
    };
  }

  function usage() {
    var idx = readIndex(), i, total = bytesOf(JSON.stringify(idx));
    for (i = 0; i < idx.items.length; i++) total += (idx.items[i].size || 0);
    return { bytes: total, soft: SOFT_LIMIT, hard: HARD_LIMIT, ratio: total / HARD_LIMIT, count: idx.items.length };
  }

  WC.store = {
    keys: { INDEX: K_INDEX, ITEM: K_ITEM, SETTINGS: K_SET },
    get available() { return available; },
    get reason() { return reason; },
    init: init, usage: usage, bytesOf: bytesOf,

    list: async function () {
      return readIndex().items.slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'zh');
      });
    },

    get: async function (id) {
      if (!ls) return null;
      var raw = ls.getItem(K_ITEM + id);
      if (!raw) return null;
      try { return WC.format.normalize(JSON.parse(raw), { id: id }); }
      catch (e) { console.log('波形损坏：', id, e); return null; }
    },

    put: async function (wave) {
      if (!ls) throw new Error('本地存储不可用，无法保存（可先导出备份）');
      var text = JSON.stringify(wave);
      var size = bytesOf(text);
      var u = usage();
      if (u.bytes + size > HARD_LIMIT) {
        throw new Error('本地存储将超限（约 ' + Math.round((u.bytes + size) / 1024) + 'KB / 上限 ' + Math.round(HARD_LIMIT / 1024) + 'KB）：请先导出备份并删除部分波形');
      }
      ls.setItem(K_ITEM + wave.id, text);
      var idx = readIndex(), i, found = false;
      for (i = 0; i < idx.items.length; i++) {
        if (idx.items[i].id === wave.id) { idx.items[i] = metaOf(wave, size); found = true; break; }
      }
      if (!found) idx.items.push(metaOf(wave, size));
      writeIndex(idx);
      return { id: wave.id, size: size, softExceeded: (u.bytes + size) > SOFT_LIMIT };
    },

    remove: async function (id) {
      if (!ls) return false;
      ls.removeItem(K_ITEM + id);
      var idx = readIndex(), out = [];
      for (var i = 0; i < idx.items.length; i++) if (idx.items[i].id !== id) out.push(idx.items[i]);
      idx.items = out;
      writeIndex(idx);
      return true;
    },

    settings: async function () {
      if (!ls) return {};
      try { return JSON.parse(ls.getItem(K_SET) || '{}'); } catch (e) { return {}; }
    },

    saveSettings: async function (obj) {
      if (!ls) return false;
      try { ls.setItem(K_SET, JSON.stringify(obj || {})); return true; } catch (e) { return false; }
    },

    exportBundle: async function (ids) {
      var idx = readIndex(), out = [], i, w;
      for (i = 0; i < idx.items.length; i++) {
        if (ids && ids.length && ids.indexOf(idx.items[i].id) < 0) continue;
        w = await this.get(idx.items[i].id);
        if (w) out.push(w);
      }
      return WC.format.bundleOf(out);
    },

    // opts.onConflict: 'skip' | 'overwrite' | 'copy'
    importBundle: async function (bundle, opts) {
      opts = opts || {};
      var waves = (bundle && Array.isArray(bundle.waves)) ? bundle.waves : (Array.isArray(bundle) ? bundle : []);
      var idx = readIndex(), byName = {}, i;
      for (i = 0; i < idx.items.length; i++) byName[idx.items[i].name] = idx.items[i].id;
      var self = this;
      var res = { added: 0, overwritten: 0, copied: 0, skipped: 0, errors: [] };

      for (i = 0; i < waves.length; i++) {
        var w;
        try { w = WC.format.normalize(waves[i]); }
        catch (e) { res.errors.push('第 ' + (i + 1) + ' 个波形无效：' + e.message); continue; }
        var existingId = (w.id && idx.items.some(function (m) { return m.id === w.id; })) ? w.id : null;
        var sameNameId = byName[w.name] || null;
        if (existingId || sameNameId) {
          var how = opts.onConflict || 'copy';
          if (how === 'skip') { res.skipped++; continue; }
          if (how === 'overwrite') {
            w.id = existingId || sameNameId;
            try { await self.put(w); res.overwritten++; }
            catch (e) { res.errors.push(w.name + '：' + e.message); }
            continue;
          }
          w.id = WC.format.newId();
          w.name = (w.name + ' (副本)').slice(0, 40);
          res.copied++;
        }
        try { await self.put(w); byName[w.name] = w.id; res.added++; }
        catch (e) { res.errors.push(w.name + '：' + e.message); }
      }
      return res;
    }
  };

})();
