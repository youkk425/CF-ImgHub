<p align="center">
  <img src="assets/banner.svg" width="100%" alt="CF ImgHub — 为个人博客打造的图床">
</p>

<h1 align="center">CF-ImgHub（个人自用 Fork · HuggingFace 主存）</h1>

<p align="center">
  这是 <a href="https://github.com/TG-Twilight/CF-ImgHub">TG-Twilight/CF-ImgHub</a> 的个人自用 Fork。<br>
  跑在 Cloudflare Workers 上，但图片字节<b>不进 R2，而是主存到 HuggingFace Storage Buckets</b>（实验模式）。
</p>

> [!IMPORTANT]
> **这是我的个人自用副本，不打算维护，也不接受功能请求。** 想用这个图床、看完整文档或提 Issue / PR，请去**原项目**：
>
> ### 👉 https://github.com/TG-Twilight/CF-ImgHub
>
> 下面的内容只作为我自己部署时的备忘。其中「HuggingFace 主存」是我这份 Fork 真正在用的玩法，其余功能说明和部署步骤都来自上游，随时可能过期。

<p align="center">
  <a href="https://github.com/TG-Twilight/CF-ImgHub/fork"><img src="assets/fork.svg" alt="到原项目 Fork 并部署"></a>
</p>

## 这个 Fork 的看点：HuggingFace 当主存

上游默认把图片存在 R2，HuggingFace（HF）只作为可选的**归档备份**。我这份 Fork 的核心玩法，是打开上游那个默认不选的「**实验：仅 HuggingFace**」模式，把 HF Storage Buckets 直接当成图片的**主存储**：

- **图片字节只进 HF bucket**，R2 里只留几百字节的清单和缩略图，管理页、统计、删除照常工作。
- **省下 R2 的存储与操作费用**：R2 不再堆图片本体，只承担设置和缩略图这点小数据。
- **白嫖 HF 的 100 GB 免费额度**当图床盘。

> [!WARNING]
> 上游明确把这档标为**实验**，代价要清楚：
>
> - 每次缓存未命中都要 Worker 代读 HF（HF 读上限约 16 次/秒、只认签名不认条件请求），**首屏比 R2 慢**。
> - 单文件上限 **30 MB**（Worker 内存限制）。
> - 100 GB 写满后上传直接报 `hf_quota`。
> - 行为可能随上游调整，稳定性不如 R2。

所以我只在自己这种低流量、图不大、想省 R2 钱的个人博客上用它；**正式生产、大图、高并发场景请老老实实用 R2**。完整的技术权衡见 `docs/Huggingface-主存代价分析.md`。

## 关于这个 Fork

- **用途**：只为我自己的博客服务，不对外提供图床。
- **与上游的关系**：默认跟随上游，靠 **Sync fork** 拉取更新；不做长期分叉，不改核心逻辑。HF 主存是上游已有的实验能力，我只是把它选成了自己的默认存储。
- **个性化改动**：只限于配置层面——存储桶名、密钥、域名、防盗链放行名单、主题色、存储模式等，都在 Cloudflare 面板和设置页里调，不落到代码里。
- **为什么不建议用我这份**：上游的 Fork 部署流程本来就是给「每人一份」设计的。想要 HF 主存，直接 Fork 上游、在设置页选「实验：仅 HuggingFace」即可，不需要经过我这份。

## 上游功能速览

以下均为原项目能力，详细说明见上游 README。

- **快**：图片从 Cloudflare 边缘返回，先查缓存、未命中读存储，无数据库、不绕第三方存储。
- **浏览器本地压缩**：上传前在浏览器压缩，默认转 AVIF，可选 WebP / JPEG / PNG 或不压缩；压完变大时自动用原图。
- **实况照片与 HDR**：识别 Motion Photo / O Live 与 Ultra HDR 增益图，按档位精简或重压，服务器从不改动文件字节。
- **两种身份**：上传者凭密码上传、可撤回 24 小时内的上传；管理员可浏览、搜索、批量删除、改设置。
- **防盗链、易读文件名、多域名、主题色、去除 GPS** 等均在设置页调整。
- **可选 Telegram 存储**：作为备份，或只存 Telegram 实现近乎无上限存储。
- **可选 HuggingFace 存储**：既可作 R2 的归档备份（`r2+hf`），也可像我这份一样选成主存（`hf`，实验）。

## 我的部署备忘

<details>
<summary>展开（仅自用记录，通用步骤请看上游）</summary>

准备：一个 Cloudflare 账户（免费版即可）、一个 GitHub 账户、一个 HuggingFace 账户；要用自己的域名需托管在 Cloudflare。

部署要填 5 个基础密钥：

| 名称 | 填什么 |
|------|------|
| `SESSION_SECRET` | 随机长字符串，用来签名登录会话 |
| `UPLOAD_PASSWORD` | 上传页的密码 |
| `ADMIN_USER` | 管理页的账号 |
| `ADMIN_PASSWORD` | 管理页的密码 |
| `UPLOAD_TOKEN` | 脚本上传用的 Token |

1. 从**上游** Fork 一份到自己的 GitHub（不要从我这份 Fork）
2. Cloudflare 控制台 →「R2 对象存储」→ 创建存储桶 `cf-imghub`（HF 主存下它只放清单和缩略图，仍需要）
3. 「Workers 和 Pages」→「创建」→「导入存储库」，选刚 Fork 的仓库
4. 项目名 `cf-imghub`（与 `wrangler.jsonc` 的 `name` 一致），构建命令 `npm run build`，部署命令 `npx wrangler deploy`
5. 部署后到「设置」→「变量和机密」，按上表逐个添加（类型选「密钥」），再点「部署」

### 开启 HuggingFace 主存

1. HF → 头像 → Settings → Storage Buckets，建一个私有桶，例如 `imghub-archive`
2. Settings → Access Tokens → 新建 write 级 token（勾选对应桶）→「Generate S3 credentials」，记下 `HFAK…` 和 SK（SK 只显示一次）
3. 到 Worker 的「变量和机密」添加：

   | 名称 | 类型 | 值 |
   |------|------|----|
   | `HF_S3_ACCESS_KEY` | 密钥 | 第 2 步的 AK |
   | `HF_S3_SECRET` | 密钥 | 第 2 步的 SK |
   | `HF_NAMESPACE` | 文本 | 你的 HF 用户名或组织名 |
   | `HF_BUCKET` | 文本 | 第 1 步的桶名 |

4. 打开 `https://<你的域名>/settings`，在「存储」里选「**实验：仅 HuggingFace**」

以后更新：在自己 Fork 的仓库点 **Sync fork** →「Update branch」，Cloudflare 会自动重新部署。

可选：绑定自定义域名（`workers.dev` 读不到边缘缓存）、改用 `r2+hf` / `r2+tg` 等组合——完整步骤见上游 README 的「部署」章节。

</details>

## 授权

沿用上游许可：[AGPL-3.0-or-later](LICENSE)。图标来自 [Material Icons](https://github.com/google/material-design-icons)（Apache-2.0）；浏览器端编码器来自 [jSquash](https://github.com/jamsinclair/jSquash)（Apache-2.0），视频处理用 [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0），均在构建时复制，不在仓库中。

所有功能与设计版权归上游作者，感谢 [TG-Twilight](https://github.com/TG-Twilight) 的原创工作。
