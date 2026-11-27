# CF-ImgHub 接入 HuggingFace 存储：方案（待审，未动代码）

> 前置阅读：`docs/Huggingface.md`（HF 协议通用指南）与 `docs/Huggingface-主存代价分析.md`（HF 能否当主存的成本/风险测算）。本文只写"落到本项目"的部分：选型、硬限制、改动点、里程碑、风险。
> 可信度标记沿用那份文档：`[官方]` 官方明文 / `[实测]` 我在本机或本仓库验证过 / `[推断]` 需上线前自验。

## 1. 结论

1. **HF 只当"第三备份盘"，与 Telegram 平级，不做主存。** 图床要的是"公开可外链 + 边缘缓存 + 删除即失效"，HF 私有仓库/桶三条都给不了（读必须带 token，只能由 Worker 代读）。放在 `r2 → tg 备份 → hf 备份` 的读路径末端，正好和现有 `.tg/` 机制同构，改动面最小。`[实测]` 现有代码已经是这个形状（`src/telegram.js` + `src/serve.js:108` + `src/api.js:205`）。
2. **协议路线有两条，建议先冒烟再定，倾向 B：**
   - **A｜私有 dataset 仓库**（`docs/Huggingface.md` 那条：NDJSON commit + Git LFS batch）。认证只要一个 Bearer token，零签名代码；但**删除文件不会释放空间**（git 历史仍引用），且每次备份 = 一次 commit，与"图床会反复增删"天然冲突。`[官方]` HF 自己写了"git 仓库不是用来大量写入的数据库"。
   - **B｜Storage Buckets**（HF 2025 年底新出的 S3 兼容对象存储，非版本化、可变）。语义上就是"小号 R2"：**删除立即永久释放空间**、有 ListObjects/分片上传/预签名 URL、支持 `Content-Type`。代价是在 Worker 里手写 SigV4（约 60 行 WebCrypto，零依赖，符合"src/ 不引依赖"的规矩），并且**不支持自定义 metadata**（`x-amz-meta-*` 不落库），所以备份清单必须像现在一样存在 R2 的 `.hf/<key>` 里。`[官方]` <https://huggingface.co/docs/hub/storage-buckets-s3>
   - 两条路线共用同一套 sidecar / 读路径 / 设置 / 状态端点：**先定框架，后端可换**。M0 冒烟就是为了在这两者之间做决定。
3. **本方案要求 Workers Paid + HF 免费额度即可起步。** 免费计划的 CPU 是 **10 ms/请求**，而算 SHA-256 是计入 CPU 的（CF 文档举例"给 R2 大文件算哈希可能超过 30 s CPU"）；`ctx.waitUntil` 在响应后只延长 **30 s**（与套餐无关）。`[官方]` 本项目已经在用 Ratelimits 绑定，本来就在付费计划上。

## 2. 与现状的对照（HF 按 Telegram 的既有形状接入）

| 角色 | 现有 Telegram | HuggingFace 新增 |
|---|---|---|
| 模块 | `src/telegram.js` | `src/huggingface.js`（新） |
| 就绪判断 | `tgReady(env)` = token+chat | `hfReady(env)` = `HF_TOKEN`+`HF_REPO` |
| 备份清单 sidecar | 主桶 `.tg/<key>` | 主桶 `.hf/<key>` |
| 写 | 流式 multipart，19 MiB 分片 | 路线 A：buffer → sha256 → LFS batch → commit；路线 B：PutObject（可流式） |
| 读回 | `fromBackup()` 找不到 R2 时按清单去 tg 取 | 同函数再往后接一层；清单缺失时按确定性路径直接 HEAD |
| 删除 | 删消息（尽力而为） | A：`deletedFile` commit（**空间不回收**）；B：DeleteObject（真回收） |
| 状态/补备份 | `GET /api/tg/status`、`POST /api/tg/backup` | `GET /api/hf/status`、`POST /api/hf/backup` |
| 失败码 | `tg_failed` / `tg_not_configured` | `hf_failed` / `hf_not_configured` |
| 占位对象模式 | `tg` 模式：R2 存清单，`customMetadata.tg='1'` | 路线 A 不做（删除不回收）；路线 B 可选，见 §8 |

## 3. 已查证的硬限制（决定设计的那些数字）

### HF 侧 `[官方]`

| 项 | 值 | 出处 / 对本项目的含义 |
|---|---|---|
| 私有存储免费额度 | **100 GB**（个人/组织免费档）；PRO 1 TB + $18/TB/月 | storage-limits。单张压缩图 300 KB ⇒ 约 30 万张封顶；必须做配额熔断 |
| Hub API 速率（5 分钟窗口） | 免费 **1 000 次 / 5 min**（PRO 2 500） | rate-limits。一次备份 ≈ 2–4 次 API（batch / commit / list）⇒ **免费档实际约 250–500 张/5 min**，批量补备份必须限流 |
| Resolve（读）速率 | 免费 **5 000 次 / 5 min** | 读回兜底路径几乎碰不到；但 hf-only 主存会被这个卡死 → 进一步印证"只当备份" |
| 每目录文件数 | **≤10 k 是硬上限**（超了 `git add` 直接失败） | repositories-recommendations ⇒ 路径必须按 `YYYY-MM` 分桶 |
| 单仓库文件数 | 建议 <100 k | 同上；配合上面的配额，规模量级一致 |
| 单次 commit 文件数 | 建议 ≤100（>50–100 推荐拆多个 commit，push 有 60 s 服务端超时） | 一次备份单文件 commit；**批量补备份要合并 commit**（省速率、省历史） |
| commit 频率 | "a git repository is not meant to work as a database with a lot of writes"，数千 commit 后网页/clone 体验退化 | 需要定期 `super_squash_history` 压缩历史（不可逆，本地要重 clone） |
| 删除语义 | 删指针**不释放 LFS 空间**，除非历史不再引用；历史里被删的文件要联系支持清理，最长 36 h | 路线 A 的致命项：备份盘只涨不消 ⇒ 要么按月份整仓重建，要么选路线 B |
| Xet 与 LFS | 新仓库默认 Xet，但**非 Xet 客户端仍走标准 Git LFS 上传路径**，服务端后台自动迁移；指针格式不变 | `docs/Huggingface.md` §4 的流程今天依然有效，**不要**在 `transfers` 里请求 `xet` |
| Buckets 兼容性 | 只认 path-style；region 固定 `us-east-1`；支持 `Content-Type` / `Content-Encoding` / `Cache-Control` / ACL；**`x-amz-meta-*` 不存储**；`GetObject` 返回 302 到 HF CDN 边缘；AK 形如 `HFAK…`，SK 就是 `hf_…` token | 决定：清单存 R2、fetch 必须跟随重定向（默认会）、Range 支持需实测 |
| Buckets 权限 | 仓库/桶可为 private / restricted / public | 若 public 桶能给出稳定直链，才有资格谈"当主存/CDN"，见 §8 待验证项 |

### Cloudflare Workers 侧 `[官方]`

| 项 | 值 | 含义 |
|---|---|---|
| 外部子请求数 | 免费 **50/请求**；付费默认 **10 000**（`limits.subrequests` 可提） | 单张备份 2–4 次外呼没问题；**批量补备份**要按预算切块 |
| CPU | 免费 10 ms；付费默认 30 s，可 `limits.cpu_ms` 提到 300 000 | 路线 A 的 sha256 计费；30 MB 约几百 ms，安全 |
| 内存 | 128 MB | 路线 A 需要 buffer 整个文件 ⇒ 单文件熔断设 **30 MB**（live photo/HDR 原图会接近这条线） |
| `waitUntil` | 响应后最多延长 **30 s** | 备份全流程必须塞进 30 s：所以**大文件直接跳过、留 pending 给补备份任务** |
| Cron Trigger | 单次最长 15 min | 补备份/配额巡检放 cron（见 §7） |

### 网络侧 `[实测]`

**本机（无代理，8 个常见本地代理端口全关）实测，2026-11-26：**

| 目标 | 结果 | 含义 |
|---|---|---|
| `huggingface.co` | 连接超时（DNS 正常） | Hub 网站 + `/api/*` + `resolve/` + git/LFS batch **全不可达** ⇒ 路线 A 本机无法冒烟 |
| `s3.hf.co` | 403 `AccessDenied / Signature is required` | **S3 网关可达且讲标准 S3** ⇒ 路线 B 可在本机零依赖冒烟，连建仓都能走 S3 `CreateBucket`（不必上 HF 网站） |
| `cdn-lfs.hf.co`、`cdn-lfs-us-1`、`cdn-lfs-eu-1`、`cas-bridge.xethub.hf.co` | 均 403 | HF 的 CDN 域名在本机可达（对"主存 + 预签名直连"是有利信号） |
| `hf-mirror.com` | 200，且 `POST /api/datasets/…/commit/main` 返回 HF 原样 JSON | 镜像确实代理了 Hub API；但**不许把 write token 交给它**，最多用一次性仓库 + 用后即吊销的 token 验连通 `[安全]` |
| `api.cloudflare.com` | 301 可达 | 可用 Cloudflare REST 直接部署 Worker，无需本机装 wrangler（符合"不许安装东西"的约束） |
- 生产读路径不受影响：访问 HF 的是 CF 边缘，访客永远只连本站；HF 不可达时仍能命中 Cache API 或回落 R2。
- **不要把 `HF_BASE_URL` 指向第三方镜像跑生产**：token 会发给非官方主机。只允许在冒烟脚本里用，代码里对"带 token 且 base 非 huggingface.co / 非 s3.hf.co"打 warning。

## 4. 设计

### 4.1 配置与密钥

```
HF_TOKEN              secret   write 级 fine-grained，只授权该仓库（路线 A）
HF_REPO               secret   avalon/imghub-archive（路线 A：namespace/name）
HF_S3_ACCESS_KEY      secret   HFAK…（路线 B：HF 设置页对 access token「Generate S3 credentials」）
HF_S3_SECRET          secret   路线 B 的 SK（由 HF token 派生，同样按密钥对待）
HF_BUCKET             var/secret  路线 B 的桶名（namespace 在 endpoint 里，桶名不含 /）
HF_ENDPOINT           var（可选）  默认 https://s3.hf.co/<namespace>；区域固定 us-east-1
HF_REPO_TYPE          var（可选）  dataset|model|space|bucket；缺省时探测并缓存（仅路线 A）
HF_PREFIX             var（可选）  仓库/桶内顶层前缀，默认 images
```
路线 B 需要两个密钥对（AK/SK），比路线 A 多一个；AK/SK 的权限等于那个 access token 的权限，所以**必须**是单仓库/单桶范围的 write token。
本地写进 `.dev.vars`（`.dev.vars.example` 加注释）；`wrangler.jsonc` 的 `cloudflare.bindings` 文档块与 README 的 secrets 表同步补一行。**部署面板路线**（fork + dashboard）也要在 Variables & Secrets 里加，README ×3 语言都要写。

`hfReady(env)`：路线 A 看 `HF_TOKEN && HF_REPO`，路线 B 看 `HF_S3_ACCESS_KEY && HF_S3_SECRET && HF_BUCKET`；未配置时**不发请求、不打日志**（与 `tgReady` 一致），上传主链路零影响。`src/index.js` 的 cron 分支只在 `hfReady` 时执行。

### 4.2 设置模型（已定：保留枚举，不拆字段）

沿用现有单字段枚举，把新组合加进 `STORAGE_MODES`，避免动 UI 结构与迁移逻辑：

```js
export const STORAGE_MODES = ['r2', 'r2+tg', 'tg', 'r2+hf', 'tg+hf', 'r2+tg+hf', 'hf'];
// 解析：const [primary, ...backups] = mode.split('+')；primary 缺省 r2
```

- `storageMode(env)` 保持函数名与返回字符串（改动面最小），新增 `storagePlan(env)` 只做一行拆分：`{ primary, backups:Set }`；就绪判断改为逐 token 校验——含 `tg` 但 `!tgReady` 按现有行为降级成去掉 tg，含 `hf` 但 `!hfReady` 同理，两者都不剩就落回 `r2`。
- `POST /api/settings` 的校验从 `body.storage !== 'r2' && !tgReady` 扩成两路：未配置的 token 报 `tg_not_configured` / `hf_not_configured`。
- 前端 `settings.html` 仍是**一个 select**，只多几个 option（三语文案各加 4 个 option + 状态卡片）。
- `hf`（只存 HF、不留 R2）先不进 `STORAGE_MODES` 的默认候选：见代价分析 §3.2——bucket 不存 customMetadata、不支持条件请求，且 `.imghub/settings.json`、`.thumb/` 无论如何都要 R2。留到 M5 作为实验值，读路径要重写成"HF 权威 + R2 缓存"才开。

### 4.3 对象路径与清单

```
路线 A：images/<YYYY>/<MM>/<key>          # 按 keyTime() 的 UTC+8 分月，避开 10k/目录硬上限
路线 B：<key>  或同 A 分月（桶无目录限制，但人工浏览友好，仍分月）
```
- `<key>` 已由 `stdName()` / `sanitizeName()` 约束（无 `/`、无 `..`），拼路径前仍再过一次白名单 `[^A-Za-z0-9._-] → _`，并给解析不出时间的 key 兜底前缀 `images/unknown/`。`[安全]` 路径必须服务端拼接。
- 清单对象 `.hf/<key>`（主桶）内容：`{v:1, path, oid, size, ct}`，`httpMetadata` 原样带上（和 `.tg/<key>` 一样，读回时能还原 Content-Type / Content-Disposition）。
- 路线 A **必须用 NDJSON 的 `lfsFile` 键登记**（`docs/Huggingface.md` §4.4 写法 1），这样 HF 自动维护 `.gitattributes`；不要把指针文本当普通文件 commit，否则 `git clone` 的人拿到三行指针。
- 建仓时人工先提交 `README.md`（写明"本站图片归档，勿动"）与 `.gitattributes`，并把仓库确认 `private: true`；`/api/hf/status` 里断言 `private === true`，不是就告警。`[安全]`

### 4.4 写路径（挂在上传之后，不拖慢响应）

```js
// src/api.js upload()
if (plan.backups.has('hf')) {
  ctx.waitUntil(hfBackup(env, key).catch((err) =>
    console.warn(JSON.stringify({ event: 'hf-backup-failed', key, error: err.message }))));
}
```
`hfBackup(env, key)` 步骤：
1. `main.head(HF_SIDECAR + key)` → 已有就返回 `exists`；
2. `storesFor()` 找到对象；是 tg 占位对象 → 返回 `stub`（占位对象不备份，清单已经在 R2）；
3. `size > MAX_HF_BYTES`（默认 **30 MiB**）→ 返回 `skipped`，写一条 `.hfq/<key>`（待处理标记，供补备份/cron 看见），**不进内存**；
4. `bucket.get(key)` 取字节 → sha256（路线 A）→ LFS batch → `basic` 或 `multipart`（分片并发 ≤5，parts 按 partNumber 有序，分片 PUT **不带** Authorization）→ commit（`lfsFile`）；路线 B 直接 PutObject（流式，可先 multipart）；
5. 成功后 `main.put(HF_SIDECAR + key, manifest, { httpMetadata: obj.httpMetadata })`。

要点：
- **sha256 必须前置**（LFS 按 oid 寻址），所以路线 A 无法纯流式；`crypto.subtle` 不支持增量。两个可选优化，都不影响 MVP：分块手写增量 SHA-256（约 60 行）；或 `bucket.get(key, { checksums: true })` 直接读 R2 已存的校验和（`[需核实]` 流式 put 的对象 R2 未必有 sha256，实测后再决定）。
- 30 s `waitUntil` 预算：超时/失败一律留在 `.hfq/`，由补备份任务收尾；**绝不在上传请求里重试**。
- 去重红利：同一字节流第二次上传 batch 不返回 `actions.upload`，跳过 PUT 但仍要 commit（否则指针不落路径）。
- 并发：多 isolate 写同分支不同路径通常安全；同路径 last-write-wins。撞到 `parent commit … is not the current one` 就重读 tip 重试一次，仍失败留 `.hfq/`。

### 4.5 读路径

`src/serve.js serveFile()` 顺序变成：`gone → 防盗链 → Cache API → 各 R2 桶 → .tg 备份 → **.hf 备份** → legacy 回源`。

```js
const backup = await fromBackup(env, key, request, bg);   // tg
if (backup) return cacheAnd(backup);
const arch = await fromArchive(env, key, request, bg);    // hf：.hf/<key> 清单，缺清单则按确定性路径 HEAD 兜底
```
- 取回用 `GET {base}/{prefix}{repo}/resolve/{rev}/{path}` 带 Bearer，**跟随 302**（fetch 默认），把上游 `Content-Range`/状态码透传；`Range` 是否被 HF/CDN 支持列为 `[需核实]`，冒烟必测（live photo 的 MP4 尾、视频都要 Range）。
- 成功照旧 `maybeCache()` 写进 Cache API（一年 immutable）：HF 只在冷读时被打，读频几乎为 0。
- **清单缺失兜底**：路径是 `key` 的纯函数，直接 `HEAD resolve/<path>` 即可确认存在并取 `Content-Length`。这条同时修掉现有 tg 备份的一个隐患——`.tg/<key>` 与主数据同桶，R2 整桶丢失时备份索引也丢了。tg 侧也值得加同样兜底（M2 顺带做）。

### 4.6 删除联动

`removeKeys()` 现在收集 tg 的 message id 再删；加一路 hf：
- 路线 A：把 `.hf/<key>` 里的 path 收集起来，一次 commit 批量 `deletedFile`（≤100 个/commit），并在响应里如实报告"**已从索引移除，空间不会回收**"；
- 路线 B：`DeleteObject`（批量 DeleteObjects），立即回收。
- 无论哪条路线，**gone 名单与缓存清理逻辑不变**：对外仍是删除后数秒全球 404。GDPR/用户删除请求要覆盖归档前缀，写进运维文档。

### 4.7 状态与补备份

```
GET  /api/hf/status   → {ready, mode, repo, private, files, bytes, quotaPct, pending: [≤200 key]}
POST /api/hf/backup   → {keys:[…≤20]}  或 {all:true, limit:≤200}
```
- 全部 admin-only（沿用 `src/api.js:70` 那道唯一守卫），`sameOrigin()` CSRF 校验同现有写接口。
- 批量大小按 §3 的两条预算反推：HF 免费档 1 000 API/5 min、付费 10 000 子请求/请求 ⇒ **单次请求 ≤20 张**（每张 ≈3 次外呼），更多交给 cron。
- **合并 commit**：补备份走 `POST /api/hf/backup` 时，一个请求内把 ≤100 个文件攒进同一次 NDJSON commit（LFS 字节仍各自 PUT），比逐文件 commit 省速率、省历史。
- **cron 补偿（已定：要）**：`wrangler.jsonc` 加 `triggers.crons: ["0 */6 * * *"]`，`fetch` 里按 `url.pathname`/`cron` 事件分流到一个 `hfSweep(env)`：扫 `.hfq/` 标记 → 每批 ≤100 个文件合并成一次 commit（路线 A）/一次批处理（路线 B）→ 成功后删标记。cron 单次上限 15 min、外呼按 §3 预算切块；标记对象是 key 的纯函数，天然幂等，重复跑无害。设置页"补备份"按钮仍保留，用于立刻补。

### 4.8 常量（全部具名 + 注释写明"这是配额熔断，不是魔法数"）

```js
MAX_HF_BYTES      = 30 * 1024 * 1024   // 单文件上限：内存 128MB 与 waitUntil 30s 双重约束
MAX_INLINE_BYTES  = 5 * 1024 * 1024    // 路线 A 文本通道（清单/统计 JSON 快照才用）
LFS_PART_CONCURRENCY = 5               // 官方 SDK 同值
COMMIT_MAX_FILES  = 100                // 单次 NDJSON commit
BACKUP_BATCH      = 20                 // 单次 /api/hf/backup 文件数
REPO_TYPE_TTL     = 6 * 3600 * 1000    // 类型探测缓存（per-isolate）
HF_TIMEOUT        = 25 * 1000          // AbortSignal，给 waitUntil 留余量
```

### 4.9 错误码与前端文案

`hf_not_configured` / `hf_failed` / `hf_quota` / `hf_timeout`，只回代码，翻译进 `i18n.js` 的 `e_*`（三语）。管理页列表项加 `hf: true` 标记（与现有 `tg:` 并列），提示"此图仅存归档"。

## 5. 改动清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/huggingface.js` | **新增**：路线 B 为 `sigV4()` + `hfReady/hfPut/hfGet/hfStream/hfDelete/hfList/hfPresign` + 常量；路线 A 改为 `hfPut`（NDJSON+LFS）+ `probeRepoType` 缓存 | ~180 行（B，含 SigV4 约 60 行）/ ~220 行（A） |
| `src/api.js` | `upload()` 挂 waitUntil；`storagePlan()`；`backupKey` 泛化；`/api/hf/status`、`/api/hf/backup`；`removeKeys()` 加 hf 分支；`settingsOut()` 带 `hfReady` | +90 行 |
| `src/serve.js` | `serveFile()` 读序末端加 `fromArchive()`；占位/清单缺失兜底；Range 透传 | +50 行 |
| `src/settings.js` | `STORAGE_MODES` 扩到 7 个枚举值 + `storagePlan()` + `normalize` 逐 token 就绪校验 + 新 MAX 常量 | +15 行 |
| `wrangler.jsonc` | `HF_*` vars 与 bindings 文档块、`triggers.crons: ["0 */6 * * *"]`、（可选）`limits.subrequests` | +12 行 |
| `public/settings.html` / `settings.js` | storage select 增 4 个 option + HF 状态卡片（配额/已备份数）+「补备份」按钮 | ~90 行 |
| `public/i18n.js` | 三语各 ~25 个 key | ~75 行 |
| `public/admin.js` / `ui.js` | 列表 `hf` 标记、错误码 | ~20 行 |
| `.dev.vars.example`、`README.md` ×3、`AGENTS.md`、`docs/` 运维手册 | 密钥、设置、人工取回/按月清理/失败补偿流程 | 文档 |

`src/` 仍零运行时依赖；`_headers` 的 CSP 不用改（外呼在服务端）。

## 6. 里程碑（每步都可验证再进下一步）

| 阶段 | 内容 | 验收 | 工作量 |
|---|---|---|---|
| **M0 冒烟定路线** | `scripts/hf-s3-smoke.mjs`（零依赖 Node 27，只用全局 `fetch` + `crypto`）打 `s3.hf.co`：CreateBucket / PutObject / GetObject（跟 302、量 TTFB、测 Range、测 `x-amz-meta` 是否真被丢弃）/ ListObjectsV2 / DeleteObject 后体积是否回收 / 预签名 GET 在浏览器侧可达性。路线 A 因 `huggingface.co` 本机不可达，改由 Cloudflare REST 部署一个一次性 selftest Worker（或你挂代理后本机跑）验 NDJSON commit + LFS basic/multipart + `resolve` 读回 sha256 一致 | 一份 `docs/hf-smoke-<日期>.md`：A/B 各自通/不通、延迟与 Range 数据，据此定路线 | 0.5 d |
| **M1 写路径** | `hfReady`/`hfPut`/常量、设置模型迁移（含旧值兼容）、upload 挂 `waitUntil`、`hf_failed` 错误码 | 上传后 30 s 内 R2 有对象、HF 有文件、`.hf/<key>` 有清单；断 token 只留 warn 日志 | 1 d |
| **M2 读路径** | `fromArchive()` + 无清单兜底 + Range/HEAD + 缓存回填；顺手把 tg 的兜底补上 | 手删 R2 对象后 `/file/<key>` 仍 200（内容 sha256 一致）、二次请求命中边缘缓存 | 0.5 d |
| **M3 运维面** | `/api/hf/status`、`/api/hf/backup`（合并 commit）、设置页 UI、三语文案、stats 里的归档用量 | 管理页能看状态、能批量补 20 张、能看配额百分比 | 1 d |
| **M4 删除与文档** | 删除联动 + README ×3 + AGENTS.md + 运维手册 | 删一张图后 `/file` 全球 404、A 路线在 status 里体现"不回收"提示 | 0.5 d |
| **M5 可选** | `storage:'hf'` 实验模式（代价分析 §6 的"HF 权威 + R2 缓存"）、增量 SHA-256、公开桶/预签名直连 A/B、配额告警 | — | 之后另议 |

> M0 的前置动作（只有你能做）：建私有 dataset 仓库（路线 A 用）、生成 write 级 token、给该 token「Generate S3 credentials」拿到 `HFAK…`/SK，三项写进 `.dev.vars`（不要贴进对话）。若本机浏览器也连不上 HF，需在能出网的机器上建好。

## 7. 验收清单（照 `docs/Huggingface.md` §9 + 本项目 AGENTS.md §8 的手工风格）

- [ ] 不配 `HF_TOKEN`：`/api/ping`、上传、读图、管理页全部零变化，无多余日志。
- [ ] 配好后上传一张普通图：HF 仓库/桶里出现 `images/2026/11/<key>`，`.hf/<key>` 清单存在。
- [ ] 删掉 R2 原对象 → `/file/<key>` 仍 200 且 sha256 与原文件一致；带 `Range: bytes=0-1023` 得 206（不支持则记为已知限制）。
- [ ] 同一字节流上传两次到不同 key：第二次 batch 无 `actions.upload`，但两个路径都可读。
- [ ] > `MAX_HF_BYTES` 的文件：跳过 + `.hfq/` 标记，主链路照常返回链接。
- [ ] 故意写错 token：日志一行结构化 `event:hf-backup-failed` 含 repo 与状态码，**不含 headers/token**；对外仍是成功。
- [ ] 60 秒内连传 60 张（触发 HF 429 区间）：备份不阻塞上传，失败进 `.hfq/`。
- [ ] 路线 A：`git clone` + `git lfs pull` 拿到真实字节（验证 `.gitattributes`）。
- [ ] 删除：A 显示"索引已删、空间未回收"；B 显示体积真的下降。
- [ ] `/api/settings` 用旧值 `'r2+tg'` 仍能用；新值写坏的 `backup:['nope']` 被 `normalize` 丢掉。

## 8. 明确不做 / 待验证

**不做**
- ❌ 用 `x-amz-meta-*` 存 metadata（bucket 明确丢弃；名称只能进 `Content-Disposition` 或留在 R2）；
- ❌ 把 `HF_BASE_URL` / `HF_ENDPOINT` 指向镜像跑生产（token 外泄面）；
- ❌ 程序自动建/删仓库（`POST /api/repos/create` / `delete` 只写进运维文档，人工执行；桶可以走 S3 `CreateBucket`，但删除仍人工）；
- ❌ M0 之前就把 `hf` 设成主存（读必须代读、bucket 无限速明文、无对象存储 SLA）——先备份，后按代价分析 §6 实验。

**待 M0 验证（`[需核实]`）**
- `resolve/`（路线 A）与 `GetObject`（路线 B）是否支持 `Range`；302 目标域名在 CF 边缘是否稳定可达（本机已证 CDN 域名可达，边缘未证）。
- S3 网关的速率/配额上限是否沿用 Hub 的免费档 1 000 次/5 min（官方未明文），以及 ListObjectsV2 的翻页粒度。
- 桶的 private / restricted / public 三档各自的匿名读行为，public 桶的稳定直链格式（决定 P2 是否可行）。
- R2 `get(key, { checksums: true })` 能否直接拿到流式 put 对象的 sha256（能则路线 A 省掉整文件 hashing 的 CPU）。

## 9. 决策记录（2026-11-26 已定）

1. **路线：先跑 M0 冒烟再定 A / B。** 网络实测已把天平压向 B——`s3.hf.co` 本机可达、可零依赖完整自测，而路线 A 的全部端点在被阻断的 `huggingface.co` 上。
2. **角色：想试 HF 做主存。** 已单独立文测算代价：`docs/Huggingface-主存代价分析.md`。要点是「≤100 GB 免费额度内成立，超过后 HF 私有档 $18/TB 比 R2 $15/TB 更贵」+「bucket 不存 customMetadata、不支持条件请求，且设置/缩略图离不开 R2，所以 R2 去不掉」。落地顺序因此定为：**M1–M4 先以备份形态上线同一套 SigV4 底座，M5 再开实验性的 `hf` 主存（HF 权威 + R2 read-through 缓存）**。
3. **设置模型：保留单字段枚举**，`STORAGE_MODES` 加 `'r2+hf' | 'tg+hf' | 'r2+tg+hf'`（见 §4.2）。
4. **补备份：cron 要**，`0 */6 * * *` 扫 `.hfq/` 标记做补偿，设置页按钮保留用于立刻补（见 §4.7）。

需要你确认的唯一遗留项：M0 前置动作里的三项凭证（私有 dataset 仓库、write token、该 token 的 S3 credentials）由你在 HF 侧生成并写入 `.dev.vars`。
