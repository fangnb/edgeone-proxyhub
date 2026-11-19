/**
 * ProxyHub for EdgeOne - API
 * Route: /api/*  (EdgeOne Pages Functions: functions/api/[[default]].js)
 *
 * Storage (in priority order):
 *  1. KV bound as PROXYHUB_KV (or KV / my_kv) - full read/write, panel editable.
 *     KV is allowlist-only on EdgeOne international, so if you cannot bind KV,
 *  2. NODES_JSON env var - read-only nodes, panel shows a read-only banner.
 *     Format: [{"prefix":"ok","name":"OkMedia","target":"https://link00.example.com:8443"}]
 *
 * Auth: stateless token = role + "." + sha256(ADMIN_TOKEN + "|" + role + "|" + password)
 * No session is stored, so it works across edge nodes. ADMIN_TOKEN is never
 * written into code - set it in the Pages console as an environment variable.
 * Web password / subscriber passwords live in KV config (not in code).
 */

const DATA_KEY = 'proxyhub:data:v1';
const RESERVED = new Set(['api', 'catch', 'entry', 'login', 'admin', 'health', 'favicon.ico', 'static', 'web', 'emby', 'proxy']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function getKV(context) {
  const env = (context && context.env) || {};
  const candidates = [env.PROXYHUB_KV, env.KV, env.MY_KV, globalThis.PROXYHUB_KV, globalThis.my_kv];
  for (const c of candidates) {
    if (c && typeof c.get === 'function' && typeof c.put === 'function') return c;
  }
  return null;
}

function envNodes(env) {
  try {
    const raw = env.NODES_JSON || env.NODES || '';
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((n) => n && n.prefix && n.target) : [];
  } catch { return []; }
}

function emptyData() {
  return {
    nodes: [],
    config: { webPassword: '', subAdminPassword: '', proxyToken: '', allowBare: true, subscribers: [] },
    requests: [],
    stats: { hits: 0, byPrefix: {} },
  };
}

async function loadData(context) {
  const env = context.env || {};
  const kv = getKV(context);
  if (kv) {
    try {
      const raw = await kv.get(DATA_KEY);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const d = emptyData();
        if (parsed) {
          if (Array.isArray(parsed.nodes)) d.nodes = parsed.nodes;
          if (parsed.config) d.config = Object.assign(d.config, parsed.config);
          if (Array.isArray(parsed.requests)) d.requests = parsed.requests;
          if (parsed.stats) d.stats = Object.assign(d.stats, parsed.stats);
        }
        return { data: d, storage: 'kv', kv };
      }
      return { data: emptyData(), storage: 'kv', kv };
    } catch { /* fall through to env mode */ }
  }
  const d = emptyData();
  d.nodes = envNodes(env).map((n, i) => ({
    id: n.id || ('env-' + i),
    prefix: n.prefix,
    name: n.name || n.prefix,
    target: n.target,
    targets: Array.isArray(n.targets) ? n.targets : [],
    mode: n.mode || '兼容',
    remark: n.remark || '',
    username: n.username || '',
    password: n.password || '',
    emosId: n.emosId || '',
    emosName: n.emosName || '',
    watchLimitDays: Number(n.watchLimitDays) || 0,
    sort: Number(n.sort) || 0,
    createdAt: Date.now(),
  }));
  return { data: d, storage: 'env', kv: null };
}

async function saveData(context, data, kv) {
  if (!kv) return false;
  await kv.put(DATA_KEY, JSON.stringify(data));
  return true;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tokenFor(env, role, password) {
  return role + '.' + (await sha256Hex((env.ADMIN_TOKEN || '') + '|' + role + '|' + password));
}

async function verifyAuth(context, data) {
  const env = context.env || {};
  const req = context.request;
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const cfg = data.config || {};
  const candidates = [];
  if (env.ADMIN_TOKEN) candidates.push({ role: 'admin', password: env.ADMIN_TOKEN });
  if (cfg.webPassword) candidates.push({ role: 'admin', password: cfg.webPassword });
  if (cfg.subAdminPassword) candidates.push({ role: 'subadmin', password: cfg.subAdminPassword });
  for (const s of (cfg.subscribers || [])) {
    if (s && s.password) candidates.push({ role: 'subscriber', password: s.password, name: s.name || '' });
  }
  for (const c of candidates) {
    if (token === (await tokenFor(env, c.role, c.password))) {
      return { role: c.role, name: c.name || '' };
    }
  }
  return null;
}

function publicNode(n) {
  return {
    id: n.id, prefix: n.prefix, name: n.name, mode: n.mode || '兼容',
    remark: n.remark || '', watchLimitDays: n.watchLimitDays || 0, sort: n.sort || 0,
  };
}

function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function checkTarget(target, allowPrivate) {
  let u;
  try { u = new URL(target); } catch { return '目标地址不是合法 URL（需以 http:// 或 https:// 开头）'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '目标地址只支持 http/https';
  if (!allowPrivate && isPrivateHost(u.hostname)) return '内网地址已被拦截（127/10/172.16-31/192.168/localhost）';
  return null;
}

function cleanPrefix(p) { return String(p || '').trim(); }

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // /api/health - no auth, tells the panel which storage mode it is in
  if (path === '/api/health' || path === '/api') {
    const { storage } = await loadData(context);
    return json({ ok: true, version: 'edgeone-v1.0', storage, adminConfigured: Boolean(env.ADMIN_TOKEN) });
  }

  const { data, storage, kv } = await loadData(context);
  const readonly = storage !== 'kv';

  // ---- login (no token needed) ----
  if (path === '/api/login' && method === 'POST') {
    if (!env.ADMIN_TOKEN) {
      return json({ success: false, error: '请先在 Pages 控制台环境变量里配置 ADMIN_TOKEN' }, 500);
    }
    let body = {};
    try { body = await request.json(); } catch {}
    const password = String(body.password || '');
    if (!password) return json({ success: false, error: '请输入密码' }, 400);
    const cfg = data.config;
    if (password === env.ADMIN_TOKEN || (cfg.webPassword && password === cfg.webPassword)) {
      return json({ success: true, role: 'admin', token: await tokenFor(env, 'admin', password), storage, readonly });
    }
    if (cfg.subAdminPassword && password === cfg.subAdminPassword) {
      return json({ success: true, role: 'subadmin', token: await tokenFor(env, 'subadmin', password), storage, readonly });
    }
    for (const s of (cfg.subscribers || [])) {
      if (s.password && password === s.password) {
        return json({ success: true, role: 'subscriber', token: await tokenFor(env, 'subscriber', password), storage, readonly });
      }
    }
    return json({ success: false, error: '密码错误' }, 401);
  }

  const auth = await verifyAuth(context, data);
  if (!auth) return json({ success: false, error: '未登录' }, 401);

  // ---- me ----
  if (path === '/api/me') {
    return json({ success: true, role: auth.role, storage, readonly });
  }

  // ---- nodes: list ----
  if (path === '/api/nodes' && method === 'GET') {
    const list = [...data.nodes].sort((a, b) => (a.sort || 0) - (b.sort || 0));
    if (auth.role === 'subscriber') return json({ success: true, nodes: list.map(publicNode), storage, readonly });
    return json({ success: true, nodes: list, storage, readonly });
  }

  // ---- nodes: create (admin only) ----
  if (path === '/api/nodes' && method === 'POST') {
    if (auth.role !== 'admin') return json({ success: false, error: '仅管理员可添加节点' }, 403);
    if (readonly) return json({ success: false, error: '未绑定 KV，当前为环境变量只读模式：请用 NODES_JSON 配置节点，或绑定 KV 后再编辑' }, 503);
    let body = {};
    try { body = await request.json(); } catch { return json({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const prefix = cleanPrefix(body.prefix);
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(prefix)) return json({ success: false, error: '前缀只能用字母、数字、-、_，1-32 位' }, 400);
    if (RESERVED.has(prefix.toLowerCase())) return json({ success: false, error: '该前缀是系统保留路径，换一个' }, 400);
    if (data.nodes.some((n) => n.prefix === prefix)) return json({ success: false, error: '前缀已存在' }, 409);
    const target = String(body.target || '').trim();
    const err = checkTarget(target, env.ALLOW_PRIVATE === 'true');
    if (err) return json({ success: false, error: err }, 400);
    const backups = String(body.targets || '')
      .split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
    for (const b of backups) {
      const e2 = checkTarget(b, env.ALLOW_PRIVATE === 'true');
      if (e2) return json({ success: false, error: '备用线路 ' + b + '：' + e2 }, 400);
    }
    const node = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      prefix, name: String(body.name || prefix), target, targets: backups,
      mode: String(body.mode || '兼容'), remark: String(body.remark || ''),
      username: String(body.username || ''), password: String(body.password || ''),
      emosId: String(body.emosId || ''), emosName: String(body.emosName || ''),
      watchLimitDays: Number(body.watchLimitDays) || 0, sort: Number(body.sort) || 0,
      createdAt: Date.now(),
    };
    data.nodes.push(node);
    await saveData(context, data, kv);
    return json({ success: true, node });
  }

  // ---- nodes: /api/nodes/<prefix> ----
  const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)$/);
  if (nodeMatch) {
    const prefix = decodeURIComponent(nodeMatch[1]);
    const node = data.nodes.find((n) => n.prefix === prefix);
    if (method === 'GET') {
      if (!node) return json({ success: false, error: '节点不存在' }, 404);
      return json({ success: true, node: auth.role === 'subscriber' ? publicNode(node) : node });
    }
    if (method === 'PUT') {
      if (auth.role !== 'admin') return json({ success: false, error: '仅管理员可编辑节点' }, 403);
      if (readonly) return json({ success: false, error: '未绑定 KV，当前为只读模式' }, 503);
      if (!node) return json({ success: false, error: '节点不存在' }, 404);
      let body = {};
      try { body = await request.json(); } catch { return json({ success: false, error: '请求体不是合法 JSON' }, 400); }
      if (body.target) {
        const e = checkTarget(String(body.target).trim(), env.ALLOW_PRIVATE === 'true');
        if (e) return json({ success: false, error: e }, 400);
        node.target = String(body.target).trim();
      }
      if (body.targets !== undefined) {
        node.targets = String(body.targets).split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      }
      for (const k of ['name', 'mode', 'remark', 'username', 'password', 'emosId', 'emosName']) {
        if (body[k] !== undefined) node[k] = String(body[k]);
      }
      if (body.watchLimitDays !== undefined) node.watchLimitDays = Number(body.watchLimitDays) || 0;
      if (body.sort !== undefined) node.sort = Number(body.sort) || 0;
      await saveData(context, data, kv);
      return json({ success: true, node });
    }
    if (method === 'DELETE') {
      if (auth.role !== 'admin') return json({ success: false, error: '仅管理员可删除节点' }, 403);
      if (readonly) return json({ success: false, error: '未绑定 KV，当前为只读模式' }, 503);
      if (!node) return json({ success: false, error: '节点不存在' }, 404);
      data.nodes = data.nodes.filter((n) => n.prefix !== prefix);
      await saveData(context, data, kv);
      return json({ success: true });
    }
    // ping: POST /api/nodes/<prefix>/ping is handled below via a separate match
    return json({ success: false, error: '不支持的方法' }, 405);
  }

  const pingMatch = path.match(/^\/api\/nodes\/([^/]+)\/ping$/);
  if (pingMatch && method === 'POST') {
    if (auth.role === 'subscriber') return json({ success: false, error: '订阅者不能测速' }, 403);
    const node = data.nodes.find((n) => n.prefix === decodeURIComponent(pingMatch[1]));
    if (!node) return json({ success: false, error: '节点不存在' }, 404);
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(node.target.replace(/\/+$/, '') + '/emby/System/Info/Public', { method: 'GET', signal: ctl.signal, redirect: 'follow' });
      clearTimeout(timer);
      return json({ success: true, status: r.status, ms: Date.now() - t0 });
    } catch (e) {
      return json({ success: false, error: String(e && e.message ? e.message : e), ms: Date.now() - t0 }, 502);
    }
  }

  // ---- config ----
  if (path === '/api/config') {
    if (method === 'GET') {
      if (auth.role === 'subscriber') {
        return json({ success: true, config: { allowBare: data.config.allowBare !== false } });
      }
      return json({ success: true, config: data.config });
    }
    if (method === 'POST') {
      if (auth.role !== 'admin') return json({ success: false, error: '仅管理员可改配置' }, 403);
      if (readonly) return json({ success: false, error: '未绑定 KV，当前为只读模式' }, 503);
      let body = {};
      try { body = await request.json(); } catch { return json({ success: false, error: '请求体不是合法 JSON' }, 400); }
      for (const k of ['webPassword', 'subAdminPassword', 'proxyToken']) {
        if (body[k] !== undefined) data.config[k] = String(body[k]);
      }
      if (body.allowBare !== undefined) data.config.allowBare = Boolean(body.allowBare);
      if (Array.isArray(body.subscribers)) {
        data.config.subscribers = body.subscribers
          .filter((s) => s && s.password)
          .map((s) => ({ name: String(s.name || ''), password: String(s.password) }));
      }
      await saveData(context, data, kv);
      return json({ success: true, config: data.config });
    }
  }

  // ---- node requests (subscriber apply, admin/subadmin review) ----
  if (path === '/api/requests' && method === 'GET') {
    if (auth.role === 'subscriber') return json({ success: false, error: '订阅者不能查看申请列表' }, 403);
    return json({ success: true, requests: data.requests || [] });
  }
  if (path === '/api/requests' && method === 'POST') {
    if (readonly) return json({ success: false, error: '未绑定 KV，当前为只读模式' }, 503);
    let body = {};
    try { body = await request.json(); } catch { return json({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const name = String(body.name || '').trim();
    const target = String(body.url || body.target || '').trim();
    if (!name || !target) return json({ success: false, error: '请填名字和线路地址' }, 400);
    const e = checkTarget(target, env.ALLOW_PRIVATE === 'true');
    if (e) return json({ success: false, error: e }, 400);
    let host = '';
    try { host = new URL(target).hostname.toLowerCase(); } catch {}
    const dupNode = data.nodes.find((n) => { try { return new URL(n.target).hostname.toLowerCase() === host; } catch { return false; } });
    if (dupNode) return json({ success: false, error: '已存在该节点（' + dupNode.name + ' / ' + dupNode.prefix + '）' }, 409);
    const dupReq = (data.requests || []).find((r) => { try { return new URL(r.url).hostname.toLowerCase() === host; } catch { return false; } });
    if (dupReq) return json({ success: false, error: '该线路已有人申请，等待审核中' }, 409);
    const reqItem = { id: Date.now().toString(36), name, url: target, createdAt: Date.now(), by: auth.role };
    data.requests.push(reqItem);
    await saveData(context, data, kv);
    return json({ success: true, request: reqItem });
  }
  const reqMatch = path.match(/^\/api\/requests\/([^/]+)$/);
  if (reqMatch) {
    if (auth.role === 'subscriber') return json({ success: false, error: '订阅者不能审核申请' }, 403);
    const item = (data.requests || []).find((r) => r.id === reqMatch[1]);
    if (!item) return json({ success: false, error: '申请不存在' }, 404);
    if (method === 'DELETE') {
      data.requests = data.requests.filter((r) => r.id !== item.id);
      await saveData(context, data, kv);
      return json({ success: true });
    }
    if (method === 'POST' && path.endsWith('/approve')) {
      // approve is POST /api/requests/<id>/approve, handled by the match below
    }
    return json({ success: false, error: '不支持的方法' }, 405);
  }
  const approveMatch = path.match(/^\/api\/requests\/([^/]+)\/approve$/);
  if (approveMatch && method === 'POST') {
    if (auth.role === 'subscriber') return json({ success: false, error: '订阅者不能审核申请' }, 403);
    const item = (data.requests || []).find((r) => r.id === approveMatch[1]);
    if (!item) return json({ success: false, error: '申请不存在' }, 404);
    data.requests = data.requests.filter((r) => r.id !== item.id);
    await saveData(context, data, kv);
    return json({ success: true, prefill: { name: item.name, target: item.url } });
  }

  // ---- export / import (admin) ----
  if (path === '/api/export' && method === 'GET') {
    if (auth.role !== 'admin') return json({ success: false, error: '仅管理员可导出' }, 403);
    return json({ success: true, data });
  }
  if (path === '/api/import' && method === 'POST') {
    if (auth.role !== 'admin') return json({ success: false, error: '仅管理员可导入' }, 403);
    if (readonly) return json({ success: false, error: '未绑定 KV，当前为只读模式' }, 503);
    let body = {};
    try { body = await request.json(); } catch { return json({ success: false, error: '请求体不是合法 JSON' }, 400); }
    const incoming = body.data || body;
    if (!incoming || !Array.isArray(incoming.nodes)) return json({ success: false, error: '导入文件里没有 nodes 数组' }, 400);
    data.nodes = incoming.nodes;
    if (incoming.config) data.config = Object.assign(data.config, incoming.config);
    if (Array.isArray(incoming.requests)) data.requests = incoming.requests;
    await saveData(context, data, kv);
    return json({ success: true, count: data.nodes.length });
  }

  return json({ success: false, error: '接口不存在：' + path }, 404);
}
