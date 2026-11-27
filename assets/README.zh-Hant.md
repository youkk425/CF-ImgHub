<p align="center">
  <img src="banner.zh-Hant.svg" width="100%" alt="CF ImgHub — 為個人部落格打造的圖床">
</p>

<h1 align="center">CF-ImgHub（個人自用 Fork · 無 R2 · Telegram/HuggingFace 儲存）</h1>

<p align="center">
  這是 <a href="https://github.com/TG-Twilight/CF-ImgHub">TG-Twilight/CF-ImgHub</a> 的個人自用 Fork。<br>
  跑在 Cloudflare Workers 上，但<b>徹底移除了 R2</b>——圖片位元組存 Telegram（預設）或 HuggingFace，元資料進 Workers KV。
</p>

> [!IMPORTANT]
> **這是我的個人自用副本，不打算維護，也不接受功能請求。** 想用這個圖床、看完整文件或提 Issue / PR，請去**原專案**：
>
> ### 👉 https://github.com/TG-Twilight/CF-ImgHub
>
> 下面的內容只作為我自己部署時的備忘。我這份 Fork **把 R2 整個去掉了**（Cloudflare R2 開通要綁卡，我不想綁），改用 Telegram / HuggingFace 存位元組 + Workers KV 存元資料。這是一次程式碼級重構，與上游的儲存架構已經不同。

<p align="center">
  <a href="https://github.com/TG-Twilight/CF-ImgHub/fork"><img src="fork.zh-Hant.svg" alt="到原專案 Fork 並部署"></a>
</p>

<p align="center">
  <a href="../README.md">简体中文</a> · <b>繁體中文</b> · <a href="README.en.md">English</a>
</p>

## 這個 Fork 的看點：徹底去掉 R2

上游把圖片存在 Cloudflare R2，元資料（設定、清單、縮圖）也一併塞在 R2 桶裡。但 **R2 開通必須給 Cloudflare 綁一張卡**，我不想綁——所以我把 R2 從程式碼裡整個移除了，換成：

- **圖片位元組**：存 Telegram 頻道（預設，免物件儲存）或 HuggingFace Storage Buckets（可選）。
- **元資料**（設定、圖片清單、縮圖、刪除名單）：存 **Workers KV**——免綁卡、Workers 原生、免費額度對圖床綽綽有餘。

儲存模式在設定頁三選一（預設 `tg`）：

| 模式 | 位元組存哪 | 說明 |
|------|------|------|
| `tg`（預設） | Telegram 頻道 | 不佔物件儲存；未快取時首次開啟慢 0.5–3 秒；單一檔案上限 100 MB |
| `tg+hf` | Telegram + HuggingFace | 主存 TG，另歸檔一份到 HF 容災；主存丟時可從歸檔讀回 |
| `hf`（實驗） | HuggingFace bucket | 位元組只進 HF；Worker 代讀（HF 讀上限約 16 次／秒），單一檔案上限 30 MB；應用內按 100 GB 軟閾值（`HF_QUOTA`）判斷，超了上傳報 `hf_quota`（HF 平台自身計費以官方政策為準） |

> [!WARNING]
> `hf` / `tg+hf` 的 HF 部分是上游標註的**實驗**能力：Worker 代讀、無邊緣直鏈、穩定性不如物件儲存。我只在低流量、圖不大的個人部落格上用；**生產、大圖、高併發請用回帶物件儲存的方案**。完整權衡見 `../docs/Huggingface-主存代價分析.md`、`../docs/重構方案-移除R2.md`。

## 關於這個 Fork

- **用途**：只為我自己的部落格服務，不對外提供圖床。
- **與上游的關係**：這是一次**程式碼級重構**，儲存架構與上游已經不同，不再能平滑 Sync fork。核心功能（壓縮、實況/HDR、防盜鏈、身分）仍跟隨上游設計。
- **為什麼去掉 R2**：Cloudflare R2 開通要綁卡。用 Telegram + KV 組合可以完全免綁卡跑起來。

## 上游功能速覽

以下均為原專案能力，詳細說明見上游 README。

- **快**：圖片從 Cloudflare 邊緣回傳，先查快取、未命中讀儲存，無資料庫。
- **瀏覽器本機壓縮**：上傳前在瀏覽器壓縮，預設轉 AVIF，可選 WebP / JPEG / PNG 或不壓縮；壓完變大時自動用原圖。
- **實況照片與 HDR**：識別 Motion Photo / O Live 與 Ultra HDR 增益圖，按檔位精簡或重壓，伺服器從不改動檔案位元組。
- **兩種身分**：上傳者憑密碼上傳、可撤回 24 小時內的上傳；管理員可瀏覽、搜尋、批次刪除、改設定。
- **防盜鏈、易讀檔名、多網域、主題色、去除 GPS** 等均在設定頁調整。


## 我的部署備忘

<details>
<summary>展開（僅自用記錄，通用步驟請看上游）</summary>

準備：一個 Cloudflare 帳戶（免費版即可）、一個 GitHub 帳戶、一個 Telegram 帳戶（預設儲存要用）；想用 HuggingFace 備份再額外準備一個 HF 帳戶；要用自己的網域需託管在 Cloudflare。**全程不需要給 Cloudflare 綁卡。**

部署要填 5 個基礎金鑰：

| 名稱 | 填什麼 |
|------|------|
| `SESSION_SECRET` | 隨機長字串，用來簽章登入工作階段 |
| `UPLOAD_PASSWORD` | 上傳頁的密碼 |
| `ADMIN_USER` | 管理頁的帳號 |
| `ADMIN_PASSWORD` | 管理頁的密碼 |
| `UPLOAD_TOKEN` | 腳本上傳用的 Token |

1. 從**上游** Fork 一份到自己的 GitHub，再把本 Fork 的改動（去掉 R2 的那批檔案）套用過去——或者直接用我這份
2. Cloudflare 控制台 →「Workers 和 Pages」→「建立」→「匯入儲存庫」，選儲存庫
3. 專案名 `cf-imghub`（與 `wrangler.jsonc` 的 `name` 一致），建置命令 `npm run build`，部署命令 `npx wrangler deploy`
4. **建 KV 命名空間**（存元資料，替代原來的 R2）：控制台 →「Workers 和 Pages」→「KV」→「建立命名空間」，名字隨意（如 `imghub-meta`），把它的 **ID** 填進 `wrangler.jsonc` 的 `kv_namespaces` 裡 `META` 的 `id`
5. 部署後到「設定」→「變數和機密」，按上表逐個新增（類型選「密鑰」），再點「部署」

### 開啟 Telegram 儲存（預設）

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather) → `/newbot`，拿到 bot token
2. 新建一個**私有頻道**，把 bot 加進去當管理員（要能發訊息、刪訊息）
3. 頻道的 `chat_id`（形如 `-100…`）可在頻道裡發條訊息後，用 `https://api.telegram.org/bot<token>/getUpdates` 查看
4. 到 Worker 的「變數和機密」新增 `TG_BOT_TOKEN`（bot token）和 `TG_CHAT_ID`（頻道 id）
5. 打開 `https://<你的網域>/settings`，在「儲存」裡選「僅 Telegram」（預設已選）

### 可選：加 HuggingFace 備份（`tg+hf` 或 `hf`）

1. HF → 頭像 → Settings → **Storage Buckets**，建一個私有桶，例如 `imghub-archive`（⚠️ 必須是 **Storage Bucket**，不是 Dataset —— 資料集倉庫不能用 S3 介面存圖）
2. Settings → Access Tokens → 建一個 write 級 token（勾選對應桶）→「Generate S3 credentials」，記下 `HFAK…` 和 SK（SK 只顯示一次）
3. 到 Worker 的「變數和機密」新增：

   | 名稱 | 類型 | 值 |
   |------|------|----|
   | `HF_S3_ACCESS_KEY` | 密鑰 | 第 2 步的 AK |
   | `HF_S3_SECRET` | 密鑰 | 第 2 步的 SK |
   | `HF_NAMESPACE` | 文字 | 你的 HF 使用者名稱或組織名 |
   | `HF_BUCKET` | 文字 | 第 1 步的桶名 |

4. 打開 `https://<你的網域>/settings`，在「儲存」裡選「Telegram + HuggingFace 歸檔」或「實驗：僅 HuggingFace」

以後更新：這是個人 Fork，儲存架構與上游不同，**不能直接 Sync fork**；要跟上遊更新得手動合併。

可選：綁定自訂網域（`workers.dev` 讀不到邊緣快取）。


</details>

## 授權

沿用上游許可：[AGPL-3.0-or-later](../LICENSE)。圖示來自 [Material Icons](https://github.com/google/material-design-icons)（Apache-2.0）；瀏覽器端編碼器來自 [jSquash](https://github.com/jamsinclair/jSquash)（Apache-2.0），影片處理用 [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0），均在建置時複製，不在儲存庫中。

所有功能與設計版權歸上游作者，感謝 [TG-Twilight](https://github.com/TG-Twilight) 的原創工作。
