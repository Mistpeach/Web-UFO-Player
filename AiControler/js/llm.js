// ============================================================
// llm.js - OpenAI 兼容的对话接口客户端
//
//   只做一件事：把 messages 发给用户自己填的接口，把回复文本取回来。
//   兼容方式（不绑定任何一家）：
//     · 默认 OpenAI 形状：POST {baseUrl}{path}，Authorization: Bearer <key>，
//       body { model, messages, stream, ...params }
//     · 想接别家：改 authHeader / authScheme（如 api-key、x-api-key）、
//       加 query（如 Azure 的 ?api-version=）、加 bodyExtra、
//       用 responsePath / streamDeltaPath 指定从返回 JSON 的哪个位置取文本
//
//   ⚠ 密钥只在请求头里出现，绝不写进日志；调试面板显示的请求头会打码。
// ============================================================
(function () {
  'use strict';
  var AI = window.AI = window.AI || {};

  var KINDS = {
    network: '连不上接口：域名/DNS/网络不通，或浏览器把响应拦下了（跨域 CORS）。服务器需要允许本站域名访问。',
    auth: '密钥无效或没有权限（401/403）：检查 API 密钥与请求头名称。',
    notfound: '接口路径不存在（404）：检查「接口地址」与「路径」拼起来对不对。',
    rate: '被限流了（429）：稍等一会儿再试。',
    server: '服务端错误（5xx）：换个时间试，或换一个模型。',
    timeout: '超时：网络太慢，或者模型迟迟没有开始回复。',
    badjson: '返回内容不是合法 JSON：可能这个地址返回的是网页而不是接口。',
    empty: '返回里取不到文本：多半是模型名不对，或者「取值路径」与该服务的返回结构不匹配。',
    stream: '接口在流式返回的过程中报错了。',
    aborted: '已手动停止生成。',
    unknown: '未知错误。'
  };

  function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }

  function joinUrl(base, path) {
    var b = trim(base).replace(/\/+$/, '');
    var p = trim(path);
    if (p && p.charAt(0) !== '/') p = '/' + p;
    return b + p;
  }

  function withQuery(url, query) {
    if (!query) return url;
    var parts = [], k;
    for (k in query) {
      if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
      if (query[k] === null || query[k] === undefined || query[k] === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(query[k]));
    }
    if (!parts.length) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
  }

  // 点路径取值："choices.0.message.content"
  function getPath(obj, path) {
    if (!obj) return undefined;
    var parts = String(path || '').split('.'), o = obj, i, k, idx;
    for (i = 0; i < parts.length; i++) {
      k = trim(parts[i]);
      if (!k) continue;
      if (o === null || o === undefined) return undefined;
      if (Array.isArray(o)) {
        idx = parseInt(k, 10);
        o = isFinite(idx) ? o[idx] : undefined;
      } else if (typeof o === 'object') {
        o = o[k];
      } else return undefined;
    }
    return o;
  }

  function maskKey(s) {
    var t = String(s || '');
    if (!t) return '(空)';
    if (t.length <= 8) return '****';
    return t.slice(0, 4) + '****' + t.slice(-4);
  }

  // 界面/配置里用驼峰（对用户友好），但请求体必须用各家约定的下划线名。
  //   ⚠ 这里如果漏了映射，body 里就会发出 maxTokens 这种没人认识的字段 ——
  //   接口多半不报错、只是当没看见，症状是"能聊但 max_tokens/采样参数全部无效"，极难查。
  var PARAM_WIRE = { maxTokens: 'max_tokens', topP: 'top_p', topK: 'top_k', presencePenalty: 'presence_penalty', frequencyPenalty: 'frequency_penalty' };

  function buildRequest(cfg, messages, override) {
    override = override || {};
    var api = cfg.api || {};
    var stream = (override.stream === undefined) ? !!api.stream : !!override.stream;
    var url = withQuery(joinUrl(api.baseUrl, api.path), api.query);

    var headers = { 'Content-Type': 'application/json' };
    if (stream) headers['Accept'] = 'text/event-stream';
    var key = trim(api.apiKey), hname = trim(api.authHeader);
    if (key && hname) {
      headers[hname] = trim(api.authScheme) ? (trim(api.authScheme) + ' ' + key) : key;
    }
    for (var h in (api.headers || {})) {
      if (Object.prototype.hasOwnProperty.call(api.headers, h) && h) headers[h] = api.headers[h];
    }

    var body = { model: trim(api.model), messages: messages, stream: stream };
    var p = api.params || {}, k, wire;
    for (k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      if (p[k] === null || p[k] === undefined || p[k] === '') continue;
      wire = PARAM_WIRE[k] || k;
      body[wire] = p[k];
    }
    // bodyExtra 由用户直接写各家真实的字段名，优先级最高（可以覆盖上面的映射）
    for (k in (api.bodyExtra || {})) {
      if (Object.prototype.hasOwnProperty.call(api.bodyExtra, k) && k) body[k] = api.bodyExtra[k];
    }
    for (k in (override.body || {})) {
      if (Object.prototype.hasOwnProperty.call(override.body, k)) body[k] = override.body[k];
    }

    return { url: url, headers: headers, body: body, stream: stream };
  }

  // 调试用的安全副本（密钥打码）。
  //   两道保险：① 头名字像密钥的一律打码；② 头**值**里含真实密钥的一律打码
  //   （防止用户把密钥塞进一个名字看不出来的自定义头里，被调试面板原样打印出来）。
  function safeRequest(req, apiKey) {
    var h = {}, k, v, key = String(apiKey || '');
    for (k in req.headers) {
      if (!Object.prototype.hasOwnProperty.call(req.headers, k)) continue;
      v = req.headers[k];
      if (/key|authorization|token|secret|credential/i.test(k)) h[k] = maskKey(v);
      else if (key && String(v).indexOf(key) >= 0) h[k] = String(v).replace(key, maskKey(key));
      else h[k] = v;
    }
    return { url: req.url, method: 'POST', headers: h, body: req.body };
  }

  function classify(err, res, extra) {
    var kind = 'unknown', status = res ? res.status : 0;
    if (err && err.name === 'AbortError') kind = (extra && extra.timedOut) ? 'timeout' : 'aborted';
    else if (err && err.name === 'TimeoutError') kind = 'timeout';
    else if (err && err.name === 'TypeError') kind = 'network';
    else if (status === 401 || status === 403) kind = 'auth';
    else if (status === 404) kind = 'notfound';
    else if (status === 429) kind = 'rate';
    else if (status >= 500) kind = 'server';
    else if (err && err.code === 'BADJSON') kind = 'badjson';
    else if (err && err.code === 'EMPTY') kind = 'empty';
    else if (err && err.code === 'STREAMERR') kind = 'stream';
    else if (err && err.message) kind = 'unknown';
    return { kind: kind, text: KINDS[kind], status: status, raw: extra && extra.raw };
  }

  // ---------- 主请求 ----------
  // opts: { onDelta(text), signal, stream }
  async function send(cfg, messages, opts) {
    opts = opts || {};
    var api = cfg.api || {};
    var req = buildRequest(cfg, messages, opts);
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var timeoutMs = parseInt(api.timeoutMs, 10) || 60000;

    var ac = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ac.abort(); }, timeoutMs);
    var onOuterAbort = function () { ac.abort(); };
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', onOuterAbort);
    }

    var res = null;
    try {
      res = await fetch(req.url, {
        method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ac.signal
      });

      if (!res.ok) {
        var errText = '';
        try { errText = (await res.text() || '').slice(0, 400); } catch (e) { }
        var e1 = new Error('HTTP ' + res.status);
        e1.code = 'HTTP';
        var c1 = classify(e1, res, { timedOut: timedOut, raw: errText });
        throw Object.assign(new Error(c1.text), { AiClassified: c1 });
      }

      var ctype = (res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '');
      var out;

      if (req.stream && ctype.indexOf('text/event-stream') >= 0 && res.body && res.body.getReader) {
        out = await readStream(res, api.streamDeltaPath, opts.onDelta);
      } else {
        // 服务端没按 SSE 返回（有些网关会直接给一整块 JSON）→ 按普通响应处理
        var txt = await res.text();
        var obj = null;
        try { obj = JSON.parse(txt); } catch (e) { var e2 = new Error('bad json'); e2.code = 'BADJSON'; e2.__raw = txt; throw e2; }
        var val = getPath(obj, api.responsePath);
        if (typeof val !== 'string') {
          // 兼容个别网关把文本放在数组里（如 content: [{type:'text',text:'…'}]）
          if (Array.isArray(val)) {
            val = val.map(function (x) { return (x && (x.text || x.content)) || ''; }).join('');
          }
        }
        if (typeof val !== 'string' || !val) {
          var e3 = new Error('empty');
          e3.code = 'EMPTY';
          e3.__raw = txt.slice(0, 400);
          throw e3;
        }
        out = { text: val, chars: val.length, usage: obj && obj.usage, raw: txt.slice(0, 400) };
        if (opts.onDelta) opts.onDelta(val);
      }

      var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      return {
        ok: true, text: out.text, chars: out.chars, usage: out.usage,
        ms: Math.round(t1 - t0), request: safeRequest(req, api.apiKey)
      };
    } catch (e) {
      if (e && e.AiClassified) throw e;
      var raw = e && (e.__raw || e.message) || String(e);
      var c = classify(e, res, { timedOut: timedOut, raw: String(raw).slice(0, 400) });
      var err = new Error(c.text);
      err.AiClassified = c;
      throw err;
    } finally {
      clearTimeout(timer);
      if (opts.signal) { try { opts.signal.removeEventListener('abort', onOuterAbort); } catch (e) { } }
    }
  }

  // SSE 流式读取：按行拆，只认 data: 开头的行
  async function readStream(res, deltaPath, onDelta) {
    var reader = res.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '', text = '', chars = 0, usage = null, sawData = 0, obj0 = null;

    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = trim(lines[i]);
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var data = trim(line.slice(5));
        if (!data || data === '[DONE]') continue;
        sawData++;
        var obj = null;
        try { obj = JSON.parse(data); } catch (e) { continue; }
        if (!obj0) obj0 = obj;
        if (obj.usage) usage = obj.usage;
        if (obj.error) {
          var em = (obj.error && (obj.error.message || obj.error.code)) || 'stream error';
          var e4 = new Error(em); e4.code = 'STREAMERR'; e4.__raw = em; throw e4;
        }
        var d = getPath(obj, deltaPath);
        if (typeof d === 'string' && d) { text += d; chars += d.length; if (onDelta) onDelta(d); }
      }
    }
    if (!chars) {
      var e5 = new Error('empty stream');
      e5.code = 'EMPTY';
      e5.__raw = JSON.stringify(obj0 || {}).slice(0, 400);
      throw e5;
    }
    return { text: text, chars: chars, usage: usage };
  }

  // ---------- 连通性测试 ----------
  // 用最小代价走一遍与正式对话**完全相同**的请求路径，并把失败原因分类报出来
  async function testConnection(cfg) {
    var probe = {
      messages: [{ role: 'user', content: '回复"ok"两个字母即可，不要别的内容。' }],
      stream: false,
      body: { max_tokens: 16 }
    };
    // 临时关掉流式（有些网关流式与错误信息混在一起不好判断）
    var cfg2 = JSON.parse(JSON.stringify(cfg));
    cfg2.api.stream = false;
    try {
      var out = await send(cfg2, probe.messages, { stream: false, body: probe.body });
      return { ok: true, kind: 'ok', ms: out.ms, text: out.text, usage: out.usage, request: out.request };
    } catch (e) {
      var c = e.AiClassified || { kind: 'unknown', text: String(e && e.message || e), status: 0 };
      return { ok: false, kind: c.kind, text: c.text, status: c.status, raw: c.raw };
    }
  }

  AI.llm = {
    KINDS: KINDS,
    joinUrl: joinUrl, withQuery: withQuery, getPath: getPath, maskKey: maskKey,
    buildRequest: buildRequest, safeRequest: safeRequest, classify: classify,
    send: send, testConnection: testConnection
  };
})();
