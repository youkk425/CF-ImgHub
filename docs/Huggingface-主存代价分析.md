# HuggingFace 作为「主存储」的代价分析（CF-ImgHub）

> 配套文档：`docs/Huggingface-集成方案.md`。本文回答一个问题：**HF 能不能不当备份、直接当图片的主存储？**
> 结论先行：**只有 Storage Buckets（路线 B）有讨论资格，且"更省钱"这个动机不成立**；技术上可行但会把站点的可用性、可审计性与 ToS 风险全押到一个没有对象存储 SLA 的平台上。若要试，走 §6 的"实验模式"而不是直接切主存。
> 标记：`[官方]` 明文 / `[实测]` 本机验证 / `[需核实]` M0 冒烟确认。

## 1. 为什么路线 A（Git 仓库）没有资格

| 致命点 | 事实 | 出处 |
|---|---|---|
| 读必须带 token | 私有仓库 `resolve/` 不支持匿名，也没有预签名 URL 概念 ⇒ **每一个字节都要过 Worker 代读** | `[官方]` + `docs/Huggingface.md` §5.6「临时外链：不支持签名」 |
| 删除不回收空间 | 删 LFS 指针不删对象，历史仍引用；清理要联系支持且最长 36 h | `[官方]` repositories-recommendations |
| 写入模型不对 | 每次上传 = 一次 git commit；官方原话"a git repository is not meant to work as a database with a lot of writes"，数千 commit 后网页/clone 体验退化 | `[官方]` |
| 目录硬上限 | 每目录 ≤10 k 文件，超了 `git add` 直接失败（分月可绕） | `[官方]` |
| 速率 | 免费档 Hub API **1 000 次/5 min**、Resolvers **5 000 次/5 min** ⇒ 读上限 ≈ 16 次/秒 | `[官方]` rate-limits |

⇒ 路线 A 只能当**归档盘**（低频读、允许只写不改）。主存场景不必再评估。

## 2. 路线 B 的三种服务形态（成本结构差别极大）

签名算法是 SigV4，在 Worker 里用 WebCrypto 手写约 60 行；**预签名 GET 可以纯本地算出来（不发任何请求）**，这一点决定了 P2 的性价比。`[官方]` 预签名 GET/PUT 均支持，有效期最长 7 天。

| 形态 | `/file/<key>` 的链路 | 过 Worker 的字节 | 子请求/请求 | 首字节额外延迟 | 备注 |
|---|---|---|---|---|---|
| **P0 仅备份**（集成方案的默认） | Cache → R2（HF 完全不参与） | 0 | 0 | 0 | 冷兜底时才 302→CDN 代读 |
| **P1 主存 + 代读** | Cache miss → `GET s3.hf.co/...`（302 自动跟到 CDN）→ 转发 | **1×全站流量** | 2 | +2 RTT | 防盗链/鉴权完全可控；HF 凭证不出 Worker |
| **P2 主存 + 预签名 302** | 302 到 `?X-Amz-Signature=…` → 网关再 302 → HF CDN | **0** | 0 | +3 RTT | Workers 不吐带宽，但见下面的坑 |

P2 的三个坑（不是否决项，但必须写进设计）：
1. **预签名 URL 会暴露给访客**（浏览器历史、控制台、Referer 链、第三方图床抓取），在有效期内（最长 7 天）等于一条无鉴权直链；防盗链形同虚设。实用折中：有效期设 5–15 min，本站 302 的 `Cache-Control` TTL **必须显著短于**有效期，否则边缘缓存会长期供应过期链接 ⇒ 图片集体挂掉。`[安全]`
2. 现有 `serve.js` 的 `public, max-age=31536000, immutable, no-transform` 一年缓存策略在 P2 下不成立，整条缓存语义要重写（P1 仍可缓存字节，但要实测 Range 透传）。
3. `Content-Disposition` / `Cache-Control` 是 bucket 唯一支持的元数据 ⇒ 本项目的 `customMetadata.name`（原文件名）**存不进 bucket**。要么塞 `Content-Disposition`（但 `ListObjectsV2` 不返回它，管理页得逐对象 HEAD，1 万张图 = 1 万次请求），要么每张图再写一个 `.meta/<key>.json` 小对象（PUT 翻倍，Class A 语义），要么接受管理页只显示 key。这是"用 HF 替掉 R2"最实质的功能倒退。

## 3. 与 R2 的逐项对照（`[官方]` 定价已核对）

| 维度 | R2（现状） | HF Storage Bucket | 谁赢 |
|---|---|---|---|
| 免费存储 | 10 GB-month/月 | 私有配额免费 **100 GB**（bucket 是否同额度 `[需核实]`，页面 <https://huggingface.co/storage>） | HF（10×） |
| 超出单价 | **$0.015/GB·月 = $15/TB·月** | 私有档 **$18/TB·月**（200 TB+ 才降到 $12–14） | **R2 更便宜** |
| 请求费 | Class A 100 万免费、$4.5/M；Class B 1000 万免费、$0.36/M | 未公开计价（含在 TB 价内）`[需核实]` | R2 透明 |
| 出口流量 | **免费**（CF 明文"R2 不收费 egress"） | 宣传"零出口费 + 内置 CDN"（Team/Enterprise 明文 8:1 公平使用比） | 平 |
| 边缘/大陆可达 | 本站域名走 Cloudflare，路径成熟 | CDN 主机 `cdn-lfs*.hf.co`、`cas-bridge.xethub.hf.co` **本机实测可达（403）**；但 `huggingface.co` 主站本机 8 s 超时 ⇒ 桶的网页浏览/建仓入口不通 | R2 |
| 自定义元数据 | ✅ customMetadata（当前 `name`、`tg:'1'`、`size` 都靠它） | ❌ 丢弃 `x-amz-meta-*` | R2 |
| 条件请求 | ✅ `onlyIf`（serve.js 用它做 304） | ❌ `If-None-Match` / `If-Match` 明确不支持 | R2 |
| 版本 / 复制 / 生命周期 | 有对象锁、Sippy 等 | 明确无版本、无生命周期、无跨区复制 | R2 |
| 对象存储 SLA / 耐久承诺 | 有 | 无（Hub 是 AI 内容平台，不是存储云） | R2 |
| 人工浏览归档 | 无 UI | ✅ 网页可直接点开看（公开桶）/需登录（私有） | HF |
| 一致性 | 强一致读 | Xet 后端，读写一致；multipart 未完成的分片 7 天自动清理 | 平 |

**结论 3.1（钱）**：想用 HF 替 R2 "省钱"，只在 **≤100 GB 且不想绑卡** 这一段成立。一旦超过免费额度，HF 私有档（$18/TB）比 R2（$15/TB）贵 20%，还多出 P2 的架构复杂度。图床真到大流量，R2 的零出口 + 边缘缓存是硬优势。
**结论 3.2（功能）**：bucket 不支持自定义元数据与条件请求 ⇒ `upload` 的 `customMetadata.name`、`serve.js` 的 `onlyIf`/304、`isStub` 占位对象三个既有机制都得重做。**"去掉 R2"做不到**：`.imghub/settings.json`（30 s 内必须低延迟读、可覆写）、`.thumb/`、`gone` 名单仍要 R2。所以"HF 主存"的真实形态只能是：**大对象进 HF，元数据/缩略图/设置留在 R2**——省的是 R2 的存储字节，不是 R2 本身。

## 4. 网络实测（本机 2026-11-26，无代理；8 个常见本地代理端口均关闭）

| 目标 | 结果 | 含义 |
|---|---|---|
| `huggingface.co` | 连接超时（DNS 正常解析） | Hub 网站 + `/api/*` + `resolve/` + git/LFS batch 端点全部不可达 ⇒ **路线 A 本机无法冒烟** |
| `hf-mirror.com` | 200；`POST /api/datasets/…/commit/main` 返回 HF 原样 JSON `{"error":"Invalid username or password."}` | 镜像**确实代理了 Hub API**；但把 write token 交给第三方镜像 = 不可接受，最多用一次性仓库 + 用后即吊销的 token 验证连通性 `[安全]` |
| `s3.hf.co` | 403 `<Error><Code>AccessDenied</Code><Message>Signature is required</Message></Error>` | **S3 网关可达且讲标准 S3** ⇒ 路线 B 可在本机用零依赖 Node 脚本完整冒烟（含建仓：S3 `CreateBucket` 即可，不需要 HF 网站） |
| `cdn-lfs.hf.co` / `cdn-lfs-us-1` / `cdn-lfs-eu-1` / `cas-bridge.xethub.hf.co` | 均 403 | HF 的 CDN 域名在本机可达 ⇒ P2「302 给访客直连 HF CDN」在大陆网络下**有戏**（仍需实测带 Range 的真实对象） |
| `api.cloudflare.com` | 301 | 可用 REST 直接部署 Worker（无需本机装 wrangler，符合"不许装东西"的约束） |

⇒ **这条实测把选型基本定了**：A 连本地验证都做不了，B 可以。M0 的执行方式随之改变，见集成方案 §M0。

## 5. 风险矩阵

| 风险 | P0 备份 | P1 代读主存 | P2 预签名主存 |
|---|---|---|---|
| HF 限流/故障 = 图片挂 | 否（仅冷兜底） | **是** | **是**（且表现成访客侧随机失败，排障更难） |
| S3 网关的速率上限 | 几乎碰不到 | 未公开 `[需核实]`；Hub API 是 1 000/5 min 免费，网关是否同档未知 | 同左（本站只发 302，读由访客发起，**本站侧不受速率限制**——这是 P2 最大的优势） |
| 直链外泄 / 盗链 | 无 | 无 | **有**（有效期内 presigned = 无鉴权直链） |
| 配额打满 | 备份跳过 | **上传直接失败** | 同左 |
| ToS 灰区（免费额度是给"对社区有用"的内容） | 低 | **高**（大量个人图 + 对外服务流量） | 高 |
| 删除语义 | 不回收(A)/回收(B) | ✅ 立即回收 | ✅ |
| 人工取回/迁移成本 | 低 | 中 | 中 |

## 6. 建议路径（要试主存的话，这样做）

1. **底座按 B 路线建**（`src/huggingface.js`：SigV4 + PutObject/GetObject/ListObjectsV2/DeleteObject + 预签名），先以 **P0 备份**形态上线，风险为零、立刻可用。
2. 加一个**非默认**的 `storage: 'hf'` 枚举值 + 一个 `cacheBucket` 开关，语义是"**HF 权威 + R2 只读缓存**"：
   - 写：`PutObject` 成功才算上传成功（`.meta` 与缩略图仍在 R2）；
   - 读：R2 命中直接回；未命中 → P1 代读并 `waitUntil` 回写 R2（read-through cache），P2 作为可选加速（`?via=direct` 才启用，便于 A/B 对比）；
   - 只在**一个测试域名**（`wrangler.jsonc` 的 `domains` 设置里新增一条）上开，存量图不迁移。
3. 观察两周：`/api/hf/status` 里记录 P50/P95 代读延迟、429 次数、配额百分比。**只有这三项都健康**，再谈把新上传默认指向 HF。
4. 永远不做：把 HF 当唯一存储（见结论 3.2）、公开桶当免费 CDN（`docs/Huggingface.md` §11 的合规口径 + HF 的滥用治理）。

## 7. 一句话给决策

> **要"更大免费空间 + 多活"，选 B 路线的 P0 备份，今天就够；要"替掉 R2 省钱"，数据不支持（$18/TB vs $15/TB），还会丢掉 customMetadata、条件请求和 R2 边缘缓存。** 真在意大陆侧成本与可达性，P2 预签名是唯一有趣的方向，但它把防盗链换成 7 天有效期的无鉴权直链，需要你先接受这笔交换。
