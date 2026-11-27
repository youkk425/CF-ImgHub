<p align="center">
  <img src="assets/banner.svg" width="100%" alt="CF ImgHub — 为个人博客打造的图床">
</p>

<h1 align="center">CF-ImgHub（个人自用 Fork · 无 R2 · Telegram/HuggingFace 存储）</h1>

<p align="center">
  这是 <a href="https://github.com/TG-Twilight/CF-ImgHub">TG-Twilight/CF-ImgHub</a> 的个人自用 Fork。<br>
  跑在 Cloudflare Workers 上，但<b>彻底移除了 R2</b>——图片字节存 Telegram（默认）或 HuggingFace，元数据进 Workers KV。
</p>

> 因为没钱绑R2 😭😭😭

> [!IMPORTANT]
> **这是我的个人自用副本，不打算维护，也不接受功能请求。** 想用这个图床、看完整文档或提 Issue / PR，请去**原项目**：
>
> ### 👉 https://github.com/TG-Twilight/CF-ImgHub
>
> 下面的内容只作为我自己部署时的备忘。我这份 Fork **把 R2 整个去掉了**（Cloudflare R2 开通要绑卡，我不想绑），改用 Telegram / HuggingFace 存字节 + Workers KV 存元数据。这是一次代码级重构，与上游的存储架构已经不同。


## 这个 Fork 的看点：彻底去掉 R2

上游把图片存在 Cloudflare R2，元数据（设置、清单、缩略图）也一并塞在 R2 桶里。但 **R2 开通必须给 Cloudflare 绑一张卡**，我不想绑——所以我把 R2 从代码里整个移除了，换成：

- **图片字节**：存 Telegram 频道（默认，免对象存储）或 HuggingFace Storage Buckets（可选）。
- **元数据**（设置、图片清单、缩略图、删除名单）：存 **Workers KV**——免绑卡、Workers 原生、免费额度对图床绰绰有余。

存储模式在设置页三选一（默认 `tg`）：

| 模式 | 字节存哪 | 说明 |
|------|------|------|
| `tg`（默认） | Telegram 频道 | 不占对象存储；未缓存时首次打开慢 0.5–3 秒；单文件上限 100 MB |
| `tg+hf` | Telegram + HuggingFace | 主存 TG，另归档一份到 HF 容灾；主存丢时可从归档读回 |
| `hf`（实验） | HuggingFace bucket | 字节只进 HF；Worker 代读（HF 读上限约 16 次/秒），单文件上限 30 MB；应用内按 100 GB 软阈值（`HF_QUOTA`）判断，超了上传报 `hf_quota`（HF 平台自身计费以官方政策为准） |

> [!WARNING]
> `hf` / `tg+hf` 的 HF 部分是上游标注的**实验**能力：Worker 代读、无边缘直链、稳定性不如对象存储。我只在低流量、图不大的个人博客上用；**生产、大图、高并发请用回带对象存储的方案**。完整权衡见 `docs/Huggingface-主存代价分析.md`、`docs/重构方案-移除R2.md`。

## 关于这个 Fork

- **用途**：只为我自己的博客服务，不对外提供图床。
- **与上游的关系**：这是一次**代码级重构**，存储架构与上游已经不同，不再能平滑 Sync fork。核心功能（压缩、实况/HDR、防盗链、身份）仍跟随上游设计。
- **为什么去掉 R2**：Cloudflare R2 开通要绑卡。用 Telegram + KV 组合可以完全免绑卡跑起来。

## 上游功能速览

以下均为原项目能力，详细说明见上游 README。

- **快**：图片从 Cloudflare 边缘返回，先查缓存、未命中读存储，无数据库。
- **浏览器本地压缩**：上传前在浏览器压缩，默认转 AVIF，可选 WebP / JPEG / PNG 或不压缩；压完变大时自动用原图。
- **实况照片与 HDR**：识别 Motion Photo / O Live 与 Ultra HDR 增益图，按档位精简或重压，服务器从不改动文件字节。
- **两种身份**：上传者凭密码上传、可撤回 24 小时内的上传；管理员可浏览、搜索、批量删除、改设置。
- **防盗链、易读文件名、多域名、主题色、去除 GPS** 等均在设置页调整。

## 我的部署备忘

<details>
<summary>展开（仅自用记录，通用步骤请看上游）</summary>

准备：一个 Cloudflare 账户（免费版即可）、一个 GitHub 账户、一个 Telegram 账户（默认存储要用）；想用 HuggingFace 备份再额外准备一个 HF 账户；要用自己的域名需托管在 Cloudflare。**全程不需要给 Cloudflare 绑卡。**

部署要填 5 个基础密钥：

| 名称 | 填什么 |
|------|------|
| `SESSION_SECRET` | 随机长字符串，用来签名登录会话 |
| `UPLOAD_PASSWORD` | 上传页的密码 |
| `ADMIN_USER` | 管理页的账号 |
| `ADMIN_PASSWORD` | 管理页的密码 |
| `UPLOAD_TOKEN` | 脚本上传用的 Token |

1. 从**上游** Fork 一份到自己的 GitHub，再把本 Fork 的改动（去掉 R2 的那批文件）套用过去——或者直接用我这份
2. Cloudflare 控制台 →「Workers 和 Pages」→「创建」→「导入存储库」，选仓库
3. 项目名 `cf-imghub`（与 `wrangler.jsonc` 的 `name` 一致），构建命令 `npm run build`，部署命令 `npx wrangler deploy`
4. **建 KV 命名空间**（存元数据，替代原来的 R2）：控制台 →「Workers 和 Pages」→「KV」→「创建命名空间」，名字随意（如 `imghub-meta`），把它的 **ID** 填进 `wrangler.jsonc` 的 `kv_namespaces` 里 `META` 的 `id`
5. 部署后到「设置」→「变量和机密」，按上表逐个添加（类型选「密钥」），再点「部署」

### 开启 Telegram 存储（默认）

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather) → `/newbot`，拿到 bot token
2. 新建一个**私有频道**，把 bot 加进去当管理员（要能发消息、删消息）
3. 频道的 `chat_id`（形如 `-100…`）可在频道里发条消息后，用 `https://api.telegram.org/bot<token>/getUpdates` 查看
4. 到 Worker 的「变量和机密」添加 `TG_BOT_TOKEN`（bot token）和 `TG_CHAT_ID`（频道 id）
5. 打开 `https://<你的域名>/settings`，在「存储」里选「仅 Telegram」（默认已选）

### 可选：加 HuggingFace 备份（`tg+hf` 或 `hf`）

1. HF → 头像 → Settings → **Storage Buckets**，建一个私有桶，例如 `imghub-archive`（⚠️ 必须是 **Storage Bucket**，不是 Dataset —— 数据集仓库不能用 S3 接口存图）
2. Settings → Access Tokens → 新建 write 级 token（勾选对应桶）→「Generate S3 credentials」，记下 `HFAK…` 和 SK（SK 只显示一次）
3. 到 Worker 的「变量和机密」添加：

   | 名称 | 类型 | 值 |
   |------|------|----|
   | `HF_S3_ACCESS_KEY` | 密钥 | 第 2 步的 AK |
   | `HF_S3_SECRET` | 密钥 | 第 2 步的 SK |
   | `HF_NAMESPACE` | 文本 | 你的 HF 用户名或组织名 |
   | `HF_BUCKET` | 文本 | 第 1 步的桶名 |

4. 打开 `https://<你的域名>/settings`，在「存储」里选「Telegram + HuggingFace 归档」或「实验：仅 HuggingFace」

以后更新：这是个人 Fork，存储架构与上游不同，**不能直接 Sync fork**；要跟上游更新得手动合并。

可选：绑定自定义域名（`workers.dev` 读不到边缘缓存）。


</details>

## 授权

沿用上游许可：[AGPL-3.0-or-later](LICENSE)。图标来自 [Material Icons](https://github.com/google/material-design-icons)（Apache-2.0）；浏览器端编码器来自 [jSquash](https://github.com/jamsinclair/jSquash)（Apache-2.0），视频处理用 [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0），均在构建时复制，不在仓库中。

所有功能与设计版权归上游作者，感谢 [TG-Twilight](https://github.com/TG-Twilight) 的原创工作。
