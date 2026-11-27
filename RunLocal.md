# 本地跑开发（RunLocal）

这份文档说明怎么在**本机**把 CF-ImgHub 跑起来、改完怎么验证、以及各种本地专用开关的边界。生产部署看 `README.md`，代码约定看 `AGENTS.md`。

---

## 0. 两种跑法怎么选

| | 标准：`npm run dev`（wrangler + miniflare） | 零安装：`node scripts/dev-local.mjs` |
|---|---|---|
| 需要装依赖 | 需要（`npm install`，约 30 MB） | **不需要**，只用 Node 原生 API |
| 运行时 | 真 workerd（与线上同一套语义） | 手写的够用子集（R2/Cache/Assets/Ratelimit 的内存实现） |
| 数据 | 落盘在 `.wrangler/state`，重启还在 | 全在内存，**停止即清空** |
| 定时任务、Durable Objects | 支持 | 不支持 |
| 浏览器端压缩（AVIF/WebP） | `npm run vendor` 自动就绪 | 需要 `public/vendor/` 已存在（见 §8.2） |
| 适用场景 | 日常开发、联调、演示、复现线上问题 | 临时看一眼页面、机器上不方便装依赖 |

两条路径用的都是同一份 `src/index.js`，页面与接口行为一致。

---

## 1. 前置条件

- Node ≥ 18（`fetch`、`crypto.subtle`、`ReadableStream` 都是原生依赖；本机 Node 27 也可）
- 端口 `8787` 空闲（零安装路径还可用 `--port` 换端口）
- 命令都在仓库根目录执行

---

## 2. 标准路径：`npm run dev`

### 2.1 装依赖并生成配置

```bash
npm install

# 本地密钥（.dev.vars 已被 .gitignore 忽略，不要提交）
cp .dev.vars.example .dev.vars      # Windows PowerShell: Copy-Item .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，至少填这五项：

| 名称 | 说明 |
|---|---|
| `SESSION_SECRET` | 会话签名密钥，随便一串长随机串；改了等于让所有人重新登录 |
| `UPLOAD_PASSWORD` | 首页的上传密码 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理账号（`/admin`、`/settings`） |
| `UPLOAD_TOKEN` | 脚本上传用的 Bearer token |

可选：`TG_BOT_TOKEN` + `TG_CHAT_ID`（Telegram 存储）、`HF_S3_ACCESS_KEY` + `HF_S3_SECRET` + `HF_NAMESPACE` + `HF_BUCKET`（HuggingFace 归档，见 §6）。

### 2.2 启动

```bash
npm run dev          # = npm run vendor && wrangler dev
```

`vendor` 这一步把 `node_modules` 里的 AVIF/WebP 编码器和 mediabunny 复制到 `public/vendor/`（该目录是生成物，不提交）。首次启动 wrangler 会创建本地 R2 模拟环境。

打开 <http://localhost:8787>：

1. 首页 → 输入 `UPLOAD_PASSWORD` → 拖图上传 → 复制链接到新标签验证；
2. `/admin` → 用 `ADMIN_USER` / `ADMIN_PASSWORD` 登录 → 列表、详情、删除、补缩略图；
3. `/settings` → 站点名、防盗链、存储方式、主题、背景、友情链接。

### 2.3 改代码时的行为

| 改哪里 | 需要做什么 |
|---|---|
| `src/**` | 保存即热重载 |
| `public/**` 静态页/脚本 | 刷新浏览器（必要时 Ctrl+F5 清缓存） |
| `wrangler.jsonc`（绑定、crons、vars） | 重启 `npm run dev` |
| `.dev.vars` | 重启 `npm run dev`（只在启动时读） |
| 依赖版本 | `npm install` 后 **重新** `npm run vendor` |

### 2.4 本地数据在哪

- 上传的图片、设置、缩略图：`.wrangler/state/v3/r2/`（删掉这个目录 = 恢复出厂）
- 想换位置：`npx wrangler dev --persist-to ./tmp-state`
- 清空缓存表现：直接删对应目录后重启

### 2.5 部署前

```bash
npx wrangler deploy         # 或按 README 走面板/一键部署
npx wrangler tail           # 看线上日志（observability 已开）
```

---

## 3. 零安装路径：`node scripts/dev-local.mjs`

机器上不装任何依赖时用它。脚本自己实现了一份够用的 R2 / Cache API / Assets / 登录限速，再加载真正的 `src/index.js`。

### 3.1 启动

```bash
node scripts/dev-local.mjs                  # 端口 8787，只存 R2
node scripts/dev-local.mjs --hf             # 额外起一个假 HuggingFace 网关（8788），可试 HF 归档/实验主存
node scripts/dev-local.mjs --port 8790      # 换端口
```

启动后会打印当前生效的凭据：管理员 `admin / dev-admin`、token `dev-token`，以及内置的上传密码（想固定成自己的值就加 `--upload-pass 你的密码`，启动日志会跟着变）。

### 3.2 参数与优先级

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | `8787` | 主服务端口 |
| `--hf` | 关 | 起假 HF 网关，并注入 `HF_*` 环境变量 |
| `--hf-port` | `8788` | 假网关端口 |
| `--admin-user` / `--admin-pass` | `admin` / `dev-admin` | 管理账号 |
| `--upload-pass` | 脚本内置开发值（启动时打印） | 首页上传密码 |
| `--token` | `dev-token` | Bearer token |
| `--session-secret` | 固定开发值 | 会话签名密钥 |

优先级：**命令行 > `.dev.vars` > 内置默认值**。也就是说标准路径创建好的 `.dev.vars` 会被直接复用。

### 3.3 能力边界（重要）

| 能 | 不能 |
|---|---|
| 上传/读图/Range/304、管理页、设置页、R2 多桶路由、登录限速 | 定时任务（cron 补归档不会自己跑，可手动点「开始归档」） |
| HF 归档与「实验：仅 HuggingFace」（配 `--hf`） | 真实投递到 Telegram/HF（除非 `.dev.vars` 里配了真密钥；假网关不校验签名） |
| 与线上一致的 `src/` 代码路径 | 数据持久化：**停止进程即清空** |

注意：假网关只验证线路（PUT/GET/HEAD/DELETE/ListObjectsV2/Range），**不校验 SigV4 签名**。签名的正确性由 `scripts/hf-s3-smoke.mjs` 单独保证（§7）。

---

## 4. 登录与角色

| 入口 | 凭据 | 能做什么 |
|---|---|---|
| `/` 首页 | `UPLOAD_PASSWORD` | 上传、看自己的上传记录、撤回 24 小时内的上传 |
| `/admin`、`/settings` | `ADMIN_USER` / `ADMIN_PASSWORD` | 全部管理操作 |
| 任意 `/api/*` | `Authorization: Bearer $UPLOAD_TOKEN` | 脚本上传（不需要 Cookie） |

登录接口的请求体是 `{role, username, password}` —— **`role` 不传默认按 upload 角色校验**，这是最容易踩的坑：

```bash
# 管理员：零安装路径默认 admin / dev-admin；标准路径用自己的 .dev.vars
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PW=${ADMIN_PW:-dev-admin}
curl -s -c cj.txt -X POST localhost:8787/api/login -H 'Content-Type: application/json' \
  -d "{\"role\":\"admin\",\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\"}"

# 上传角色（cookie 只用于页面会话；脚本上传直接用 Bearer）
curl -s -X POST localhost:8787/api/login -H 'Content-Type: application/json' \
  -d "{\"role\":\"upload\",\"password\":\"${UP_PW:-换成你的上传密码}\"}"
```

登录有 5 次/分钟/IP 的限速，连错会返回 `429 rate_limited`；零安装路径重启进程即清零。

---

## 5. 常用自检（curl）

```bash
curl -s localhost:8787/api/ping                       # {"ok":true}
curl -s localhost:8787/api/site | head -c 200         # 公开站点信息（不需要登录）
curl -s -X POST "localhost:8787/api/upload?name=a.avif" \
     --data-binary @assets/screenshots/upload.avif \
     -H "Authorization: Bearer $UPLOAD_TOKEN"          # {key,url,size,contentType,store}
curl -sI localhost:8787/file/<key> | head             # 200 + Cache-Control: immutable, no-transform
curl -s -H 'Range: bytes=0-99' localhost:8787/file/<key> | wc -c      # 100
curl -s -b cj.txt "localhost:8787/api/list?limit=5"   # thumbs/archived/items/cursor
curl -s -b cj.txt localhost:8787/api/stats
curl -s -b cj.txt localhost:8787/api/hf/status        # ready=false 表示 HF 没配
```

值得常跑的反向用例：`GET /file/.imghub/settings.json` → 404；未登录 `/api/list` → 401；第六次登录 → 429；不带 `Content-Length` 的上传 → 411；`storage` 选未配置的盘 → 400 `tg_not_configured` / `hf_not_configured`。

---

## 6. 试 HuggingFace 归档与「实验：仅 HuggingFace」

### 6.1 本地假网关（不碰真 HF）

```bash
node scripts/dev-local.mjs --hf
```

设置页会出现 HF 相关选项与「归档现有文件到 HuggingFace」，可完整验证：上传归档 → 状态卡数字 → 删除联动回收。

### 6.2 接真实 HuggingFace

1. HF 建私有 Storage Bucket（例如 `imghub-archive`）；
2. Settings → Access Tokens → 建 write 级 token（只授权该桶）→「Generate S3 credentials」拿 `HFAK…` 与 SK；
3. `.dev.vars` 里加四项：

```ini
HF_S3_ACCESS_KEY=HFAK...
HF_S3_SECRET=<上一步的 SK>
HF_NAMESPACE=<你的用户名或组织>
HF_BUCKET=imghub-archive
# 可选：HF_PREFIX=images、HF_ENDPOINT=https://<namespace>.s3.hf.co
```

4. 重启 → `node scripts/hf-s3-smoke.mjs --live` 验协议（见 §7）→ 设置页选「R2 + HuggingFace 归档」或「实验：仅 HuggingFace」→ 点「开始归档」。

### 6.3 状态与错误码

`GET /api/hf/status` 字段：`backed`（已归档）、`pending`（待归档，最多 200 个）、`queued`（失败待补）、`hfOnly`（实验主存里的文件数）、`files`/`bytes`/`quotaPct`（桶内用量，`partial` 表示没扫完）。

| 错误码 | 含义 |
|---|---|
| `hf_not_configured` | 四项配置没配齐 |
| `hf_quota` | 免费额度写满（上传返回 507），需要清理 |
| `hf_failed` | 存到 bucket 失败（网络/权限），看 Worker 日志 |

---

## 7. 冒烟脚本：`scripts/hf-s3-smoke.mjs`

```bash
node scripts/hf-s3-smoke.mjs          # 离线：拉 AWS 官方 SigV4 测试向量逐条比对（不需要密钥）
node scripts/hf-s3-smoke.mjs --live   # 联网：真往桶里写一个对象、读回来、删掉（要 HF_* 配置）
node scripts/hf-s3-smoke.mjs --live --keep   # 保留测试对象，方便去 HF 页面看一眼
```

`--live` 会逐项打印：PutObject 耗时、HeadObject、GetObject 是否跟随 302 到 CDN、Range 返回 206 还是 200、不存在的对象是否返回 null、**DeleteObject 是否真的回收**、ListObjectsV2 用量。它只依赖 Node 原生能力，不需要任何安装。

---

## 8. 常见问题

### 8.1 端口被占
`EADDRINUSE` → 换端口（`--port 8790`）或先停掉占用进程；服务方式启动的可以用 `o2ctl services stop <name>`。

### 8.2 页面能开，但压缩报错 / `public/vendor` 缺文件
浏览器端编码器不参与 Worker 构建，是运行时从 `public/vendor/` 取的：
- 标准路径：`npm run vendor`（或直接 `npm run dev`，它会先跑这一步）；
- 零安装路径：没有 `node_modules` 可复制，需要自行把 `@jsquash/avif`、`@jsquash/webp` 的 4 个文件放进 `public/vendor/`；缺了不影响上传，只是「压成 AVIF/WebP」不可用（会退回原图）。

### 8.3 `login` 一直 `bad_password`
九成是没传 `role: "admin"`（默认按 upload 角色校验）。见 §4。

### 8.4 改了 `.dev.vars` 没生效
两条路径都只在启动时读取，改完必须重启。

### 8.5 上传报 `411 empty_body`
接口要求真实 `Content-Length`：用 `--data-binary @file`，不要用 `-d`，也不要用 chunked 流。

### 8.6 Windows 上的路径
脚本里的路径都用 `node:path` 拼，不需要 `export`；`/tmp` 在 Git Bash 里可能不存在，临时文件请放 `$TEMP`。

### 8.7 数据什么时候会丢
- 标准路径：删 `.wrangler/state` 或换 `--persist-to` 目录；
- 零安装路径：进程一停就全丢；想保住就改用标准路径。

### 8.8 Node 版本太低
`fetch is not defined` / `crypto.subtle is undefined` → 升级到 Node 18+。

---

## 9. 改完代码怎么验证

仓库**没有**测试框架（无 vitest/jest、无 lint/typecheck、无 CI），按下面顺序手工验证：

1. **模块能加载**（最快的语法/引用检查）：

   ```bash
   node -e "for (const m of ['./src/index.js','./src/api.js','./src/serve.js','./src/huggingface.js','./src/telegram.js','./src/settings.js']) await import(m); console.log('ok')"
   ```

2. **HF 相关改动**：`node scripts/hf-s3-smoke.mjs`（离线向量）→ 有凭证再 `--live`。
3. **接口**：§5 的 curl 清单，含反向用例。
4. **UI**：真浏览器点一遍 —— 上传（压缩开/关）、`/admin` 列表/详情/删除、`/settings` 各面板。
5. **负路径**（改到这些区域时必跑）：`GET /file/.imghub/settings.json` → 404；跨域 Cookie `POST /api/delete` → 403 `bad_origin`；未登录 `/api/list` → 401；upload 角色删 24 小时前的图 → 403 `forbidden`；一分钟内第 6 次登录 → 429；无正文上传 → 411；`tg` 模式下用错 token → 502 `tg_failed`；`hf` 模式配额满 → 507 `hf_quota`。删除后 `/file/<key>` 必须几秒内全局 404（`gone` 名单）。

---

## 10. 本地文件清单

| 路径 | 是否提交 | 说明 |
|---|---|---|
| `.dev.vars` | 否（gitignore） | 本地密钥；从 `.dev.vars.example` 复制 |
| `public/vendor/` | 否（gitignore） | `npm run vendor` 生成的编码器 |
| `.wrangler/state/` | 否 | wrangler 的本地 R2/Cache 数据 |
| `scripts/dev-local.mjs` | 是 | 零安装预览运行时 |
| `scripts/hf-s3-smoke.mjs` | 是 | HF 签名与协议冒烟 |
