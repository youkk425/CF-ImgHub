<p align="center">
  <img src="banner.en.svg" width="100%" alt="CF ImgHub — The image host for personal blogs">
</p>

<h1 align="center">CF-ImgHub (personal fork · R2-free · Telegram/HuggingFace storage)</h1>

<p align="center">
  A personal fork of <a href="https://github.com/TG-Twilight/CF-ImgHub">TG-Twilight/CF-ImgHub</a>.<br>
  Runs on Cloudflare Workers, but <b>R2 is removed entirely</b> — image bytes go to Telegram (default) or HuggingFace, metadata lives in Workers KV.
</p>

> [!IMPORTANT]
> **This is my personal, self-use copy. I don't maintain it for others and don't take feature requests.** To use this image host, read the full docs, or open issues / PRs, go to the **original project**:
>
> ### 👉 https://github.com/TG-Twilight/CF-ImgHub
>
> What follows is only my own deployment notes. This fork **removes R2 altogether** (enabling Cloudflare R2 requires attaching a card, which I didn't want to do) and instead stores bytes in Telegram / HuggingFace with metadata in Workers KV. That's a code-level refactor, so the storage architecture now differs from upstream.

<p align="center">
  <a href="https://github.com/TG-Twilight/CF-ImgHub/fork"><img src="fork.en.svg" alt="Fork &amp; deploy from the original project"></a>
</p>

<p align="center">
  <a href="../README.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <b>English</b>
</p>

## The point of this fork: R2 removed entirely

Upstream stores images in Cloudflare R2 and keeps the metadata (settings, manifests, thumbnails) in the same R2 bucket. But **enabling R2 requires attaching a payment card to Cloudflare**, which I didn't want to do — so I removed R2 from the code altogether and replaced it with:

- **Image bytes**: stored in a Telegram channel (default, no object storage) or HuggingFace Storage Buckets (optional).
- **Metadata** (settings, image manifests, thumbnails, deletion list): stored in **Workers KV** — card-free, native to Workers, and the free tier is plenty for an image host.

Storage mode is a three-way choice on the settings page (default `tg`):

| Mode | Where bytes live | Notes |
|------|------|-------|
| `tg` (default) | Telegram channel | No object storage used; uncached reads take 0.5–3 s; up to 100 MB per file |
| `tg+hf` | Telegram + HuggingFace | Primary on TG, with an archive copy on HF for disaster recovery; reads fall back to the archive |
| `hf` (experimental) | HuggingFace bucket | Bytes only in HF; proxied by the Worker (≈16 reads/sec), 30 MB per file; the app uses a 100 GiB soft threshold (`HF_QUOTA`) and fails uploads with `hf_quota` past it (HF's own billing follows its official terms) |

> [!WARNING]
> The HF side of `hf` / `tg+hf` is the capability upstream labels **experimental**: Worker-proxied reads, no edge direct links, less battle-tested than object storage. I only run it on a low-traffic personal blog with modest image sizes. **For production, large images, or high concurrency, use a solution with real object storage.** Full trade-off analysis: `docs/Huggingface-主存代价分析.md`, `docs/重构方案-移除R2.md`.

## About this fork

- **Purpose**: serves only my own blog; not a public image host.
- **Relationship to upstream**: this is a **code-level refactor** — the storage architecture now differs from upstream, so it can no longer cleanly Sync fork. Core features (compression, Motion Photos/HDR, hotlink protection, roles) still follow upstream's design.
- **Why R2 is gone**: enabling Cloudflare R2 requires a card. The Telegram + KV combo runs entirely card-free.

## Upstream features at a glance

All of these are original-project capabilities; see the upstream README for details.

- **Fast**: images served from Cloudflare's edge — cache first, then the store on a miss. No database on the read path.
- **Local browser compression**: images are compressed in the browser before upload, AVIF by default, with WebP / JPEG / PNG or no compression as options; falls back to the original when compression makes it bigger.
- **Motion Photos & HDR**: detects Motion Photo / O Live and Ultra HDR gain maps, slims or re-compresses by tier; the server never rewrites a stored byte.
- **Two roles**: uploaders need only a password and can undo uploads within 24 h; admins browse, search, bulk-delete and change settings.
- **Hotlink protection, readable filenames, multiple domains, theme color, GPS scrubbing** — all adjustable in the settings page.


## My deployment notes

<details>
<summary>Expand (personal record only; for the general steps see upstream)</summary>

You need a Cloudflare account (free tier is fine), a GitHub account and a Telegram account (required for the default storage); add a HuggingFace account only if you want the HF backup; to use your own domain, host it on Cloudflare. **No card needs to be attached to Cloudflare at any point.**

Five base secrets to fill in:

| Name | Value |
|------|-------|
| `SESSION_SECRET` | a long random string, signs the login session |
| `UPLOAD_PASSWORD` | password for the upload page |
| `ADMIN_USER` | admin account |
| `ADMIN_PASSWORD` | admin password |
| `UPLOAD_TOKEN` | token for scripted uploads |

1. Fork from **upstream** to your own GitHub, then apply this fork's changes (the R2-free file set) on top — or just use my copy
2. Cloudflare dashboard → "Workers & Pages" → "Create" → "Import repository", pick the repo
3. Project name `cf-imghub` (must match `name` in `wrangler.jsonc`), build command `npm run build`, deploy command `npx wrangler deploy`
4. **Create a KV namespace** (holds metadata, replacing the old R2): dashboard → "Workers & Pages" → "KV" → "Create namespace", name it anything (e.g. `imghub-meta`), then put its **ID** into the `META` binding's `id` under `kv_namespaces` in `wrangler.jsonc`
5. After deploy, go to "Settings" → "Variables & Secrets", add each secret from the table above (type "Secret"), then click "Deploy"

### Enabling Telegram storage (default)

1. In Telegram, open [@BotFather](https://t.me/BotFather) → `/newbot`, get the bot token
2. Create a **private channel** and add the bot as an admin (it needs to post and delete messages)
3. Get the channel's `chat_id` (looks like `-100…`): post a message in the channel, then check `https://api.telegram.org/bot<token>/getUpdates`
4. In the Worker's "Variables & Secrets", add `TG_BOT_TOKEN` (bot token) and `TG_CHAT_ID` (channel id)
5. Open `https://<your-domain>/settings` and pick "Telegram only" under "Storage" (already the default)

### Optional: add a HuggingFace backup (`tg+hf` or `hf`)

1. HF → avatar → Settings → **Storage Buckets**, create a private bucket, e.g. `imghub-archive` (⚠️ it must be a **Storage Bucket**, not a Dataset — dataset repos can't be used for images over the S3 API)
2. Settings → Access Tokens → create a write-scoped token (scoped to that bucket) → "Generate S3 credentials", note the `HFAK…` AK and the SK (the SK is shown only once)
3. In the Worker's "Variables & Secrets", add:

   | Name | Type | Value |
   |------|------|-------|
   | `HF_S3_ACCESS_KEY` | Secret | the AK from step 2 |
   | `HF_S3_SECRET` | Secret | the SK from step 2 |
   | `HF_NAMESPACE` | Text | your HF username or org |
   | `HF_BUCKET` | Text | the bucket name from step 1 |

4. Open `https://<your-domain>/settings` and pick "Telegram + HuggingFace archive" or "Experimental: HuggingFace only" under "Storage"

Later updates: this is a personal fork whose storage architecture differs from upstream, so it **cannot cleanly Sync fork**; merging upstream changes has to be done by hand.

Optional: bind a custom domain (the `workers.dev` URL can't read Cloudflare's edge cache).


</details>

## License

Same as upstream: [AGPL-3.0-or-later](../LICENSE). Icons from [Material Icons](https://github.com/google/material-design-icons) (Apache-2.0); browser-side codecs from [jSquash](https://github.com/jamsinclair/jSquash) (Apache-2.0), video processing via [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), all copied at build time and not committed here.

All features and design belong to the upstream author — thanks to [TG-Twilight](https://github.com/TG-Twilight) for the original work.
