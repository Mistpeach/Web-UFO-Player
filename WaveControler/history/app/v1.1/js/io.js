// ============================================================
// io.js - 导入 / 导出（单文件、多文件、文件夹、波形包 bundle）
// 重要：CSV 只是「交换格式」，本程序底层统一是 JSON —— 导入 CSV 必须给出转换提示
// ============================================================
(function () {
  'use strict';
  var WC = window.WC = window.WC || {};

  function safeName(s) {
    return String(s || 'wave').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'wave';
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  function isWaveFile(name) {
    return /\.(json|csv|txt|wave)$/i.test(name || '');
  }

  // 解析一批 File/文本 → 波形 + 提示
  async function parseFiles(items) {
    var out = { waves: [], warnings: [], errors: [], csvCount: 0, jsonCount: 0 };
    for (var i = 0; i < items.length; i++) {
      var name = items[i].name, text = items[i].text;
      try {
        var r = WC.format.parseText(text, { filename: name, name: name.replace(/\.[^.]+$/, '') });
        if (r.source === 'csv') out.csvCount++; else out.jsonCount++;
        for (var j = 0; j < r.waves.length; j++) {
          r.waves[j].notes = (r.waves[j].notes || '') + (r.waves[j].notes ? ' | ' : '') + '来自 ' + name;
          out.waves.push(r.waves[j]);
        }
        for (var k = 0; k < r.warnings.length; k++) {
          out.warnings.push({ level: r.warnings[k].level, file: name, text: r.warnings[k].text });
        }
      } catch (e) {
        out.errors.push(name + '：' + (e.message || e));
      }
    }
    return out;
  }

  // 把 File 列表读成 { name, text }
  async function readFiles(fileList) {
    var items = [], arr = Array.prototype.slice.call(fileList || []);
    for (var i = 0; i < arr.length; i++) {
      items.push({ name: arr[i].name, text: await arr[i].text() });
    }
    return items;
  }

  // 选文件夹（只读）→ 递归扫描波形文件
  async function pickFolderToImport() {
    if (!window.showDirectoryPicker) throw new Error('此浏览器不支持选择文件夹（请用 Chrome / Edge），可改为多选文件导入');
    var dir = await window.showDirectoryPicker({ mode: 'read' });
    var items = [];
    async function walk(handle, prefix) {
      for await (var entry of handle.entries()) {
        var n = entry[0], h = entry[1];
        if (h.kind === 'directory') { await walk(h, prefix + n + '/'); continue; }
        if (!isWaveFile(n)) continue;
        var f = await h.getFile();
        items.push({ name: prefix + n, text: await f.text() });
      }
    }
    await walk(dir, '');
    if (!items.length) throw new Error('该文件夹里没有找到 .json / .csv 波形文件');
    return items;
  }

  // 批量导出到用户选择的目录（每个波形一个文件 + README）
  async function writeToFolder(waves, asCsv) {
    if (!window.showDirectoryPicker) throw new Error('此浏览器不支持选择文件夹（请用 Chrome / Edge），可改用「下载波形包」');
    var dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    var written = 0;
    for (var i = 0; i < waves.length; i++) {
      var w = waves[i];
      var ext = asCsv ? '.csv' : '.json';
      var body = asCsv ? WC.format.toCSV(w) : JSON.stringify(w, null, 2);
      var fh = await dir.getFileHandle(safeName(w.name) + ext, { create: true });
      var stream = await fh.createWritable();
      await stream.write(body);
      await stream.close();
      written++;
    }
    var rf = await dir.getFileHandle('README.txt', { create: true });
    var rw = await rf.createWritable();
    await rw.write(readmeText(asCsv));
    await rw.close();
    return written;
  }

  function readmeText(asCsv) {
    return [
      'UFO Player 波形控制器 —— 波形文件说明',
      '=====================================',
      '',
      '本目录下的每个文件是一个波形（' + (asCsv ? 'CSV 交换格式' : 'JSON 格式 ufo-wave/1') + '）。',
      '',
      '【JSON 格式】',
      '{',
      '  "format": "ufo-wave/1",',
      '  "name": "波形名",',
      '  "duration": 1.4,              // 循环周期（秒）',
      '  "mode": "hold",               // hold=阶梯保持  linear=线性插值',
      '  "base": 100,                  // 原始速度基准（显示用）',
      '  "channels": {',
      '    "A": [[0,95],[0.18,0],[0.36,-60]],   // [时间(秒), 速度(-127..127，负=反转)]',
      '    "B": [[0,60],[0.7,-60]]',
      '  }',
      '}',
      '',
      '【CSV 交换格式】（导入时程序会自动转换成上面的 JSON）',
      '  列: 时间戳(0.1秒) 左方向(0正/1反) 左速度 右方向(0正/1反) 右速度',
      '  3 列也可: 时间戳 方向 速度   → A/B 使用同一波形',
      '  可选注释行: #name= #duration= #mode= #base= #unit=s 或 0.1s',
      '',
      '【注意】',
      '* 速度绝对值上限 127，超过会被夹取。',
      '* 循环：从最后一个断点保持到 duration，然后回绕到第一个断点；',
      '  若最后一个断点正好在 t=duration，它不会被实际播放。',
      '* 发送频率固定 20Hz（每 50ms 一包），有效波形频率上限约 10Hz。',
      ''
    ].join('\n');
  }

  WC.io = {
    download: download, safeName: safeName, readFiles: readFiles, parseFiles: parseFiles,
    pickFolderToImport: pickFolderToImport, writeToFolder: writeToFolder,
    readmeText: readmeText, isWaveFile: isWaveFile,
    exportOne: function (wave, asCsv) {
      if (asCsv) download(safeName(wave.name) + '.csv', WC.format.toCSV(wave), 'text/csv');
      else download(safeName(wave.name) + '.json', JSON.stringify(wave, null, 2), 'application/json');
    },
    exportBundle: function (bundle, filename) {
      download(filename || ('ufo-waves-' + new Date().toISOString().slice(0, 10) + '.json'),
        JSON.stringify(bundle, null, 2), 'application/json');
    }
  };
})();
