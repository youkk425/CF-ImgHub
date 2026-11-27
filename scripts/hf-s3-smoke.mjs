// HF Storage Buckets（S3 兼容）冒烟脚本 —— 路线 B 落地前的那道关，见 docs/Huggingface-集成方案.md §6 M0。
//
//   node scripts/hf-s3-smoke.mjs            # 离线签名自检：拉 AWS 官方 SigV4 测试向量逐条比对
//   node scripts/hf-s3-smoke.mjs --live     # 再真往桶里写一个对象、读回来、删掉（要 .dev.vars 里的 HF_*）
//   node scripts/hf-s3-smoke.mjs --keep     # --live 之后保留测试对象，便于去 HF 页面上人工看一眼
//
// 为什么要这个脚本：Worker 里一旦 403 SignatureDoesNotMatch 几乎没法查（看不到规范请求），
// 而方案里那几个 [需核实] —— 302 会不会被跟随、Range 认不认、UNSIGNED-PAYLOAD 收不收、删了是否真回收 ——
// 只有跑一遍才知道。仓库没有测试框架（AGENTS.md §8），这个脚本就是 HF 的测试。
// 零依赖：只用 Node 18+ 原生的 fetch / WebCrypto 跑 src/huggingface.js（它不碰任何 Workers 专有 API，
// 只有 FixedLengthStream 一处，脚本里已按存在与否退化处理）。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hfDelete, hfGet, hfHead, hfPut, hfReady, hfUsage, sigV4 } from '../src/huggingface.js';

const here = dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes('--live');
const keep = process.argv.includes('--keep');
const SUITE = 'https://cdn.jsdelivr.net/gh/saibotsivad/aws-sig-v4-test-suite@master';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let fails = 0;
let skips = 0;
const ok = (label, pass, detail = '') => {
  console.log(`${pass === null ? '  –' : pass ? '  ✔' : '  ✘'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (pass === false) fails++;
  if (pass === null) skips++;
};
const timed = async (fn) => {
  const t = performance.now();
  const out = await fn();
  return [out, Math.round(performance.now() - t)];
};

// ---------- 1. 离线：AWS 官方 SigV4 测试向量 ----------
// 向量与凭证都来自官方套件（那是公开示例密钥，不是真密钥）；不在仓库里落盘，免得看代码的人以为是可用凭证。
console.log('SigV4 自检（AWS 官方 aws-sig-v4-test-suite）');
let cfg;
try {
  cfg = (await (await fetch(`${SUITE}/index.json`, { signal: AbortSignal.timeout(15000) })).json()).config;
} catch {
  cfg = null;
}
if (!cfg) {
  ok('取测试向量', null, '离线或 CDN 不可达，跳过（--live 仍会验证签名是否被网关接受）');
} else {
  // 覆盖签名里最容易写错的几处：路径编码、查询排序、同名参数、UTF-8、头值折行与重复、载荷哈希
  const CASES = [
    'get-vanilla', 'get-vanilla-query', 'get-vanilla-query-order-key', 'get-vanilla-query-order-value',
    'get-vanilla-query-unreserved', 'get-vanilla-utf8-query', 'get-unreserved', 'get-utf8',
    'get-header-key-duplicate', 'get-header-value-multiline', 'get-header-value-order', 'get-header-value-trim',
    'post-vanilla', 'post-header-key-case', 'post-x-www-form-urlencoded',
  ];
  for (const name of CASES) {
    const txt = async (ext) => (await (await fetch(`${SUITE}/raw/aws-sig-v4-test-suite/${name}/${name}.${ext}`)).text());
    let authz;
    try {
      const [req, expected] = [await txt('req'), (await txt('authz')).trim()];
      authz = expected;
      const parts = req.replace(/\r/g, '').split('\n\n'); // 请求头与正文之间是空行
      const lines = parts[0].split('\n');
      const body = (parts[1] || '').replace(/\n+$/, '');
      const [method, target] = lines[0].split(' ');
      const qi = target.indexOf('?');
      const qs = qi < 0 ? '' : target.slice(qi + 1);
      const headers = {};
      let last = null;
      for (const l of lines.slice(1)) {
        if (!l.trim()) continue;
        const m = /^([^:\s]+):\s*(.*)$/.exec(l);
        if (m) {
          const k = m[1].toLowerCase();
          if (k === 'content-length') { last = null; continue; } // 我们不签 content-length（官方向量也不签）
          last = k;
          headers[k] = k in headers ? `${headers[k]},${m[2]}` : m[2];
        } else if (last) headers[last] += `,${l.trim()}`;
      }
      const got = await sigV4(
        { HF_S3_ACCESS_KEY: cfg.accessKeyId, HF_S3_SECRET: cfg.secretAccessKey },
        {
          method,
          path: qi < 0 ? target : target.slice(0, qi),
          query: qs === '' ? [] : qs.split('&').map((p) => p.split('=').map(decodeURIComponent)),
          headers,
          payload: body ? createHash('sha256').update(body).digest('hex') : EMPTY_SHA,
          region: cfg.region,
          service: cfg.service,
        },
      );
      ok(name, got.authorization === authz, got.authorization === authz ? '' : `\n     期望 ${authz}\n     实得 ${got.authorization}`);
    } catch (err) {
      ok(name, null, `取不到向量（${err.message}）`);
    }
  }
}

// ---------- 2. 联网：真实往返 ----------
const env = { ...readDevVars(), ...process.env };
if (!live) {
  console.log('\n未加 --live：只做了签名自检。要验凭证与协议：node scripts/hf-s3-smoke.mjs --live');
} else if (!hfReady(env)) {
  console.log('\n--live 需要 HF_S3_ACCESS_KEY / HF_S3_SECRET / HF_BUCKET / HF_NAMESPACE（.dev.vars 或环境变量）');
  process.exit(1);
} else {
  let manifest;
  let putMs;
  try {
    [manifest, putMs] = await timed(() => hfPut(env, key, bytes, bytes.length, 'text/plain; charset=utf-8'));
    ok('PutObject（UNSIGNED-PAYLOAD）', true, `${manifest.path}，${putMs} ms`);
  } catch (err) {
    ok('PutObject', false, err.message);
  }
  if (manifest) {
    const [head, headMs] = await timed(() => hfHead(env, manifest.path));
    ok('HeadObject', head?.size === bytes.length, `${head?.size ?? '?'} 字节 / ${headMs} ms，Content-Type=${head?.ct || '(空)'}`);

    const [full, getMs] = await timed(() => hfGet(env, manifest.path));
    const back = full ? await full.text() : null;
    ok('GetObject（跟随 302 到 CDN）', back === text, `${full?.status} ${full?.url && full.url !== '' ? `最终主机 ${host(full.url)}` : ''}，${getMs} ms`);

    const [ranged] = await timed(() => hfGet(env, manifest.path, 'bytes=0-3'));
    ok(
      'Range 请求',
      ranged ? ranged.status === 206 || ranged.status === 200 : null,
      ranged ? `${ranged.status}${ranged.headers.get('Content-Range') ? ` ${ranged.headers.get('Content-Range')}` : '（上游不认 Range，读路径会自动退回整份）'}` : '无响应',
    );

    const gone = await hfGet(env, `${manifest.path}-nope`).catch(() => 'throw');
    ok('不存在的对象返回 null', gone === null || gone === 'throw', gone === 'throw' ? '抛错而非 null（读路径会当 502）' : '');

    if (keep) console.log(`  – 保留测试对象 ${manifest.path}（--keep）`);
    else {
      try {
        await hfDelete(env, [manifest.path]);
        ok('DeleteObject 真的回收', (await hfHead(env, manifest.path)) === null);
      } catch (err) {
        ok('DeleteObject', false, err.message);
      }
    }

    const [usage, usageMs] = await timed(() => hfUsage(env, { fresh: true }));
    ok('ListObjectsV2 用量', true, `${usage.files} 个对象 / ${usage.bytes} 字节${usage.partial ? '（未扫完）' : ''}，${usageMs} ms`);
  }
}

if (fails) {
  console.log(`\n✘ ${fails} 项未通过${skips ? `（另有 ${skips} 项跳过）` : ''}`);
  process.exit(1);
}
console.log(`\n✔ 全部通过${skips ? `（${skips} 项因离线跳过）` : ''}`);

// .dev.vars 是 KEY=VALUE 的简单文件，脚本不引 dotenv
function readDevVars() {
  try {
    const out = {};
    for (const line of readFileSync(join(here, '..', '.dev.vars'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

function host(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '?';
  }
}
