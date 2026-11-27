<p align="center">
  <img src="banner.zh-Hant.svg" width="100%" alt="CF ImgHub — 為個人部落格打造的圖床">
</p>

<h1 align="center">CF-ImgHub（個人自用 Fork · HuggingFace 主存）</h1>

<p align="center">
  這是 <a href="https://github.com/TG-Twilight/CF-ImgHub">TG-Twilight/CF-ImgHub</a> 的個人自用 Fork。<br>
  跑在 Cloudflare Workers 上，但圖片位元組<b>不進 R2，而是主存到 HuggingFace Storage Buckets</b>（實驗模式）。
</p>

> [!IMPORTANT]
> **這是我的個人自用副本，不打算維護，也不接受功能請求。** 想用這個圖床、看完整文件或提 Issue / PR，請去**原專案**：
>
> ### 👉 https://github.com/TG-Twilight/CF-ImgHub
>
> 下面的內容只作為我自己部署時的備忘。其中「HuggingFace 主存」是我這份 Fork 真正使用的玩法，其餘功能說明和部署步驟都來自上游，隨時可能過期。

<p align="center">
  <a href="https://github.com/TG-Twilight/CF-ImgHub/fork"><img src="fork.zh-Hant.svg" alt="到原專案 Fork 並部署"></a>
</p>

<p align="center">
  <a href="../README.md">简体中文</a> · <b>繁體中文</b> · <a href="README.en.md">English</a>
</p>

## 這個 Fork 的看點：HuggingFace 當主存

上游預設把圖片存在 R2，HuggingFace（HF）只作為可選的**歸檔備份**。我這份 Fork 的核心玩法，是打開上游那個預設不選的「**實驗：僅 HuggingFace**」模式，把 HF Storage Buckets 直接當成圖片的**主儲存**：

- **圖片位元組只進 HF bucket**，R2 裡只留幾百位元組的清單和縮圖，管理頁、統計、刪除照常運作。
- **省下 R2 的儲存與操作費用**：R2 不再堆圖片本體，只承擔設定和縮圖這點小資料。
- **白嫖 HF 的 100 GB 免費額度**當圖床碟。

> [!WARNING]
> 上游明確把這檔標為**實驗**，代價要清楚：
>
> - 每次快取未命中都要 Worker 代讀 HF（HF 讀上限約 16 次／秒、只認簽章不認條件請求），**首屏比 R2 慢**。
> - 單一檔案上限 **30 MB**（Worker 記憶體限制）。
> - 100 GB 寫滿後上傳直接報 `hf_quota`。
> - 行為可能隨上游調整，穩定性不如 R2。

所以我只在自己這種低流量、圖不大、想省 R2 錢的個人部落格上用它；**正式生產、大圖、高併發場景請乖乖用 R2**。完整的技術權衡見 `../docs/Huggingface-主存代價分析.md`。

## 關於這個 Fork

- **用途**：只為我自己的部落格服務，不對外提供圖床。
- **與上游的關係**：預設跟隨上游，靠 **Sync fork** 拉取更新；不做長期分叉，不改核心邏輯。HF 主存是上游已有的實驗能力，我只是把它選成自己的預設儲存。
- **個性化改動**：只限於設定層面——儲存桶名、金鑰、網域、防盜鏈放行名單、主題色、儲存模式等，都在 Cloudflare 面板和設定頁裡調，不落到程式碼裡。
- **為什麼不建議用我這份**：上游的 Fork 部署流程本來就是給「每人一份」設計的。想要 HF 主存，直接 Fork 上游、在設定頁選「實驗：僅 HuggingFace」即可，不需要經過我這份。

## 上游功能速覽

以下均為原專案能力，詳細說明見上游 README。

- **快**：圖片從 Cloudflare 邊緣回傳，先查快取、未命中讀儲存，無資料庫、不繞第三方儲存。
- **瀏覽器本機壓縮**：上傳前在瀏覽器壓縮，預設轉 AVIF，可選 WebP / JPEG / PNG 或不壓縮；壓完變大時自動用原圖。
- **實況照片與 HDR**：識別 Motion Photo / O Live 與 Ultra HDR 增益圖，按檔位精簡或重壓，伺服器從不改動檔案位元組。
- **兩種身分**：上傳者憑密碼上傳、可撤回 24 小時內的上傳；管理員可瀏覽、搜尋、批次刪除、改設定。
- **防盜鏈、易讀檔名、多網域、主題色、去除 GPS** 等均在設定頁調整。
- **可選 Telegram 儲存**：作為備份，或只存 Telegram 實現近乎無上限儲存。
- **可選 HuggingFace 儲存**：既可作 R2 的歸檔備份（`r2+hf`），也可像我這份一樣選成主存（`hf`，實驗）。

## 我的部署備忘

<details>
<summary>展開（僅自用記錄，通用步驟請看上游）</summary>

準備：一個 Cloudflare 帳戶（免費版即可）、一個 GitHub 帳戶、一個 HuggingFace 帳戶；要用自己的網域需託管在 Cloudflare。

部署要填 5 個基礎金鑰：

| 名稱 | 填什麼 |
|------|------|
| `SESSION_SECRET` | 隨機長字串，用來簽章登入工作階段 |
| `UPLOAD_PASSWORD` | 上傳頁的密碼 |
| `ADMIN_USER` | 管理頁的帳號 |
| `ADMIN_PASSWORD` | 管理頁的密碼 |
| `UPLOAD_TOKEN` | 腳本上傳用的 Token |

1. 從**上游** Fork 一份到自己的 GitHub（不要從我這份 Fork）
2. Cloudflare 控制台 →「R2 物件儲存」→ 建立儲存桶 `cf-imghub`（HF 主存下它只放清單和縮圖，仍需要）
3. 「Workers 和 Pages」→「建立」→「匯入儲存庫」，選剛 Fork 的儲存庫
4. 專案名 `cf-imghub`（與 `wrangler.jsonc` 的 `name` 一致），建置命令 `npm run build`，部署命令 `npx wrangler deploy`
5. 部署後到「設定」→「變數和機密」，按上表逐個新增（類型選「密鑰」），再點「部署」

### 開啟 HuggingFace 主存

1. HF → 頭像 → Settings → Storage Buckets，建一個私有桶，例如 `imghub-archive`
2. Settings → Access Tokens → 建一個 write 級 token（勾選對應桶）→「Generate S3 credentials」，記下 `HFAK…` 和 SK（SK 只顯示一次）
3. 到 Worker 的「變數和機密」新增：

   | 名稱 | 類型 | 值 |
   |------|------|----|
   | `HF_S3_ACCESS_KEY` | 密鑰 | 第 2 步的 AK |
   | `HF_S3_SECRET` | 密鑰 | 第 2 步的 SK |
   | `HF_NAMESPACE` | 文字 | 你的 HF 使用者名稱或組織名 |
   | `HF_BUCKET` | 文字 | 第 1 步的桶名 |

4. 打開 `https://<你的網域>/settings`，在「儲存」裡選「**實驗：僅 HuggingFace**」

以後更新：在自己 Fork 的儲存庫點 **Sync fork** →「Update branch」，Cloudflare 會自動重新部署。

可選：綁定自訂網域（`workers.dev` 讀不到邊緣快取）、改用 `r2+hf` / `r2+tg` 等組合——完整步驟見上游 README 的「部署」章節。

</details>

## 授權

沿用上游許可：[AGPL-3.0-or-later](../LICENSE)。圖示來自 [Material Icons](https://github.com/google/material-design-icons)（Apache-2.0）；瀏覽器端編碼器來自 [jSquash](https://github.com/jamsinclair/jSquash)（Apache-2.0），影片處理用 [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0），均在建置時複製，不在儲存庫中。

所有功能與設計版權歸上游作者，感謝 [TG-Twilight](https://github.com/TG-Twilight) 的原創工作。
