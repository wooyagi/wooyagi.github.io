#!/usr/bin/env node
/**
 * reader/build.mjs — 리더 아카이브 빌드 도구 (의존성 없음, Node 18+)
 *
 * 뷰어(index.html)와 똑같은 WebCrypto API를 써서 포맷 일치를 보장한다.
 *   입장 코드 → PBKDF2-SHA256(salt, iter) → AES-GCM 256
 *   파일 내용 = base64( iv(12) ‖ 암호문+태그 ), 복호화하면 JSON
 *
 * 입장 코드는 READER_CODE 환경변수 / --code-file / stdin 으로만 받는다.
 * 절대 출력하지 않고, 저장소에도 남기지 않는다.
 *
 * 사용법:
 *   node reader/build.mjs selftest                   암호 왕복 자가진단 (코드 불필요)
 *   node reader/build.mjs status                     현재 아카이브 상태 (코드 불필요)
 *   node reader/build.mjs archive <pub> [--limit N]  Substack 아카이브 목록 받기 (코드 불필요)
 *   node reader/build.mjs missing <pub> [--limit N]  아카이브 − 보유분 = 추가할 글 (코드 불필요)
 *   node reader/build.mjs fetch <pub> <slug>         글 1편 받아 블록 골격 생성 (코드 불필요)
 *   node reader/build.mjs verify                     입장 코드 확인
 *   node reader/build.mjs inspect <slug>             기존 글의 실제 스키마 확인
 *   node reader/build.mjs add <post.json>            번역 완료본을 아카이브에 추가
 *   node reader/build.mjs gloss-add <terms.json>     용어집에 새 용어 추가
 */
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const READER = path.dirname(fileURLToPath(import.meta.url));
const P = {
  meta: path.join(READER, 'meta.json'),
  index: path.join(READER, 'index.enc'),
  search: path.join(READER, 'search.enc'),
  gloss: path.join(READER, 'glossary.enc'),
  posts: path.join(READER, 'posts'),
  html: path.join(READER, 'index.html'),
};

/* ───────────────────────── 암호 ───────────────────────── */

const b64d = s => Uint8Array.from(Buffer.from(s, 'base64'));
const b64e = u => Buffer.from(u).toString('base64');

async function deriveKey(code, saltB64, iter, usages) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64d(saltB64), iterations: iter, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, usages);
}
async function encryptJSON(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64e(out);
}
async function decryptJSON(blobB64, key) {
  const buf = b64d(blobB64.trim()), iv = buf.slice(0, 12), ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ─────────────────────── 코드 입력 ─────────────────────── */

async function readCode(argv) {
  const fromFile = flag(argv, '--code-file');
  if (fromFile) return fs.readFileSync(fromFile, 'utf8').trim();
  if (process.env.READER_CODE) return process.env.READER_CODE.trim();
  if (!process.stdin.isTTY) {
    const lines = [];
    const rl = readline.createInterface({ input: process.stdin });
    for await (const l of rl) lines.push(l);
    const c = lines.join('\n').trim();
    if (c) return c;
  }
  die('입장 코드가 필요합니다. READER_CODE 환경변수로 넘기거나 --code-file 로 지정하세요.\n' +
      '  예: READER_CODE="$(cat ~/.reader-code)" node reader/build.mjs add post.json');
}

/** 코드로 index.enc 를 열어 키와 인덱스를 함께 돌려준다. 코드가 틀리면 여기서 죽는다. */
async function unlock(argv) {
  const meta = JSON.parse(fs.readFileSync(P.meta, 'utf8'));
  const code = await readCode(argv);
  const wk = await deriveKey(code, meta.salt, meta.iter, ['encrypt']);
  const rk = await deriveKey(code, meta.salt, meta.iter, ['decrypt']);
  let index;
  try {
    index = await decryptJSON(fs.readFileSync(P.index, 'utf8'), rk);
  } catch {
    die('입장 코드가 맞지 않습니다 (index.enc 복호화 실패). 아카이브는 건드리지 않았습니다.');
  }
  return { meta, wk, rk, index };
}

/* ───────────────────────── 유틸 ───────────────────────── */

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
function has(argv, name) { return argv.includes(name); }
const positional = argv => argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--dry-run', '--force'].includes(argv[i - 1])));

function localSlugs() {
  if (!fs.existsSync(P.posts)) return [];
  return fs.readdirSync(P.posts).filter(f => f.endsWith('.enc')).map(f => f.replace(/\.enc$/, '')).sort();
}
const stripTags = h => (h || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<\/(p|h[1-6]|li|blockquote|div|tr)>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/\s+/g, ' ').trim();

/** index.html 에 하드코딩된 주제 목록 — 여기 없는 주제를 쓰면 회색 📄 로 폴백된다. */
function knownTopics() {
  const src = fs.readFileSync(P.html, 'utf8');
  const blk = src.match(/const TOPICS=\{([\s\S]*?)\n\};/);
  if (!blk) return [];
  return [...blk[1].matchAll(/"([^"]+)"\s*:\s*\{/g)].map(m => m[1]);
}

/* ─────────────────── Substack 네트워크 ─────────────────── */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

const NET_HINT =
  '  substack.com 에 닿지 못했습니다. 실행 환경의 네트워크 정책이 막고 있거나,\n' +
  '  유료 글이라 권한이 없을 수 있습니다.\n' +
  '  → 네트워크가 열린 환경(로컬 Mac 등)에서 실행하거나,\n' +
  '  → 본문을 직접 붙여넣어 add 로 처리하세요. 유료 글은 SUBSTACK_SID 가 필요합니다.';

async function sget(url) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  // 유료 글은 구독 세션이 있어야 body_html 이 내려온다. 쿠키는 환경변수로만 받는다.
  if (process.env.SUBSTACK_SID) headers.Cookie = `substack.sid=${process.env.SUBSTACK_SID}`;
  let r;
  try {
    r = await fetch(url, { headers, redirect: 'follow' });
  } catch (e) {
    die(`Substack 접속 실패: ${e.message}\n` + NET_HINT);
  }
  if (!r.ok) {
    // 이그레스 프록시는 차단을 예외가 아니라 403/407 응답으로 돌려주기도 한다
    if (r.status === 403 || r.status === 407)
      die(`Substack 응답 ${r.status} — ${url}\n` + NET_HINT);
    die(`Substack 응답 ${r.status} — ${url}`);
  }
  return r.json();
}
const pubBase = pub => /^https?:\/\//.test(pub) ? pub.replace(/\/+$/, '') : `https://${pub}.substack.com`;

/* ─────────────── body_html → 블록 골격 분해 ─────────────── */

const VOID = new Set(['hr', 'img', 'br']);

/** 최상위 엘리먼트 단위로 자른다. 중첩 깊이를 세므로 <ul><li>… 같은 건 통째로 한 블록. */
function topLevelElements(html) {
  const out = [];
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const start = m.index;
    if (VOID.has(tag) || m[2] === '/') { out.push({ tag, html: m[0] }); re.lastIndex = m.index + m[0].length; continue; }
    // 짝 닫는 태그를 깊이 세며 찾는다
    const nest = new RegExp(`<(/?)${tag}\\b[^>]*?>`, 'gi');
    nest.lastIndex = start;
    let depth = 0, end = -1, n;
    while ((n = nest.exec(html))) {
      depth += n[1] ? -1 : 1;
      if (depth === 0) { end = n.index + n[0].length; break; }
    }
    if (end < 0) { out.push({ tag, html: html.slice(start) }); break; }
    out.push({ tag, html: html.slice(start, end) });
    re.lastIndex = end;
  }
  return out;
}

/** Substack body_html → blocks[] 골격 (ko 는 비워둔 채로, 번역해서 채울 자리) */
function htmlToBlocks(bodyHtml) {
  const blocks = [];
  for (const el of topLevelElements(bodyHtml || '')) {
    const h = el.html;
    if (el.tag === 'hr') { blocks.push({ type: 'hr' }); continue; }
    // 이미지 (Substack 은 div.captioned-image-container / figure 로 감싼다)
    const img = h.match(/<img[^>]+src="([^"]+)"/i);
    if (img && /captioned-image|figure|image/i.test(h)) {
      const cap = h.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
      const b = { type: 'image', src: img[1], alt: (h.match(/alt="([^"]*)"/i) || [, ''])[1] };
      if (cap) { b.caption = stripTags(cap[1]); b.ko = ''; }
      blocks.push(b);
      continue;
    }
    const type = /^(h[1-6]|blockquote|ul|ol|pre|table)$/.test(el.tag) ? el.tag : 'p';
    const text = stripTags(h);
    if (!text && type === 'p') continue;          // 빈 문단·장식용 div 는 버린다
    blocks.push({ type, html: h, ko: '' });
  }
  return blocks;
}

/* ───────────── search.enc 청크 (챗봇 근거용) ───────────── */

/**
 * 블록 인덱스 i 를 그대로 보존해야 #/p/{slug}~b{i} 딥링크가 맞는다.
 * 기존 글과 동일하게 image·hr 을 뺀 모든 블록을 길이 제한 없이 담는다
 * (예: 157블록 − 이미지11 − hr4 = 142청크).
 */
function chunksOf(post) {
  const out = [];
  post.blocks.forEach((b, i) => {
    if (b.type === 'hr' || b.type === 'image') return;
    out.push({ i, t: stripTags(b.ko) || stripTags(b.html), type: b.type || 'p' });
  });
  return out;
}

/** 기존 글의 words 는 번역문(ko)의 HTML 포함 총 길이다. */
const wordsOf = post => post.blocks.reduce((n, b) => n + (b.ko || '').length, 0);
const imagesOf = post => post.blocks.filter(b => b.type === 'image').length;

/* ───────────────────── 검증 ───────────────────── */

// 기존 40편과 동일한 형태 — 필드 구성은 inspect 로 실측한 것이다
const INDEX_FIELDS = ['slug', 'title', 'subtitle', 'author', 'publication', 'date', 'words', 'images', 'topics', 'tagline'];
const POST_FIELDS = ['slug', 'title', 'subtitle', 'author', 'publication', 'date', 'url',
  'brief', 'summary', 'topics', 'tagline', 'blocks', 'words'];
const SEARCH_FIELDS = ['slug', 'title', 'author', 'publication', 'tagline', 'summary', 'chunks'];

function validatePost(post, existingSlugs) {
  const errs = [], warns = [];
  for (const f of ['slug', 'title', 'publication', 'date', 'url', 'blocks'])
    if (!post[f]) errs.push(`필수 항목 누락: ${f}`);
  if (!Array.isArray(post.blocks) || !post.blocks.length) errs.push('blocks 가 비어 있습니다');
  if (post.slug && existingSlugs.includes(post.slug)) errs.push(`이미 있는 글입니다: ${post.slug}`);
  if (post.date && !/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(post.date)) warns.push(`date 형식 확인 필요: ${post.date}`);

  const topics = post.topics || [];
  if (!topics.length) errs.push('topics 가 비어 있습니다 (목록 화면 분류에 필요)');
  const known = knownTopics();
  topics.filter(t => !known.includes(t)).forEach(t =>
    warns.push(`index.html 의 TOPICS 에 없는 주제 "${t}" — 회색 📄 로 표시됩니다. 색·이모지를 주려면 index.html 도 고쳐야 합니다.`));

  (post.blocks || []).forEach((b, i) => {
    if (b.type === 'hr' || b.type === 'image') return;
    if (!b.html) errs.push(`blocks[${i}]: 원문 html 이 없습니다 (문단 펼치기가 빕니다)`);
    if (!b.ko) errs.push(`blocks[${i}]: 번역 ko 가 없습니다`);
  });
  if (!post.summary) warns.push('summary 가 없습니다 — 핵심 요약 박스가 표시되지 않습니다.');
  return { errs, warns };
}

/* ───────────────────── 서브커맨드 ───────────────────── */

const CMDS = {};

CMDS.selftest = async () => {
  const meta = JSON.parse(fs.readFileSync(P.meta, 'utf8'));
  const code = 'selftest-' + Date.now();
  const wk = await deriveKey(code, meta.salt, meta.iter, ['encrypt']);
  const rk = await deriveKey(code, meta.salt, meta.iter, ['decrypt']);
  const sample = [{ slug: 's', title: '왕복 테스트 ⚡', topics: ['메모리·HBM'] }];
  const back = await decryptJSON(await encryptJSON(sample, wk), rk);
  const ok = JSON.stringify(back) === JSON.stringify(sample);
  let rejected = false;
  try { await decryptJSON(await encryptJSON(sample, wk), await deriveKey('wrong', meta.salt, meta.iter, ['decrypt'])); }
  catch { rejected = true; }
  console.log(`암호 왕복       : ${ok ? 'OK' : 'FAIL'}`);
  console.log(`오답 코드 거부  : ${rejected ? 'OK' : 'FAIL'}`);
  console.log(`파싱 대상 주제  : ${knownTopics().length}개`);
  if (!ok || !rejected) process.exit(1);
};

CMDS.status = async () => {
  const meta = JSON.parse(fs.readFileSync(P.meta, 'utf8'));
  const slugs = localSlugs();
  console.log(`메타     : n=${meta.n}, glossary=${meta.glossary}, search=${meta.search}, iter=${meta.iter}`);
  console.log(`글 파일  : ${slugs.length}편`);
  if (meta.n !== slugs.length) console.log(`⚠ meta.n(${meta.n}) 과 실제 파일 수(${slugs.length}) 가 다릅니다`);
  console.log(`주제     : ${knownTopics().join(', ')}`);
  if (has(process.argv, '--slugs')) slugs.forEach(s => console.log('  ' + s));
};

CMDS.archive = async argv => {
  const pub = positional(argv)[1] || die('발행처 ID 가 필요합니다. 예: node reader/build.mjs archive nuttycld');
  const limit = +(flag(argv, '--limit') || 20);
  const list = await sget(`${pubBase(pub)}/api/v1/archive?sort=new&offset=0&limit=${limit}`);
  const rows = list.map(p => ({
    slug: p.slug, title: p.title, subtitle: p.subtitle || '',
    date: (p.post_date || '').slice(0, 10), audience: p.audience,
    url: p.canonical_url, description: p.description || '',
  }));
  const out = flag(argv, '--out');
  if (out) { fs.writeFileSync(out, JSON.stringify(rows, null, 2)); console.log(`${rows.length}편 → ${out}`); }
  else console.log(JSON.stringify(rows, null, 2));
};

CMDS.missing = async argv => {
  const pub = positional(argv)[1] || die('발행처 ID 가 필요합니다. 예: node reader/build.mjs missing nuttycld');
  const limit = +(flag(argv, '--limit') || 20);
  const list = await sget(`${pubBase(pub)}/api/v1/archive?sort=new&offset=0&limit=${limit}`);
  const have = new Set(localSlugs());
  const miss = list.filter(p => !have.has(p.slug));
  console.log(`아카이브 ${list.length}편 중 보유 ${list.length - miss.length}편 · 추가 대상 ${miss.length}편\n`);
  miss.forEach(p => console.log(
    `  ${(p.post_date || '').slice(0, 10)}  ${p.audience === 'only_paid' ? '🔒유료' : '  무료'}  ${p.slug}\n      ${p.title}`));
  const out = flag(argv, '--out');
  if (out) {
    fs.writeFileSync(out, JSON.stringify(miss.map(p => ({
      slug: p.slug, title: p.title, subtitle: p.subtitle || '',
      date: (p.post_date || '').slice(0, 10), audience: p.audience, url: p.canonical_url,
    })), null, 2));
    console.log(`\n→ ${out}`);
  }
};

CMDS.fetch = async argv => {
  const [, pub, slug] = positional(argv);
  if (!pub || !slug) die('사용법: node reader/build.mjs fetch <pub> <slug> [--out file.json]');
  const p = await sget(`${pubBase(pub)}/api/v1/posts/${slug}`);
  if (!p.body_html) die(`본문이 비어 있습니다 (audience=${p.audience}).\n` +
    '  유료 글입니다. SUBSTACK_SID 환경변수에 구독 세션 쿠키를 넣고 다시 실행하거나, 본문을 직접 넘겨 add 로 처리하세요.');
  const skeleton = {
    slug: p.slug,
    publication: p.publication?.name || pub,
    author: (p.publishedBylines || []).map(b => b.name).join(', ') || p.publication?.name || pub,
    title: p.title, subtitle: p.subtitle || '',
    date: (p.post_date || '').slice(0, 10),
    url: p.canonical_url,
    tagline: '',                    // ← 카드에 보일 한 줄 (직접 채운다)
    topics: [],                     // ← index.html 의 TOPICS 중에서 고른다
    brief: '',                      // ← 필자 문체 가이드 (번역 톤을 맞추기 위한 메모)
    summary: '',                    // ← 핵심 요약 HTML (직접 채운다)
    blocks: htmlToBlocks(p.body_html),
  };
  const out = flag(argv, '--out') || `${slug}.json`;
  fs.writeFileSync(out, JSON.stringify(skeleton, null, 2));
  const n = skeleton.blocks.filter(b => b.type !== 'hr' && b.type !== 'image').length;
  console.log(`${skeleton.title}\n  블록 ${skeleton.blocks.length}개 (번역할 문단 ${n}개) → ${out}`);
  console.log('  다음: ko/tagline/topics/summary 를 채운 뒤 add 로 넘기세요.');
};

CMDS.verify = async argv => {
  const { index } = await unlock(argv);
  console.log(`✓ 입장 코드 확인. 인덱스 ${index.length}편`);
  console.log(`  최신 5편: ${index.slice(0, 5).map(a => `${a.date} ${a.slug}`).join('\n            ')}`);
};

CMDS.inspect = async argv => {
  const slug = positional(argv)[1] || die('사용법: node reader/build.mjs inspect <slug>');
  const { rk, index } = await unlock(argv);
  const meta = index.find(a => a.slug === slug) || die(`인덱스에 없는 슬러그: ${slug}`);
  const post = await decryptJSON(fs.readFileSync(path.join(P.posts, slug + '.enc'), 'utf8'), rk);
  console.log('index 항목 키 :', Object.keys(meta).join(', '));
  console.log('post 항목 키  :', Object.keys(post).join(', '));
  console.log('블록 수       :', post.blocks.length);
  const types = {};
  post.blocks.forEach(b => types[b.type || 'p'] = (types[b.type || 'p'] || 0) + 1);
  console.log('블록 타입     :', JSON.stringify(types));
  console.log('블록 항목 키  :', [...new Set(post.blocks.map(b => Object.keys(b).join('+')))].join(' | '));
  console.log('요약(brief)   :', JSON.stringify(post.brief || '').slice(0, 160));
  console.log('요약(summary) :', JSON.stringify(post.summary || '').slice(0, 160));
  console.log('주제          :', JSON.stringify(post.topics), '/ words:', post.words, '/ images:', meta.images);
  const search = (await decryptJSON(fs.readFileSync(P.search, 'utf8'), rk)).find(a => a.slug === slug);
  if (search) {
    console.log('search 항목 키:', Object.keys(search).join(', '));
    console.log('청크 수       :', search.chunks.length, '/ 청크 키:', Object.keys(search.chunks[0] || {}).join(', '));
    console.log('청크 예시     :', JSON.stringify(search.chunks[0]).slice(0, 200));
  }
};

CMDS.add = async argv => {
  const file = positional(argv)[1] || die('사용법: node reader/build.mjs add <post.json>');
  const post = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dry = has(argv, '--dry-run');

  const { meta, wk, rk, index } = await unlock(argv);
  const { errs, warns } = validatePost(post, localSlugs());
  warns.forEach(w => console.log('⚠ ' + w));
  if (errs.length) { errs.forEach(e => console.error('✗ ' + e)); process.exit(1); }

  // words·images 는 본문에서 계산한다 (기존 글과 같은 정의)
  const full = { ...post, words: wordsOf(post), images: imagesOf(post), chunks: chunksOf(post) };
  const pick = (fields, src) => {
    const o = {};
    for (const f of fields) o[f] = src[f] !== undefined ? src[f] : (f === 'subtitle' || f === 'tagline' || f === 'brief' || f === 'summary' ? '' : src[f]);
    return o;
  };
  const entry = pick(INDEX_FIELDS, full);
  const body = pick(POST_FIELDS, full);
  const searchEntry = pick(SEARCH_FIELDS, full);

  if (dry) {
    console.log(`[dry-run] ${post.slug}`);
    console.log(`  블록 ${post.blocks.length} (이미지 ${full.images}) · 청크 ${searchEntry.chunks.length} · words ${full.words} · 주제 ${(post.topics || []).join('/')}`);
    console.log(`  index 키 : ${Object.keys(entry).join(', ')}`);
    console.log(`  post 키  : ${Object.keys(body).join(', ')}`);
    console.log('[dry-run] 쓰지 않고 종료합니다.');
    return;
  }

  // 최신 글이 위로 오도록 날짜 내림차순 정렬 유지
  const newIndex = [entry, ...index].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const search = await decryptJSON(fs.readFileSync(P.search, 'utf8'), rk);
  const newSearch = [searchEntry, ...search.filter(a => a.slug !== post.slug)];

  // 셋 다 만든 뒤에 한꺼번에 쓴다 — 중간에 실패해도 아카이브가 깨지지 않게
  const postBlob = await encryptJSON(body, wk);
  const indexBlob = await encryptJSON(newIndex, wk);
  const searchBlob = await encryptJSON(newSearch, wk);

  fs.writeFileSync(path.join(P.posts, post.slug + '.enc'), postBlob);
  fs.writeFileSync(P.index, indexBlob);
  fs.writeFileSync(P.search, searchBlob);
  fs.writeFileSync(P.meta, JSON.stringify({ ...meta, n: newIndex.length }) + '\n');

  console.log(`✓ 추가: ${post.title}`);
  console.log(`  slug ${post.slug} · 블록 ${post.blocks.length} · 청크 ${searchEntry.chunks.length} · 총 ${newIndex.length}편`);
};

CMDS['gloss-add'] = async argv => {
  const file = positional(argv)[1] || die('사용법: node reader/build.mjs gloss-add <terms.json>  (배열: {id, term, def, cat, match[]})');
  const terms = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(terms)) die('terms.json 은 배열이어야 합니다');

  const { meta, wk, rk } = await unlock(argv);
  const gloss = fs.existsSync(P.gloss) ? await decryptJSON(fs.readFileSync(P.gloss, 'utf8'), rk) : [];
  const have = new Set(gloss.map(g => g.id));

  const add = [];
  for (const t of terms) {
    for (const f of ['id', 'term', 'def', 'match'])
      if (!t[f]) die(`용어 항목에 ${f} 가 없습니다: ${JSON.stringify(t).slice(0, 80)}`);
    if (!/^[a-z0-9-]+$/.test(t.id)) die(`id 는 소문자·숫자·하이픈만 씁니다 (본문 [[id]] 링크용): ${t.id}`);
    if (have.has(t.id)) { console.log(`· 이미 있음, 건너뜀: ${t.id}`); continue; }
    // match 가 너무 짧으면 본문 아무 데나 링크가 붙는다 (뷰어는 2자 이상만 링크)
    t.match.filter(m => m.length < 2).forEach(m => die(`match 항목이 너무 짧습니다 (2자 이상): "${m}" in ${t.id}`));
    add.push({ id: t.id, term: t.term, def: t.def, cat: t.cat || '기타', match: t.match });
    have.add(t.id);
  }
  if (!add.length) { console.log('추가할 용어가 없습니다.'); return; }

  // [[id]] 상호 링크가 실제로 있는 용어를 가리키는지
  const all = new Set([...have]);
  add.forEach(g => [...(g.def.matchAll(/\[\[([a-z0-9-]+)\]\]/g))].forEach(m => {
    if (!all.has(m[1])) console.log(`⚠ ${g.id}: 없는 용어를 참조합니다 [[${m[1]}]] — 링크가 사라집니다`);
  }));

  if (has(argv, '--dry-run')) { console.log(`[dry-run] ${add.length}개 추가 예정: ${add.map(g => g.id).join(', ')}`); return; }
  const next = [...gloss, ...add];
  fs.writeFileSync(P.gloss, await encryptJSON(next, wk));
  fs.writeFileSync(P.meta, JSON.stringify({ ...meta, glossary: next.length }) + '\n');
  console.log(`✓ 용어 ${add.length}개 추가 (총 ${next.length}개): ${add.map(g => g.term).join(', ')}`);
};

/* 테스트·재사용을 위해 파싱 함수는 밖으로 연다 */
export { htmlToBlocks, chunksOf, stripTags, topLevelElements };

/* ───────────────────────── 진입점 ───────────────────────── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
if (isMain) {
if (!cmd || !CMDS[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(1).map(l => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
  }
  await CMDS[cmd](argv);
}
