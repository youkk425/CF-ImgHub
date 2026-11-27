<p align="center">
  <img src="banner.en.svg" width="100%" alt="CF ImgHub — The image host for personal blogs">
</p>

<h1 align="center">CF-ImgHub (personal fork · HuggingFace primary storage)</h1>

<p align="center">
  A personal fork of <a href="https://github.com/TG-Twilight/CF-ImgHub">TG-Twilight/CF-ImgHub</a>.<br>
  Runs on Cloudflare Workers, but image bytes <b>skip R2 and live in HuggingFace Storage Buckets</b> (experimental mode).
</p>

> [!IMPORTANT]
> **This is my personal, self-use copy. I don't maintain it for others and don't take feature requests.** To use this image host, read the full docs, or open issues / PRs, go to the **original project**:
>
> ### 👉 https://github.com/TG-Twilight/CF-ImgHub
>
> What follows is only my own deployment notes. The "HuggingFace as primary storage" bit is what this fork actually runs; the rest of the feature list and deploy steps come from upstream and may go stale.

<p align="center">
  <a href="https://github.com/TG-Twilight/CF-ImgHub/fork"><img src="fork.en.svg" alt="Fork &amp; deploy from the original project"></a>
</p>

<p align="center">
  <a href="../README.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <b>English</b>
</p>

## The point of this fork: HuggingFace as primary storage

Upstream stores images in R2 by default and treats HuggingFace (HF) only as an optional **archive backup**. This fork turns on upstream's off-by-default "**Experimental: HuggingFace only**" mode and uses HF Storage Buckets as the **primary store**:

- **Image bytes go only into the HF bucket**; R2 keeps just a few hundred bytes of manifests and thumbnails. The admin page, stats and delete keep working as before.
- **Saves R2 storage and operation costs**: R2 no longer piles up image bodies, it only carries the small settings + thumbnail data.
- **Puts HF's free 100 GB tier to work as the image disk.**

> [!WARNING]
> Upstream labels this tier **experimental** for a reason:
>
> - Every cache miss is proxied by the Worker (HF read limit ≈16 reads/sec, signature-only, no conditional requests), so the **first load is slower than R2**.
> - Per-file cap of **30 MB** (Worker memory limit).
> - Once the 100 GB is full, uploads fail straight away with `hf_quota`.
> - Behavior may change with upstream; less battle-tested than R2.

So I only run it on a low-traffic personal blog with modest image sizes where saving R2 money matters. **For production, large images, or high concurrency, stick with R2.** Full trade-off analysis: `docs/Huggingface-主存代价分析.md`.

## About this fork

- **Purpose**: serves only my own blog; not a public image host.
- **Relationship to upstream**: follows upstream by default via **Sync fork**; no long-term divergence, no core-logic changes. HF-as-primary is an upstream experimental capability — I merely selected it as my default storage.
- **Personalization**: config-only — bucket name, secrets, domains, hotlink allowlist, theme color, storage mode — all set in the Cloudflare dashboard and the settings page, nothing in code.
- **Why you shouldn't fork from me**: upstream's Fork-and-deploy flow is already designed for "one copy per person". To get HF primary, just fork upstream and pick "Experimental: HuggingFace only" in the settings page — no need to go through this copy.

## Upstream features at a glance

All of these are original-project capabilities; see the upstream README for details.

- **Fast**: images served from Cloudflare's edge — cache first, then the store on a miss. No database, no third-party hop on the read path.
- **Local browser compression**: images are compressed in the browser before upload, AVIF by default, with WebP / JPEG / PNG or no compression as options; falls back to the original when compression makes it bigger.
- **Motion Photos & HDR**: detects Motion Photo / O Live and Ultra HDR gain maps, slims or re-compresses by tier; the server never rewrites a stored byte.
- **Two roles**: uploaders need only a password and can undo uploads within 24 h; admins browse, search, bulk-delete and change settings.
- **Hotlink protection, readable filenames, multiple domains, theme color, GPS scrubbing** — all adjustable in the settings page.
- **Optional Telegram storage**: as a backup, or Telegram-only for near-unlimited storage.
- **Optional HuggingFace storage**: either as an R2 archive backup (`r2+hf`), or — like this fork — as the primary store (`hf`, experimental).

## My deployment notes

<details>
<summary>Expand (personal record only; for the general steps see upstream)</summary>

You need a Cloudflare account (free tier is fine), a GitHub account and a HuggingFace account; to use your own domain, host it on Cloudflare.

Five base secrets to fill in:

| Name | Value |
|------|-------|
| `SESSION_SECRET` | a long random string, signs the login session |
| `UPLOAD_PASSWORD` | password for the upload page |
| `ADMIN_USER` | admin account |
| `ADMIN_PASSWORD` | admin password |
| `UPLOAD_TOKEN` | token for scripted uploads |

1. Fork from **upstream** to your own GitHub (not from this copy)
2. Cloudflare dashboard → "R2 Object Storage" → create bucket `cf-imghub` (under HF primary it only holds manifests and thumbnails, but it's still required)
3. "Workers & Pages" → "Create" → "Import repository", pick the fork you just made
4. Project name `cf-imghub` (must match `name` in `wrangler.jsonc`), build command `npm run build`, deploy command `npx wrangler deploy`
5. After deploy, go to "Settings" → "Variables & Secrets", add each secret from the table above (type "Secret"), then click "Deploy"

### Enabling HuggingFace primary storage

1. HF → avatar → Settings → Storage Buckets, create a private bucket, e.g. `imghub-archive`
2. Settings → Access Tokens → create a write-scoped token (scoped to that bucket) → "Generate S3 credentials", note the `HFAK…` AK and the SK (the SK is shown only once)
3. In the Worker's "Variables & Secrets", add:

   | Name | Type | Value |
   |------|------|-------|
   | `HF_S3_ACCESS_KEY` | Secret | the AK from step 2 |
   | `HF_S3_SECRET` | Secret | the SK from step 2 |
   | `HF_NAMESPACE` | Text | your HF username or org |
   | `HF_BUCKET` | Text | the bucket name from step 1 |

4. Open `https://<your-domain>/settings` and pick "**Experimental: HuggingFace only**" under "Storage"

Later updates: on your fork's page click **Sync fork** → "Update branch"; Cloudflare redeploys automatically.

Optional: bind a custom domain (the `workers.dev` URL can't read Cloudflare's edge cache), or switch to `r2+hf` / `r2+tg` combos — see the "Deploy" section of the upstream README.

</details>

## License

Same as upstream: [AGPL-3.0-or-later](../LICENSE). Icons from [Material Icons](https://github.com/google/material-design-icons) (Apache-2.0); browser-side codecs from [jSquash](https://github.com/jamsinclair/jSquash) (Apache-2.0), video processing via [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), all copied at build time and not committed here.

All features and design belong to the upstream author — thanks to [TG-Twilight](https://github.com/TG-Twilight) for the original work.
