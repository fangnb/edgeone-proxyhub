# ProxyHub · EdgeOne 版

按 [MakkaPakka518/ProxyHub_Emby](https://github.com/MakkaPakka518/ProxyHub_Emby) 的核心用法，给腾讯云 EdgeOne Pages 重写的 Emby 反代面板。**不是原仓库 worker.js 的直接复制**：原版是混淆单文件、强依赖 Cloudflare D1，EdgeOne 上没有 D1，所以这里用 EdgeOne Pages 的结构重写，功能对齐核心链路。

## 功能（已实现）

- 节点管理：添加 / 编辑 / 删除节点，前缀、主线路、多条备用线路（主源 502 自动切备用）、反代模式、备注、观看下限
- 反代：`https://你的域名/前缀` → 自动 302 到 `/前缀/web/index.html`；`Location` / `Set-Cookie` 路径改写回前缀内；Range / 206 流式透传，不缓冲整段视频
- 反代模式：保守（抹除客户端 IP）/ 兼容 / 严格 / 强力 / EMOS（EMOS 头取节点里填的 ID / 称号，留空则不发，面板会提示）
- 权限三级：管理员（`ADMIN_TOKEN` 或网页密码）/ 子管理员（可审核申请，不能改节点）/ 订阅者（只读，看不到源站地址，调接口也拿不到）
- 反代 Token 门禁：开启后节点须走 `/密钥/前缀`，不带密钥访问节点会 302 到 `/catch`（“宝贝抓到你了”，显示来访 IP / UA）
- 裸域名开关：关掉后 `/https://任意地址` 一律 403，只剩节点前缀可用
- 节点申请审核：订阅者提交名字 + 线路，按域名去重（已有节点 / 已有申请都提示），管理员同意后自动预填到添加表单
- 一键导入播放器：SenPlayer / Rex / Hills 链接生成（凭据取节点账号密码，可在弹窗里临时改）
- 单节点测速：调源站 `/emby/System/Info/Public`，返回状态码和耗时
- 备份恢复：导出全部配置 JSON / 导入恢复
- 内网拦截：127 / 10 / 172.16-31 / 192.168 / localhost 目标一律拒绝（本地测试可用 `ALLOW_PRIVATE=true` 放开）

## 没有移植的功能（EdgeOne / 非 CF 环境本来就没有）

- Cloudflare DNS 管理、CF GraphQL 流量统计、区域调度（这些是 CF API 专属）
- Telegram / Bark 保号推送、播放热力图、真实观看会话统计（原版靠 D1 表 `play_hits` 等；本版只计节点总命中数，不做观看判定）
- 原版安卓 App 直连（App 是 CF 普通版专用；Hills / SenPlayer / Rex 的链接导入已实现）

## 项目结构

```
static/index.html                  面板首页（EdgeOne Pages 输出目录就是 static）
functions/api/[[default]].js       /api/*：登录、节点、配置、申请、导出导入、测速
functions/[[default]].js           /*：节点反代、裸代理、Token 门禁、/catch
```

EdgeOne Pages Functions 的路由规则：`functions/api/[[default]].js` 映射到 `/api/*`，`functions/[[default]].js` 映射到其余路径；更具体的 `/api/*` 优先于根 catch-all，所以 API 不会被反代函数抢走。

## 部署（EdgeOne 控制台，和 edgeone-proxy 同一套流程）

1. 把本项目推到你自己的 GitHub 新仓库（不要复用原仓库）。
2. EdgeOne 控制台 → 站点服务 → Pages → 新建站点 → 关联 Git 仓库进行部署，选这个仓库。
3. 构建配置（最关键，和 edgeone-proxy 一致）：
   - 构建框架预设：**其他**
   - 构建命令：**留空**
   - 根目录：**`./`**
   - 输出目录：**`static`**
   - 环境变量：先填 `ADMIN_TOKEN`（必填，管理员登录密码，**不要写进代码里**）
4. 保存并部署，拿到 `.edgeonepage.com` 域名或绑自己的域名后访问首页登录。

## 存储：KV 模式 vs 环境变量只读模式

### A. KV 模式（推荐，面板可增删改）

EdgeOne 国际站的 KV 目前是**白名单开通**，如果你的账号已开通：

1. 在 Pages 项目里创建 KV 命名空间并绑定，**变量名填 `PROXYHUB_KV`**。
2. 重新部署后首页横幅消失，面板增删改、配置、申请都可用。

### B. 无 KV 模式（今天就能跑，面板只读）

没开通 KV 也能先跑反代，节点用环境变量配：

- `NODES_JSON`：JSON 数组，例如
  `[{"prefix":"ok","name":"OkMedia","target":"https://link00.example.com:8443","mode":"兼容"}]`
- 面板会显示“只读模式”横幅：节点列表和直达链接正常，反代正常，但面板里加不了节点，改节点要改 `NODES_JSON` 后重新部署。
- 管理员登录仍用 `ADMIN_TOKEN`；订阅者、网页密码、Token 门禁这些存在 KV 里的配置在只读模式下不可用。

## 使用

1. 首页用 `ADMIN_TOKEN` 登录 → “+ 添加节点”：前缀如 `ok`，主线路如 `https://link00.example.com:8443`。
2. 访问 `https://你的域名/ok`，应 302 到 `/ok/web/index.html` 并打开 Emby。
3. Hills 客户端：服务器地址 `https://你的域名`，端口留空，路径填 `ok`，用 Emby 账号登录（不是面板密码）。不要填 `https://你的域名/ok/web/index.html`，也不要地址和路径都填 `ok`（会成 `/ok/ok` 报节点不存在）。
4. 想给朋友只读分享：管理员 → 账户 / 设置 → 订阅者里加 `名字:密码`，朋友用那个密码登录，只能复制直达链接和导入播放器，看不到源站。

## 安全提醒

- `ADMIN_TOKEN` 只放 Pages 环境变量，不要写进仓库、不要贴到聊天记录里；换过密码后旧 token 自动失效（token 是密码的哈希）。
- 节点密码（Emby 账号）只在管理员视图出现，订阅者接口已剥离 `target` / `targets` / `username` / `password`。
- 反代只做你自己有权限的 Emby 源站；“不允许反代的服务器就不要反代”，原作者 README 里也是这句话。

## 版本

edgeone-v1.0（2026-10-28）：核心链路重写版，未在真实 EdgeOne 上部署验证——部署后请先用 `/前缀/web/index.html` 和 Hills 各测一次，测速按钮只能测源站通不通，不能代表播放流畅度。
