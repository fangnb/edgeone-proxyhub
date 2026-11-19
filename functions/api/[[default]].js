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

// a_bogus 签名算法：抖音 webcast/web/partition/detail/room/v2/ 分区接口必需。
// 取自公开的 DouyinSign 实现（dart_simple_live simple_live_core 同款逻辑），
// 纯 JS，不读浏览器环境（入参里的 window_env_str 是写死的指纹串），可在 Worker 内运行。
// getABogus(查询串, UA) -> a_bogus；调用方再拼 msToken（见 signPartitionUrl）。

function getABogus(params, userAgent) {

    // All the content in this article is only for learning and communication use, not for any other purpose, strictly prohibited for commercial use and illegal use, otherwise all the consequences are irrelevant to the author!
    function rc4_encrypt(plaintext, key) {
        var s = [];
        for (var i = 0; i < 256; i++) {
            s[i] = i;
        }
        var j = 0;
        for (var i = 0; i < 256; i++) {
            j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;
            var temp = s[i];
            s[i] = s[j];
            s[j] = temp;
        }

        var i = 0;
        var j = 0;
        var cipher = [];
        for (var k = 0; k < plaintext.length; k++) {
            i = (i + 1) % 256;
            j = (j + s[i]) % 256;
            var temp = s[i];
            s[i] = s[j];
            s[j] = temp;
            var t = (s[i] + s[j]) % 256;
            cipher.push(String.fromCharCode(s[t] ^ plaintext.charCodeAt(k)));
        }
        return cipher.join('');
    }

    function le(e, r) {
        return (e << (r %= 32) | e >>> 32 - r) >>> 0
    }

    function de(e) {
        return 0 <= e && e < 16 ? 2043430169 : 16 <= e && e < 64 ? 2055708042 : void console['error']("invalid j for constant Tj")
    }

    function pe(e, r, t, n) {
        return 0 <= e && e < 16 ? (r ^ t ^ n) >>> 0 : 16 <= e && e < 64 ? (r & t | r & n | t & n) >>> 0 : (console['error']('invalid j for bool function FF'),
            0)
    }

    function he(e, r, t, n) {
        return 0 <= e && e < 16 ? (r ^ t ^ n) >>> 0 : 16 <= e && e < 64 ? (r & t | ~r & n) >>> 0 : (console['error']('invalid j for bool function GG'),
            0)
    }

    function reset() {
        this.reg[0] = 1937774191,
            this.reg[1] = 1226093241,
            this.reg[2] = 388252375,
            this.reg[3] = 3666478592,
            this.reg[4] = 2842636476,
            this.reg[5] = 372324522,
            this.reg[6] = 3817729613,
            this.reg[7] = 2969243214,
            this["chunk"] = [],
            this["size"] = 0
    }

    function write(e) {
        var a = "string" == typeof e ? function (e) {
            var n = encodeURIComponent(e)['replace'](/%([0-9A-F]{2})/g, (function (e, r) {
                return String['fromCharCode']("0x" + r)
            }
            ))
                , a = new Array(n['length']);
            return Array['prototype']['forEach']['call'](n, (function (e, r) {
                a[r] = e.charCodeAt(0)
            }
            )),
                a
        }(e) : e;
        this.size += a.length;
        var f = 64 - this['chunk']['length'];
        if (a['length'] < f)
            this['chunk'] = this['chunk'].concat(a);
        else
            for (this['chunk'] = this['chunk'].concat(a.slice(0, f)); this['chunk'].length >= 64;)
                this['_compress'](this['chunk']),
                    f < a['length'] ? this['chunk'] = a['slice'](f, Math['min'](f + 64, a['length'])) : this['chunk'] = [],
                    f += 64
    }

    function sum(e, t) {
        e && (this['reset'](),
            this['write'](e)),
            this['_fill']();
        for (var f = 0; f < this.chunk['length']; f += 64)
            this._compress(this['chunk']['slice'](f, f + 64));
        var i = null;
        if (t == 'hex') {
            i = "";
            for (f = 0; f < 8; f++)
                i += se(this['reg'][f]['toString'](16), 8, "0")
        } else
            for (i = new Array(32),
                f = 0; f < 8; f++) {
                var c = this.reg[f];
                i[4 * f + 3] = (255 & c) >>> 0,
                    c >>>= 8,
                    i[4 * f + 2] = (255 & c) >>> 0,
                    c >>>= 8,
                    i[4 * f + 1] = (255 & c) >>> 0,
                    c >>>= 8,
                    i[4 * f] = (255 & c) >>> 0
            }
        return this['reset'](),
            i
    }

    function _compress(t) {
        if (t < 64)
            console.error("compress error: not enough data");
        else {
            for (var f = function (e) {
                for (var r = new Array(132), t = 0; t < 16; t++)
                    r[t] = e[4 * t] << 24,
                        r[t] |= e[4 * t + 1] << 16,
                        r[t] |= e[4 * t + 2] << 8,
                        r[t] |= e[4 * t + 3],
                        r[t] >>>= 0;
                for (var n = 16; n < 68; n++) {
                    var a = r[n - 16] ^ r[n - 9] ^ le(r[n - 3], 15);
                    a = a ^ le(a, 15) ^ le(a, 23),
                        r[n] = (a ^ le(r[n - 13], 7) ^ r[n - 6]) >>> 0
                }
                for (n = 0; n < 64; n++)
                    r[n + 68] = (r[n] ^ r[n + 4]) >>> 0;
                return r
            }(t), i = this['reg'].slice(0), c = 0; c < 64; c++) {
                var o = le(i[0], 12) + i[4] + le(de(c), c)
                    , s = ((o = le(o = (4294967295 & o) >>> 0, 7)) ^ le(i[0], 12)) >>> 0
                    , u = pe(c, i[0], i[1], i[2]);
                u = (4294967295 & (u = u + i[3] + s + f[c + 68])) >>> 0;
                var b = he(c, i[4], i[5], i[6]);
                b = (4294967295 & (b = b + i[7] + o + f[c])) >>> 0,
                    i[3] = i[2],
                    i[2] = le(i[1], 9),
                    i[1] = i[0],
                    i[0] = u,
                    i[7] = i[6],
                    i[6] = le(i[5], 19),
                    i[5] = i[4],
                    i[4] = (b ^ le(b, 9) ^ le(b, 17)) >>> 0
            }
            for (var l = 0; l < 8; l++)
                this['reg'][l] = (this['reg'][l] ^ i[l]) >>> 0
        }
    }

    function _fill() {
        var a = 8 * this['size']
            , f = this['chunk']['push'](128) % 64;
        for (64 - f < 8 && (f -= 64); f < 56; f++)
            this.chunk['push'](0);
        for (var i = 0; i < 4; i++) {
            var c = Math['floor'](a / 4294967296);
            this['chunk'].push(c >>> 8 * (3 - i) & 255)
        }
        for (i = 0; i < 4; i++)
            this['chunk']['push'](a >>> 8 * (3 - i) & 255)

    }

    function SM3() {
        this.reg = [];
        this.chunk = [];
        this.size = 0;
        this.reset()
    }
    SM3.prototype.reset = reset;
    SM3.prototype.write = write;
    SM3.prototype.sum = sum;
    SM3.prototype._compress = _compress;
    SM3.prototype._fill = _fill;

    function result_encrypt(long_str, num = null) {
        let s_obj = {
            "s0": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
            "s1": "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
            "s2": "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
            "s3": "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
            "s4": "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe"
        }
        let constant = {
            "0": 16515072,
            "1": 258048,
            "2": 4032,
            "str": s_obj[num],
        }

        let result = "";
        let temp_int = 0;
        let lound = 0;
        let long_int = get_long_int(lound, long_str);
        for (let i = 0; i < long_str.length / 3 * 4; i++) {
            if (Math.floor(i / 4) !== lound) {
                lound += 1;
                long_int = get_long_int(lound, long_str);
            }
            let key = i % 4;
            switch (key) {
                case 0:
                    temp_int = (long_int & constant["0"]) >> 18;
                    result += constant["str"].charAt(temp_int);
                    break;
                case 1:
                    temp_int = (long_int & constant["1"]) >> 12;
                    result += constant["str"].charAt(temp_int);
                    break;
                case 2:
                    temp_int = (long_int & constant["2"]) >> 6;
                    result += constant["str"].charAt(temp_int);
                    break;
                case 3:
                    temp_int = long_int & 63;
                    result += constant["str"].charAt(temp_int);
                    break;
                default:
                    break;
            }
        }
        return result;
    }

    function get_long_int(round, long_str) {
        round = round * 3;
        return (long_str.charCodeAt(round) << 16) | (long_str.charCodeAt(round + 1) << 8) | (long_str.charCodeAt(round + 2));
    }

    function gener_random(random, option) {
        return [
            (random & 255 & 170) | option[0] & 85, // 163
            (random & 255 & 85) | option[0] & 170, //87
            (random >> 8 & 255 & 170) | option[1] & 85, //37
            (random >> 8 & 255 & 85) | option[1] & 170, //41
        ]
    }

    //////////////////////////////////////////////
    function generate_rc4_bb_str(url_search_params, user_agent, window_env_str, suffix = "cus", Arguments = [0, 1, 14]) {
        let sm3 = new SM3()
        let start_time = Date.now()
        /**
         * 进行3次加密处理
         * 1: url_search_params两次sm3之的结果
         * 2: 对后缀两次sm3之的结果
         * 3: 对ua处理之后的结果
         */
        // url_search_params两次sm3之的结果
        let url_search_params_list = sm3.sum(sm3.sum(url_search_params + suffix))
        // 对后缀两次sm3之的结果
        let cus = sm3.sum(sm3.sum(suffix))
        // 对ua处理之后的结果
        let ua = sm3.sum(result_encrypt(rc4_encrypt(user_agent, String.fromCharCode.apply(null, [0.00390625, 1, 14])), "s3"))
        //
        let end_time = Date.now()
        // b
        let b = {
            8: 3, // 固定
            10: end_time, //3次加密结束时间
            15: {
                "aid": 6383,
                "pageId": 6241,
                "boe": false,
                "ddrt": 7,
                "paths": {
                    "include": [
                        {},
                        {},
                        {},
                        {},
                        {},
                        {},
                        {}
                    ],
                    "exclude": []
                },
                "track": {
                    "mode": 0,
                    "delay": 300,
                    "paths": []
                },
                "dump": true,
                "rpU": ""
            },
            16: start_time, //3次加密开始时间
            18: 44, //固定
            19: [1, 0, 1, 5],
        }

        //3次加密开始时间
        b[20] = (b[16] >> 24) & 255
        b[21] = (b[16] >> 16) & 255
        b[22] = (b[16] >> 8) & 255
        b[23] = b[16] & 255
        b[24] = (b[16] / 256 / 256 / 256 / 256) >> 0
        b[25] = (b[16] / 256 / 256 / 256 / 256 / 256) >> 0

        // 参数Arguments [0, 1, 14, ...]
        // let Arguments = [0, 1, 14]
        b[26] = (Arguments[0] >> 24) & 255
        b[27] = (Arguments[0] >> 16) & 255
        b[28] = (Arguments[0] >> 8) & 255
        b[29] = Arguments[0] & 255

        b[30] = (Arguments[1] / 256) & 255
        b[31] = (Arguments[1] % 256) & 255
        b[32] = (Arguments[1] >> 24) & 255
        b[33] = (Arguments[1] >> 16) & 255

        b[34] = (Arguments[2] >> 24) & 255
        b[35] = (Arguments[2] >> 16) & 255
        b[36] = (Arguments[2] >> 8) & 255
        b[37] = Arguments[2] & 255

        // (url_search_params + "cus") 两次sm3之的结果
        /**let url_search_params_list = [
         91, 186,  35,  86, 143, 253,   6,  76,
         34,  21, 167, 148,   7,  42, 192, 219,
         188,  20, 182,  85, 213,  74, 213, 147,
         37, 155,  93, 139,  85, 118, 228, 213
         ]*/
        b[38] = url_search_params_list[21]
        b[39] = url_search_params_list[22]

        // ("cus") 对后缀两次sm3之的结果
        /**
         * let cus = [
         136, 101, 114, 147,  58,  77, 207, 201,
         215, 162, 154,  93, 248,  13, 142, 160,
         105,  73, 215, 241,  83,  58,  51,  43,
         255,  38, 168, 141, 216, 194,  35, 236
         ]*/
        b[40] = cus[21]
        b[41] = cus[22]

        // 对ua处理之后的结果
        /**
         * let ua = [
         129, 190,  70, 186,  86, 196, 199,  53,
         99,  38,  29, 209, 243,  17, 157,  69,
         147, 104,  53,  23, 114, 126,  66, 228,
         135,  30, 168, 185, 109, 156, 251,  88
         ]*/
        b[42] = ua[23]
        b[43] = ua[24]

        //3次加密结束时间
        b[44] = (b[10] >> 24) & 255
        b[45] = (b[10] >> 16) & 255
        b[46] = (b[10] >> 8) & 255
        b[47] = b[10] & 255
        b[48] = b[8]
        b[49] = (b[10] / 256 / 256 / 256 / 256) >> 0
        b[50] = (b[10] / 256 / 256 / 256 / 256 / 256) >> 0


        // object配置项
        b[51] = b[15]['pageId']
        b[52] = (b[15]['pageId'] >> 24) & 255
        b[53] = (b[15]['pageId'] >> 16) & 255
        b[54] = (b[15]['pageId'] >> 8) & 255
        b[55] = b[15]['pageId'] & 255

        b[56] = b[15]['aid']
        b[57] = b[15]['aid'] & 255
        b[58] = (b[15]['aid'] >> 8) & 255
        b[59] = (b[15]['aid'] >> 16) & 255
        b[60] = (b[15]['aid'] >> 24) & 255

        // 中间进行了环境检测
        // 代码索引:  2496 索引值:  17 （索引64关键条件）
        // '1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32'.charCodeAt()得到65位数组
        /**
         * let window_env_list = [49, 53, 51, 54, 124, 55, 52, 55, 124, 49, 53, 51, 54, 124, 56, 51, 52, 124, 48, 124, 51,
         * 48, 124, 48, 124, 48, 124, 49, 53, 51, 54, 124, 56, 51, 52, 124, 49, 53, 51, 54, 124, 56,
         * 54, 52, 124, 49, 53, 50, 53, 124, 55, 52, 55, 124, 50, 52, 124, 50, 52, 124, 87, 105, 110,
         * 51, 50]
         */
        let window_env_list = [];
        for (let index = 0; index < window_env_str.length; index++) {
            window_env_list.push(window_env_str.charCodeAt(index))
        }
        b[64] = window_env_list.length
        b[65] = b[64] & 255
        b[66] = (b[64] >> 8) & 255

        b[69] = [].length
        b[70] = b[69] & 255
        b[71] = (b[69] >> 8) & 255

        b[72] = b[18] ^ b[20] ^ b[26] ^ b[30] ^ b[38] ^ b[40] ^ b[42] ^ b[21] ^ b[27] ^ b[31] ^ b[35] ^ b[39] ^ b[41] ^ b[43] ^ b[22] ^
            b[28] ^ b[32] ^ b[36] ^ b[23] ^ b[29] ^ b[33] ^ b[37] ^ b[44] ^ b[45] ^ b[46] ^ b[47] ^ b[48] ^ b[49] ^ b[50] ^ b[24] ^
            b[25] ^ b[52] ^ b[53] ^ b[54] ^ b[55] ^ b[57] ^ b[58] ^ b[59] ^ b[60] ^ b[65] ^ b[66] ^ b[70] ^ b[71]
        let bb = [
            b[18], b[20], b[52], b[26], b[30], b[34], b[58], b[38], b[40], b[53], b[42], b[21], b[27], b[54], b[55], b[31],
            b[35], b[57], b[39], b[41], b[43], b[22], b[28], b[32], b[60], b[36], b[23], b[29], b[33], b[37], b[44], b[45],
            b[59], b[46], b[47], b[48], b[49], b[50], b[24], b[25], b[65], b[66], b[70], b[71]
        ]
        bb = bb.concat(window_env_list).concat(b[72])
        return rc4_encrypt(String.fromCharCode.apply(null, bb), String.fromCharCode.apply(null, [121]));
    }

    function generate_random_str() {
        let random_str_list = []
        random_str_list = random_str_list.concat(gener_random(Math.random() * 10000, [3, 45]))
        random_str_list = random_str_list.concat(gener_random(Math.random() * 10000, [1, 0]))
        random_str_list = random_str_list.concat(gener_random(Math.random() * 10000, [1, 5]))
        return String.fromCharCode.apply(null, random_str_list)
    }

    function generate_a_bogus(url_search_params, user_agent) {
        /**
         * url_search_params："device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1536&screen_height=864&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=123.0.0.0&browser_online=true&engine_name=Blink&engine_version=123.0.0.0&os_name=Windows&os_version=10&cpu_core_num=16&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50&webid=7362810250930783783&msToken=VkDUvz1y24CppXSl80iFPr6ez-3FiizcwD7fI1OqBt6IICq9RWG7nCvxKb8IVi55mFd-wnqoNkXGnxHrikQb4PuKob5Q-YhDp5Um215JzlBszkUyiEvR"
         * user_agent："Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
         */
        let result_str = generate_random_str() + generate_rc4_bb_str(
            url_search_params,
            user_agent,
            "1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32"
        );
        return result_encrypt(result_str, "s4") + "=";
    }

    //测试调用
    // console.log(generate_a_bogus(
    //     "device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1536&screen_height=864&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=123.0.0.0&browser_online=true&engine_name=Blink&engine_version=123.0.0.0&os_name=Windows&os_version=10&cpu_core_num=16&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50&webid=7362810250930783783&msToken=VkDUvz1y24CppXSl80iFPr6ez-3FiizcwD7fI1OqBt6IICq9RWG7nCvxKb8IVi55mFd-wnqoNkXGnxHrikQb4PuKob5Q-YhDp5Um215JzlBszkUyiEvR",
    //     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    // ));
    return generate_a_bogus(params, userAgent);

}


const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generateMsToken(length = 107) {
  const buf = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < length; i++) buf[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < length; i++) out += TOKEN_CHARS[buf[i] % TOKEN_CHARS.length];
  return out;
}

// 按 dart_simple_live 的 getAbogusUrl 拼：先在查询串后加 msToken 再签名，
// 最后把 msToken 与 a_bogus 一起拼回 URL。签名用的 UA 必须与请求头里的 UA 一致。
function signPartitionUrl(url, userAgent) {
  const msToken = generateMsToken(107);
  const query = url.split('?')[1] + '&msToken=' + msToken;
  const aBogus = getABogus(query, userAgent);
  return url + '&msToken=' + encodeURIComponent(msToken) + '&a_bogus=' + encodeURIComponent(aBogus);
}
// ---- 测试逻辑（拼在 abogus.js 签名代码之后，同一文件）----
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://live.douyin.com';

async function getTtwid() {
  const res = await fetch(`${BASE}/`, {
    headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('homepage ' + res.status);
  let raw = '';
  try {
    const arr = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    raw = arr.join('; ');
  } catch (e) { /* ignore */ }
  if (!raw) raw = res.headers.get('set-cookie') || '';
  const m = raw.match(/ttwid=([^;]+)/);
  return m ? m[1] : '';
}

async function fetchPage(ttwid, offset) {
  const params = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'link_share',
    cookie_enabled: 'true',
    screen_width: '1980',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Edge',
    browser_version: '125.0.0.0',
    browser_online: 'true',
    count: '15',
    offset: String(offset),
    partition: '1010037',
    partition_type: '1',
    req_from: '2',
  });
  const url = signPartitionUrl(`${BASE}/webcast/web/partition/detail/room/v2/?${params.toString()}`, UA);
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: `${BASE}/`,
      cookie: ttwid ? `ttwid=${ttwid}` : '',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('v2 http ' + res.status);
  const j = await res.json();
  if (j.status_code !== 0 || !j.data) throw new Error('v2 bad payload status_code=' + j.status_code);
  return (j.data.data || []).map((it) => String(it.web_rid || '')).filter(Boolean);
}

async function runDouyinTest() {
  const t0 = Date.now();
  const out = { platform: 'edgeone', partition: '1010037,1', ms: 0 };
  try {
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      out.egressIp = j.ip || '';
    } catch (e) {
      out.egressIp = 'unknown: ' + String(e.message || e);
    }
    let ttwid = '';
    try {
      ttwid = await getTtwid();
    } catch (e) {
      out.ttwidError = String(e.message || e);
    }
    out.ttwidOk = Boolean(ttwid);
    const p1 = await fetchPage(ttwid, 0);
    const p2 = await fetchPage(ttwid, 15);
    const s1 = new Set(p1);
    const overlap = p2.filter((x) => s1.has(x)).length;
    out.p1 = p1;
    out.p2 = p2;
    out.p1count = p1.length;
    out.p2count = p2.length;
    out.overlap = overlap;
    out.paginationWorks = p1.length > 0 && p2.length > 0 && overlap === 0;
    out.verdict = out.paginationWorks
      ? 'EdgeOne 出口可以正常翻页（offset 生效）'
      : 'EdgeOne 出口同样忽略 offset（与 CF 一样被风控）';
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  out.ms = Date.now() - t0;
  return json(out);
}

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

  // 临时测试：抖音翻页（EdgeOne 出口）——无需登录，测完删除
  if (path === '/api/douyin-test') return runDouyinTest();

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
