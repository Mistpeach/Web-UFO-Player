// ============================================================
// presets.js - 内置示例波形（只读，随站点发布，不写入用户存储）
// 数据格式：channels 内为 [t秒, v带符号] 断点数组，负值 = 反转，值域 -127..127
// 详见 js/format.js 与页面「说明」
// ============================================================
(function () {
  'use strict';

  // 用固定种子生成伪随机序列：每次加载完全一致（可复现、可测试）
  function jitter(lenSec, stepSec, seed) {
    var s = seed, out = [], i, t;
    for (i = 0; i * stepSec < lenSec; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      t = s / 0x7fffffff;
      out.push([+(i * stepSec).toFixed(3), Math.round((t * 2 - 1) * 110)]);
    }
    return out;
  }

  function mk(id, name, duration, mode, base, notes, A, B) {
    return {
      id: id, format: 'ufo-wave/1', name: name, loop: true, duration: duration,
      mode: mode, base: base, notes: notes, builtin: true,
      channels: { A: A, B: B || A }
    };
  }

  window.UFO_WAVE_PRESETS = [
    mk('preset-constant', '恒定 100', 0.5, 'hold', 100,
      '单点满速，用作基线对照', [[0, 100]]),

    mk('preset-pulse', '方形脉冲', 1.0, 'hold', 110,
      '0.2s 全速 + 0.8s 停顿，演示脉冲与占空比', [[0, 110], [0.2, 0]]),

    mk('preset-heartbeat', '心跳（双跳）', 1.4, 'hold', 100,
      '双跳节律：强—弱—停，适合慢节奏', [[0, 100], [0.14, 0], [0.26, 72], [0.4, 0]]),

    mk('preset-ramp', '渐强渐弱（正反交替）', 2.0, 'linear', 100,
      '线性插值：正转到满速再反转，观察示波器上下半区', [[0, 0], [0.5, 100], [1.0, 0], [1.5, -100], [2.0, 0]]),

    mk('preset-alternate', '双通道交替', 1.0, 'hold', 100,
      'A 先动 B 后动，演示两通道独立', [[0, 100], [0.5, 0]], [[0, 0], [0.5, 100]]),

    mk('preset-jitter', '随机抖动 3s', 3.0, 'hold', 110,
      '每 0.12s 随机换向换速（固定种子，每次都一样）', jitter(3, 0.12, 20240915)),

    mk('preset-slow', '慢爬升 10s', 10.0, 'linear', 110,
      '10 秒长波形：缓慢爬升再回落，演示长周期循环', [[0, 15], [4, 60], [8, 110], [10, 15]])
  ];
})();
