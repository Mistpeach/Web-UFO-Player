// ============================================================
// we/util.js - 编辑器通用工具
// 只被编辑器使用；控制器侧（js/*）完全不知道它的存在
// ============================================================
(function () {
  'use strict';
  var WE = window.WE = window.WE || {};

  var U = {};

  // ---------- 调色板 ----------
  // 必须与 js/scope.js 顶部常量保持一致，保证"编辑器和控制台示波器同一视觉属性"。
  // 改配色时两处一起改。
  U.PAL = {
    POS: '#3ddc97',                        // 正转（上半区）
    NEG: '#e05fd8',                        // 反转（下半区）
    GRID: 'rgba(15,52,96,0.9)',
    AXIS: 'rgba(83,52,131,0.9)',
    TARGET: 'rgba(167,139,250,0.45)',
    HEAD: 'rgba(224,224,224,0.85)',
    WARN: 'rgba(255,120,120,0.9)',
    BG: '#0d1424',
    POS_BG: 'rgba(61,220,151,0.055)',
    NEG_BG: 'rgba(224,95,216,0.055)',
    TEXT: 'rgba(224,224,224,0.75)',
    DOT_A: '#3ddc97',
    DOT_B: '#e05fd8'
  };

  // ---------- 数学 ----------
  U.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.round3 = function (v) { return Math.round(v * 1000) / 1000; };
  U.isNum = function (v) { return typeof v === 'number' && isFinite(v); };

  U.fmtSec = function (s) {
    if (!isFinite(s)) return '—';
    var a = Math.abs(s);
    if (a >= 60) {
      var m = Math.floor(a / 60), r = a - m * 60;
      return (s < 0 ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
    }
    if (a >= 1) return s.toFixed(2);
    if (a >= 0.01) return s.toFixed(3);
    return s.toFixed(4);
  };
  U.fmtSecShort = function (s) { return U.fmtSec(s) + 's'; };

  // ---------- DOM ----------
  U.$ = function (id) { return document.getElementById(id); };

  U.setAttr = function (el, name, val) {
    if (el) el.setAttribute(name, String(val));
  };

  // 用 createElementNS 创建 SVG 元素（innerHTML 在 SVG 上不可靠）
  U.svg = function (tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) el.setAttribute(k, String(attrs[k]));
    return el;
  };
  U.clear = function (el) { while (el && el.firstChild) el.removeChild(el.firstChild); };

  // ---------- 提示 ----------
  var toastTimer = null;
  U.toast = function (msg, level) {
    var el = U.$('toast');
    if (!el) return;
    el.className = 'toast show ' + (level || 'info');
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, level === 'warn' ? 6000 : 3200);
  };

  // ---------- 杂项 ----------
  U.now = function () {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  };

  // 事件坐标 → canvasWrap 内的像素坐标（用 canvas 的 CSS 尺寸对应，不用 DPR）
  U.localPos = function (ev, el) {
    var r = el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  // 防抖
  U.debounce = function (fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  };

  WE.util = U;
})();
