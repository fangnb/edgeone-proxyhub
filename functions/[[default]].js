/**
 * ProxyHub for EdgeOne - reverse proxy
 * Route: /*  (EdgeOne Pages Functions: functions/[[default]].js)
 * More specific routes win: /api/* is handled by functions/api/[[default]].js,
 * static files in static/ win for the panel homepage.
 *
 * URL forms (same as the Cloudflare ProxyHub):
 *   https://<domain>/<prefix>/web/index.html   -> node <prefix>
 *   https://<domain>/<prefix>                  -> 302 to /<prefix>/web/index.html
 *   https://<domain>/<token>/<prefix>/...      -> same, when a proxy token is set
 *   https://<domain>/https://example.com/...   -> bare proxy (only if allowBare)
 *
 * No body rewriting: responses stream through, so video Range/206 keeps working.
 * Only Location and Set-Cookie are rewritten, so Emby login/redirects stay
 * inside the proxy prefix instead of leaking back to the origin host.
 */

const DATA_KEY = 'proxyhub:data:v1';
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);

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
    const arr = JSON.parse(env.NODES_JSON || env.NODES || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function loadData(context) {
  const env = context.env || {};
  const kv = getKV(context);
  if (kv) {
    try {
      const raw = await kv.get(DATA_KEY);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
          config: Object.assign({ proxyToken: '', allowBare: true }, parsed.config || {}),
          kv, storage: 'kv',
        };
      }
    } catch {}
    return { nodes: [], config: { proxyToken: '', allowBare: true }, kv, storage: 'kv' };
  }
  return { nodes: envNodes(env), config: { proxyToken: '', allowBare: true }, kv: null, storage: 'env' };
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

function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '';
}

function catchPage(request) {
  const ip = clientIp(request) || '未知';
  const ua = request.headers.get('user-agent') || '未知';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>宝贝抓到你了</title>' +
    '<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0">' +
    '<div style="text-align:center"><h1>宝贝抓到你了</h1><p>这个面板开了反代 Token，请带上密钥再访问节点。</p>' +
    '<p>IP：' + esc(ip) + '</p><p style="color:#999;max-width:520px;word-break:break-all">UA：' + esc(ua) + '</p></div></body>',
    { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function rewriteLocation(loc, origin, prefixPath, targetOrigin) {
  if (!loc) return loc;
  if (loc.startsWith(targetOrigin)) return origin + prefixPath + loc.slice(targetOrigin.length);
  if (loc.startsWith('/') && !loc.startsWith(prefixPath + '/') && loc !== prefixPath) {
    return origin + prefixPath + loc;
  }
  return loc;
}

async function proxyTo(request, targetBase, restPath, search, origin, prefixPath, mode, node) {
  const targetOrigin = targetBase.replace(/\/+$/, '');
  const targetUrl = targetOrigin + (restPath || '/') + search;
  let target;
  try { target = new URL(targetUrl); } catch { return new Response('目标地址无效', { status: 400 }); }
  // Private-origin guard is done by the caller (it knows ALLOW_PRIVATE).
  const headers = new Headers();
  request.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP.has(lk) || lk === 'host' || lk === 'content-length') return;
    headers.set(k, v);
  });
  headers.set('host', target.host);
  const ip = clientIp(request);
  const m = (mode || '兼容');
  if (m === '保守') {
    headers.delete('x-forwarded-for');
    headers.delete('x-real-ip');
  } else {
    if (ip) {
      headers.set('x-forwarded-for', ip);
      headers.set('x-real-ip', ip);
    }
  }
  if (m === '严格') {
    headers.delete('referer');
    headers.delete('origin');
  }
  if (m === 'EMOS') {
    if (node && node.emosId) headers.set('emos-proxy-id', node.emosId);
    if (node && node.emosName) headers.set('emos-proxy-name', node.emosName);
  }
  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') ? request.body : undefined,
      redirect: 'manual',
    });
  } catch (e) {
    return new Response('上游连接失败：' + (e && e.message ? e.message : e), { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP.has(lk) || lk === 'content-length') return;
    out.set(k, v);
  });
  const loc = upstream.headers.get('location');
  if (loc) out.set('location', rewriteLocation(loc, origin, prefixPath, targetOrigin));
  // Set-Cookie: rewrite Path=/... to Path=<prefixPath>/...
  try {
    const cookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
    if (cookies.length) {
      out.delete('set-cookie');
      for (const c of cookies) {
        const rewritten = c.replace(/;\s*path=\/[^;]*/i, (match) => {
          const p = match.replace(/;\s*path=/i, '');
          if (p === '/') return '; Path=' + prefixPath + '/';
          if (p.startsWith(prefixPath + '/') || p === prefixPath) return match;
          return '; Path=' + prefixPath + p;
        });
        out.append('set-cookie', rewritten);
      }
    }
  } catch {}
  out.delete('content-length');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = url.origin;
  const allowPrivate = env.ALLOW_PRIVATE === 'true';
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '') {
    return Response.redirect(origin + '/index.html', 302);
  }
  if (pathname === '/favicon.ico' || pathname === '/robots.txt') {
    return new Response('', { status: 404 });
  }
  if (pathname === '/catch') return catchPage(request);
  if (pathname === '/entry') return Response.redirect(origin + '/', 302);
  if (pathname === '/health') return new Response(JSON.stringify({ ok: true, version: 'edgeone-v1.0' }), { headers: { 'content-type': 'application/json' } });

  const { nodes, config, kv } = await loadData(context);

  // ---- bare proxy: /https://... or /https:/... ----
  const bare = pathname.match(/^\/(https?:\/+)(.*)$/);
  if (bare) {
    if (config.allowBare === false) return new Response('裸域名直连代理已关闭', { status: 403 });
    let targetUrl = 'https://' ;
    const scheme = bare[1].startsWith('https') ? 'https://' : 'http://';
    targetUrl = scheme + bare[2] + url.search;
    let tu;
    try { tu = new URL(targetUrl); } catch { return new Response('裸代理地址无效', { status: 400 }); }
    if (!allowPrivate && isPrivateHost(tu.hostname)) return new Response('内网地址已被拦截', { status: 403 });
    return proxyTo(request, tu.origin, tu.pathname, url.search, origin, '/' + scheme + tu.host, '兼容', null);
  }

  // ---- token gate ----
  const segs = pathname.split('/').filter(Boolean);
  let tokenPrefix = '';
  let prefix = segs[0] || '';
  let restSegs = segs.slice(1);
  if (config.proxyToken) {
    if (segs[0] !== config.proxyToken) {
      // A bare node prefix without the token goes to /catch, like the CF panel
      if (nodes.some((n) => n.prefix === segs[0])) return catchPage(request);
      return new Response('404: 节点不存在', { status: 404 });
    }
    tokenPrefix = '/' + config.proxyToken;
    prefix = segs[1] || '';
    restSegs = segs.slice(2);
    if (!prefix) return new Response('404: 节点不存在', { status: 404 });
  }

  const node = nodes.find((n) => n.prefix === prefix);
  if (!node) return new Response('404: 节点不存在', { status: 404 });

  const prefixPath = tokenPrefix + '/' + prefix;
  const restPath = restSegs.length ? '/' + restSegs.join('/') : '';
  if (!restPath || restPath === '/') {
    return Response.redirect(origin + prefixPath + '/web/index.html', 302);
  }

  const targets = [node.target, ...((node.targets || []).filter(Boolean))];
  for (let i = 0; i < targets.length; i++) {
    let tu;
    try { tu = new URL(targets[i]); } catch { continue; }
    if (!allowPrivate && isPrivateHost(tu.hostname)) continue;
    const res = await proxyTo(request, targets[i], restPath, url.search, origin, prefixPath, node.mode, node);
    // Only fail over on network/upstream errors, not on a real 404 from Emby
    if (res.status === 502 && i < targets.length - 1) continue;
    if (kv) {
      // Best-effort hit count, never blocks the response
      try {
        const raw = await kv.get(DATA_KEY);
        if (raw) {
          const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
          d.stats = d.stats || { hits: 0, byPrefix: {} };
          d.stats.hits = (d.stats.hits || 0) + 1;
          d.stats.byPrefix[prefix] = (d.stats.byPrefix[prefix] || 0) + 1;
          if (context.waitUntil) context.waitUntil(kv.put(DATA_KEY, JSON.stringify(d)));
          else kv.put(DATA_KEY, JSON.stringify(d)).catch(() => {});
        }
      } catch {}
    }
    return res;
  }
  return new Response('所有线路均不可用', { status: 502 });
}
