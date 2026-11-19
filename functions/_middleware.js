// 구글 로그인 + 접근 권한 관리로 사이트 전체를 보호하는 Cloudflare Pages 미들웨어.
//
// 필요한 환경 변수 (Cloudflare Pages 비밀값):
//   GOOGLE_CLIENT_ID  Google OAuth 클라이언트 ID
//   ALLOWED_EMAILS    최고 관리자 구글 이메일, 쉼표로 구분 (항상 접속 가능, 화면에서 회수 불가)
//   SESSION_SECRET    세션 쿠키 서명용 임의 문자열, 32자 이상
// 하나라도 없으면 모든 요청을 막는다 (fail closed).
//
// 바인딩 (wrangler.toml):
//   ACCESS_KV  접근 권한 저장소. 사람별 키 user:<email>, pending:<email>(7일 만료)로 보관해 동시 변경이 서로 덮어쓰지 않는다.
//              없으면 최고 관리자만 접속할 수 있고 접근 관리 기능은 꺼진다.
//              KV에 장애가 나도 최고 관리자는 KV를 읽기 전에 통과하므로 항상 접속할 수 있다.
//
// 권한: superadmin(최고 관리자, ALLOWED_EMAILS) > admin(관리자, 접근 관리 가능) > user(사용자)
// 흐름: 구글 로그인 → 이메일 인증 확인 → 권한 있으면 입장 / 없으면 '접근 권한 요청' → 관리자가 '접근 관리'에서 승인

const COOKIE = 'hrms_session';
const SESSION_HOURS = 12;
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
// KV 키: 사람마다 따로 저장해 동시에 바꿔도 서로 덮어쓰지 않는다
const USER_PREFIX = 'user:';       // user:<email>    → { role, name, grantedBy, grantedAt }
const PENDING_PREFIX = 'pending:'; // pending:<email> → { name, reason, requestedAt }  (7일 뒤 자동 만료)
const LEGACY_KEY = 'access:v1';    // 이전 형식(문서 하나) — 발견되면 새 형식으로 옮기고 지운다
const ROLES = ['user', 'admin'];
const MAX_PENDING = 200;
const PENDING_TTL = 7 * 24 * 3600;
const MAX_REASON = 150;            // 목록 조회용 메타데이터(1KB 제한) 안에 들어가도록
const MAX_EMAIL = 254;
// 직접 부여할 때만 쓰는 형식 검사. 작은따옴표·국제 도메인(xn--)도 허용한다.
const GRANT_EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"']+\.[^\s@<>"'.]{2,}$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function superAdmins(env) {
  return new Set(
    String(env.ALLOWED_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function safeNext(value) {
  // 같은 사이트 안의 경로만 허용 (외부로 튕기는 open redirect 방지)
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/';
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeSession(email, name, secret) {
  const payload = bytesToB64url(
    enc.encode(JSON.stringify({ email, name, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 }))
  );
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return payload + '.' + bytesToB64url(sig);
}

/** 서명이 맞고 만료되지 않은 세션이면 { email, name } (구글 이메일 인증을 통과한 사람) */
async function readSession(value, secret) {
  if (!value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlToBytes(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(b64urlToBytes(payload)));
    if (typeof data.email !== 'string' || !(data.exp > Date.now() / 1000)) return null;
    return { email: data.email, name: typeof data.name === 'string' ? data.name : '' };
  } catch {
    return null;
  }
}

async function verifyGoogleIdToken(token, clientId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('토큰 형식 오류');
  const header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
  if (header.alg !== 'RS256') throw new Error('지원하지 않는 서명 방식');

  const res = await fetch(GOOGLE_CERTS, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error('구글 공개키를 받지 못함');
  const { keys } = await res.json();
  const jwk = (keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('알 수 없는 서명 키');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    enc.encode(parts[0] + '.' + parts[1])
  );
  if (!valid) throw new Error('서명 검증 실패');

  const claims = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  const now = Date.now() / 1000;
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new Error('발급자 불일치');
  if (claims.aud !== clientId) throw new Error('클라이언트 ID 불일치');
  if (!(claims.exp > now)) throw new Error('토큰 만료');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('이메일 미인증 계정');
  return { email: String(claims.email || '').toLowerCase(), name: String(claims.name || '').slice(0, 60) };
}

// ===== 접근 권한 저장소 (KV, 사람별 키) =====
const ROLE_ERR = '권한은 사용자 또는 관리자만 선택할 수 있습니다.';
const SUPER_ERR = '최고 관리자 권한은 Cloudflare 설정(ALLOWED_EMAILS)에서만 바꿀 수 있습니다.';

async function putUser(env, email, rec) {
  await env.ACCESS_KV.put(USER_PREFIX + email, JSON.stringify(rec), { metadata: rec });
}
async function putPending(env, email, rec) {
  await env.ACCESS_KV.put(PENDING_PREFIX + email, JSON.stringify(rec), { metadata: rec, expirationTtl: PENDING_TTL });
}
async function getJson(env, key, cached = false) {
  return env.ACCESS_KV.get(key, cached ? { type: 'json', cacheTtl: 60 } : { type: 'json' });
}
/** prefix로 시작하는 키 목록 (메타데이터 포함, 값은 따로 읽지 않는다) */
async function listPrefix(env, prefix) {
  const out = [];
  let cursor;
  do {
    const r = await env.ACCESS_KV.list({ prefix, cursor });
    for (const k of r.keys) out.push({ email: k.name.slice(prefix.length), ...(k.metadata || {}) });
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return out;
}

/** 이전 형식(access:v1 문서 하나)이 남아 있으면 사람별 키로 옮기고 지운다. 이미 있는 키는 덮어쓰지 않는다. */
async function migrateLegacy(env) {
  if (!env.ACCESS_KV) return;
  const legacy = await env.ACCESS_KV.get(LEGACY_KEY, { type: 'json' });
  if (!legacy) return;
  for (const [email, u] of Object.entries(legacy.users || {})) {
    if (u && ROLES.includes(u.role) && !(await getJson(env, USER_PREFIX + email))) await putUser(env, email, u);
  }
  for (const [email, p] of Object.entries(legacy.pending || {})) {
    if (p && !(await getJson(env, USER_PREFIX + email)) && !(await getJson(env, PENDING_PREFIX + email))) {
      await putPending(env, email, { name: p.name || '', reason: String(p.reason || '').slice(0, MAX_REASON), requestedAt: p.requestedAt || new Date().toISOString() });
    }
  }
  await env.ACCESS_KV.delete(LEGACY_KEY);
}

/**
 * 권한 확인. 최고 관리자는 KV를 읽기 전에 판단하므로 KV 장애·한도 초과에도 항상 들어올 수 있다.
 * 일반 계정은 KV 오류 시 예외가 그대로 올라간다(호출한 쪽에서 503 처리, 안전하게 막음).
 */
async function getRole(env, email, fresh = false) {
  if (superAdmins(env).has(email)) return 'superadmin';
  if (!env.ACCESS_KV) return null;
  let u = await getJson(env, USER_PREFIX + email, !fresh);
  if (!u && fresh) { await migrateLegacy(env); u = await getJson(env, USER_PREFIX + email); }
  return u && ROLES.includes(u.role) ? u.role : null;
}

async function accessState(env) {
  await migrateLegacy(env);
  const supers = superAdmins(env);
  const byDate = (k) => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));
  const [users, pending] = await Promise.all([listPrefix(env, USER_PREFIX), listPrefix(env, PENDING_PREFIX)]);
  return {
    managed: !!env.ACCESS_KV,
    superAdmins: [...supers],
    // 최고 관리자와 겹치는 부여 기록은 목록에서 숨긴다 (최고 관리자 권한이 우선)
    users: users.filter((u) => ROLES.includes(u.role) && !supers.has(u.email)).sort(byDate('grantedAt')),
    pending: pending.sort(byDate('requestedAt')),
  };
}

/**
 * 관리자의 접근 관리 요청 처리. 사람별 키 하나만 바꾸므로 다른 사람의 변경을 덮어쓰지 않는다.
 * 반환: { error } 또는 { patch(state) } — KV 목록 조회는 조금 늦게 반영될 수 있어 방금 바꾼 내용을 응답에 직접 반영한다.
 */
async function doAccessAction(env, me, body) {
  const action = body && body.action;
  const role = body && body.role;
  const now = new Date().toISOString();
  const supers = superAdmins(env);

  if (action === 'denyAll') {
    const all = await listPrefix(env, PENDING_PREFIX);
    await Promise.all(all.map((p) => env.ACCESS_KV.delete(PENDING_PREFIX + p.email)));
    return { patch: (s) => { s.pending = []; }, count: all.length };
  }

  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || /\s/.test(email)) return { error: '이메일이 올바르지 않습니다.' };
  const setUser = (rec) => (s) => { s.users = s.users.filter((u) => u.email !== email).concat({ email, ...rec }); s.pending = s.pending.filter((p) => p.email !== email); };
  const dropUser = (s) => { s.users = s.users.filter((u) => u.email !== email); };
  const dropPending = (s) => { s.pending = s.pending.filter((p) => p.email !== email); };

  switch (action) {
    case 'grant': {
      // 직접 입력한 주소만 형식 검사 (구글이 인증해 준 요청 주소는 그대로 받는다)
      if (!GRANT_EMAIL_RE.test(email)) return { error: '올바른 이메일 주소가 아닙니다.' };
      if (supers.has(email)) return { error: SUPER_ERR };
      if (!ROLES.includes(role)) return { error: ROLE_ERR };
      const pend = await getJson(env, PENDING_PREFIX + email);
      const prev = await getJson(env, USER_PREFIX + email);
      const rec = { role, name: (pend && pend.name) || (prev && prev.name) || '', grantedBy: me.email, grantedAt: now };
      await putUser(env, email, rec);
      if (pend) await env.ACCESS_KV.delete(PENDING_PREFIX + email);
      return { patch: setUser(rec) };
    }
    case 'approve': {
      if (!ROLES.includes(role)) return { error: ROLE_ERR };
      const pend = await getJson(env, PENDING_PREFIX + email);
      if (!pend) return { error: '승인 대기 중인 요청이 아닙니다. (이미 처리되었거나 7일이 지나 만료됨)' };
      if (supers.has(email)) { await env.ACCESS_KV.delete(PENDING_PREFIX + email); return { patch: dropPending }; }
      const rec = { role, name: pend.name || '', grantedBy: me.email, grantedAt: now };
      await putUser(env, email, rec);
      await env.ACCESS_KV.delete(PENDING_PREFIX + email);
      return { patch: setUser(rec) };
    }
    case 'deny':
      // 최고 관리자 주소든 형식이 특이한 주소든 대기 요청은 항상 지울 수 있다
      await env.ACCESS_KV.delete(PENDING_PREFIX + email);
      return { patch: dropPending };
    case 'setRole': {
      if (supers.has(email)) return { error: SUPER_ERR };
      if (email === me.email) return { error: '본인의 권한은 바꿀 수 없습니다.' };
      if (!ROLES.includes(role)) return { error: ROLE_ERR };
      const u = await getJson(env, USER_PREFIX + email);
      if (!u) return { error: '권한이 부여된 사용자가 아닙니다.' };
      const rec = { ...u, role, grantedBy: me.email, grantedAt: now };
      await putUser(env, email, rec);
      return { patch: setUser(rec) };
    }
    case 'revoke':
      if (email === me.email) return { error: '본인의 권한은 회수할 수 없습니다.' };
      // 최고 관리자와 겹치는 부여 기록도 정리할 수 있다 (최고 관리자 권한 자체는 그대로)
      await env.ACCESS_KV.delete(USER_PREFIX + email);
      return { patch: dropUser };
    default:
      return { error: '알 수 없는 작업입니다.' };
  }
}

// ===== 응답 도우미 =====
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function sameOriginJson(request, url) {
  // CSRF 방지: 같은 사이트에서 보낸 JSON 요청만 받는다
  if (request.headers.get('Origin') !== url.origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    return json({ error: '잘못된 요청 형식입니다.' }, 415);
  }
  return null;
}

function page(title, inner) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1f2933; --muted:#616e7c; --line:#e4e7eb; --err:#b42318; --ok:#15803d; --btn:#1e3a5f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14171c; --card:#1d2128; --text:#e4e7eb; --muted:#9aa5b1; --line:#323843; --err:#f97066; --ok:#4ade80; --btn:#3b6ea5; }
  }
  body { margin:0; background:var(--bg); color:var(--text); line-height:1.5;
    font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif; }
  main { max-width:440px; margin:12vh auto 0; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:28px 24px; text-align:center; }
  h1 { font-size:1.2rem; margin:0 0 6px; }
  p { color:var(--muted); margin:0 0 16px; font-size:.92rem; }
  #gbtn { display:flex; justify-content:center; min-height:44px; }
  #msg { color:var(--err); margin:16px 0 0; font-size:.9rem; }
  #msg.ok { color:var(--ok); }
  .who { font-weight:600; color:var(--text); }
  .badge { display:inline-block; font-size:.78rem; padding:1px 8px; border-radius:999px; border:1px solid var(--line); color:var(--ok); }
  textarea { width:100%; box-sizing:border-box; min-height:70px; padding:8px 10px; border:1px solid var(--line); border-radius:8px;
    background:var(--bg); color:var(--text); font:inherit; resize:vertical; }
  button { margin-top:12px; padding:9px 18px; border:0; border-radius:8px; background:var(--btn); color:#fff; font:inherit; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .links { margin-top:18px; font-size:.88rem; }
  a { color:inherit; }
</style>
</head>
<body><main><div class="card">${inner}</div></main></body>
</html>`;
}

function loginPage(clientId, next) {
  const nextJs = JSON.stringify(next).replace(/</g, '\\u003c');
  return page(
    '로그인 · 건설 인사관리시스템',
    `<h1>건설 인사관리시스템</h1>
<p>구글 계정으로 로그인해 주세요. 이메일 인증 후 권한이 확인되면 입장합니다.</p>
<div id="gbtn"></div>
<div id="msg" role="alert"></div>
<script src="https://accounts.google.com/gsi/client" async onload="initGoogle()"></script>
<script>
  var NEXT = ${nextJs};
  function initGoogle() {
    google.accounts.id.initialize({ client_id: ${JSON.stringify(clientId)}, callback: onCredential });
    google.accounts.id.renderButton(document.getElementById('gbtn'),
      { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ko' });
  }
  function onCredential(r) {
    var msg = document.getElementById('msg');
    msg.textContent = '';
    fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: r.credential })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.ok) { location.replace(j.allowed ? NEXT : '/'); return; }
        msg.textContent = j.error || ('로그인 실패 (HTTP ' + res.status + ')');
        google.accounts.id.disableAutoSelect();
      });
    }).catch(function () { msg.textContent = '네트워크 오류로 로그인하지 못했습니다.'; });
  }
</script>`
  );
}

/** 구글 이메일 인증은 통과했지만 권한이 없는 사람에게 보여 주는 화면 (접근 권한 요청) */
function deniedPage(sess, pending, managed) {
  const who = `<p><span class="who">${escapeHtml(sess.name || '')} ${escapeHtml(sess.email)}</span><br><span class="badge">✓ 구글 이메일 인증 완료</span></p>`;
  let body;
  if (!managed) {
    body = '<p>이 계정은 접속 권한이 없습니다. 관리자에게 문의해 주세요.</p>';
  } else if (pending) {
    const when = new Date(pending.requestedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' });
    body = `<p>접근 권한 요청이 접수되어 <b>관리자 승인 대기 중</b>입니다.<br>(요청 ${escapeHtml(when)})</p>
<p>승인되면 이 페이지를 새로고침해 입장할 수 있습니다.<br>승인 후 반영까지 <b>최대 1분</b> 정도 걸릴 수 있습니다.<br>7일 안에 처리되지 않으면 요청이 만료되어 다시 요청할 수 있습니다.</p>
<button type="button" onclick="location.reload()">새로고침</button>`;
  } else {
    body = `<p>이 계정은 아직 접속 권한이 없습니다.<br>아래 버튼으로 관리자에게 접근 권한을 요청하세요.</p>
<textarea id="reason" maxlength="${MAX_REASON}" placeholder="요청 사유 (예: 공무팀 홍길동, 현장 인력 관리 업무)"></textarea>
<button type="button" id="reqBtn">접근 권한 요청</button>
<div id="msg" role="alert"></div>
<script>
  document.getElementById('reqBtn').addEventListener('click', function () {
    var btn = this, msg = document.getElementById('msg');
    btn.disabled = true; msg.className = ''; msg.textContent = '';
    fetch('/auth/request', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: document.getElementById('reason').value }) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.ok) { msg.className = 'ok'; msg.textContent = j.message || '요청했습니다.'; setTimeout(function () { location.reload(); }, 1200); }
        else { btn.disabled = false; msg.textContent = j.error || ('요청 실패 (HTTP ' + res.status + ')'); }
      }); })
      .catch(function () { btn.disabled = false; msg.textContent = '네트워크 오류로 요청하지 못했습니다.'; });
  });
</script>`;
  }
  return page('접근 권한 필요 · 건설 인사관리시스템',
    `<h1>접근 권한이 필요합니다</h1>${who}${body}<div class="links"><a href="/logout">다른 계정으로 로그인</a></div>`);
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET || superAdmins(env).size === 0) {
    return html(page('설정 필요', '<h1>로그인 설정이 끝나지 않았습니다</h1><p>관리자에게 문의해 주세요.</p>'), 503);
  }

  // 서버 코드와 점(.)으로 시작하는 파일·폴더(.dev.vars, .git 등), 설정 파일은 내보내지 않는다
  if (path === '/functions' || path.startsWith('/functions/') || path === '/wrangler.toml'
    || path.split('/').some((seg) => seg.startsWith('.'))) {
    return new Response('Not found', { status: 404 });
  }

  if (path === '/login') {
    return html(loginPage(env.GOOGLE_CLIENT_ID, safeNext(url.searchParams.get('next'))));
  }

  if (path === '/logout') {
    return new Response(null, {
      status: 302,
      headers: { Location: '/login', 'Set-Cookie': sessionCookie('', 0), 'Cache-Control': 'no-store' },
    });
  }

  // 구글 로그인: ID 토큰 서명·이메일 인증을 확인하고 세션을 만든다. 권한 여부는 매 요청마다 따로 확인한다.
  if (path === '/auth/google') {
    if (request.method !== 'POST') return json({ error: 'POST만 허용됩니다.' }, 405);
    const bad = sameOriginJson(request, url); if (bad) return bad;
    let who;
    try {
      const body = await request.json();
      who = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID);
    } catch (e) {
      return json({ error: '구글 로그인 확인 실패: ' + e.message }, 401);
    }
    let role = null;
    try { role = await getRole(env, who.email, true); } catch { /* KV 오류: 세션은 만들고 다음 요청에서 다시 확인 */ }
    const value = await makeSession(who.email, who.name, env.SESSION_SECRET);
    return json({ ok: true, email: who.email, allowed: !!role }, 200, { 'Set-Cookie': sessionCookie(value, SESSION_HOURS * 3600) });
  }

  const sess = await readSession(getCookie(request, COOKIE), env.SESSION_SECRET);
  if (!sess) {
    const accept = request.headers.get('Accept') || '';
    if (request.method === 'GET' && accept.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/login?next=' + encodeURIComponent(path + url.search), 'Cache-Control': 'no-store' },
      });
    }
    return json({ error: '로그인이 필요합니다.' }, 401);
  }

  // 접근 권한 요청 (구글 이메일 인증을 통과한 사람만 가능)
  if (path === '/auth/request') {
    if (request.method !== 'POST') return json({ error: 'POST만 허용됩니다.' }, 405);
    const bad = sameOriginJson(request, url); if (bad) return bad;
    if (!env.ACCESS_KV) return json({ error: '접근 관리 기능이 설정되지 않았습니다. 관리자에게 문의해 주세요.' }, 503);
    try {
      if (await getRole(env, sess.email, true)) return json({ ok: true, message: '이미 접근 권한이 있습니다.' });
      if (await getJson(env, PENDING_PREFIX + sess.email)) return json({ ok: true, message: '이미 요청되어 승인 대기 중입니다.' });
      if ((await listPrefix(env, PENDING_PREFIX)).length >= MAX_PENDING) {
        return json({ error: '대기 중인 요청이 너무 많습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.' }, 429);
      }
      let reason = '';
      try { reason = String((await request.json()).reason || '').trim().slice(0, MAX_REASON); } catch { /* 사유 없음 */ }
      await putPending(env, sess.email, { name: sess.name, reason, requestedAt: new Date().toISOString() });
    } catch {
      return json({ error: '권한 저장소에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.' }, 503);
    }
    return json({ ok: true, message: '접근 권한을 요청했습니다. 관리자 승인 후 입장할 수 있습니다.' });
  }

  // 매 요청마다 권한 확인 (회수되면 다음 요청부터 막힌다, KV 캐시로 최대 약 1분 지연)
  // 최고 관리자는 KV를 읽지 않고 통과. 일반 계정은 KV 오류 시 503으로 안전하게 막는다.
  let role;
  try {
    role = await getRole(env, sess.email);
    if (!role && env.ACCESS_KV) role = await getRole(env, sess.email, true); // 방금 승인된 경우
  } catch {
    const msg = '권한 저장소에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.';
    const accept = request.headers.get('Accept') || '';
    if (request.method === 'GET' && accept.includes('text/html')) {
      return html(page('일시 오류', `<h1>잠시 후 다시 시도해 주세요</h1><p>${msg}</p><button type="button" onclick="location.reload()">새로고침</button>`), 503);
    }
    return json({ error: msg }, 503);
  }
  if (!role) {
    const accept = request.headers.get('Accept') || '';
    if (request.method === 'GET' && accept.includes('text/html')) {
      let pending = null;
      try { if (env.ACCESS_KV) pending = await getJson(env, PENDING_PREFIX + sess.email); } catch { /* 표시만 생략 */ }
      return html(deniedPage(sess, pending, !!env.ACCESS_KV), 403);
    }
    return json({ error: `${sess.email} 계정은 접속 권한이 없습니다.` }, 403);
  }
  const isAdmin = role === 'superadmin' || role === 'admin';
  context.data.user = { email: sess.email, name: sess.name, role, isAdmin };

  if (path === '/api/me') {
    let pendingCount = 0;
    if (isAdmin && env.ACCESS_KV) { try { pendingCount = (await listPrefix(env, PENDING_PREFIX)).length; } catch { /* 0으로 표시 */ } }
    return json({ email: sess.email, name: sess.name, role, isAdmin, accessManaged: !!env.ACCESS_KV, pendingCount });
  }

  // 접근 관리 (관리자 전용)
  if (path === '/api/access') {
    if (!isAdmin) return json({ error: '관리자만 사용할 수 있습니다.' }, 403);
    if (!env.ACCESS_KV) return json({ error: '접근 관리 저장소(ACCESS_KV)가 설정되지 않았습니다.' }, 503);
    try {
      if (request.method === 'GET') return json(await accessState(env));
      if (request.method !== 'POST') return json({ error: 'GET 또는 POST만 허용됩니다.' }, 405);
      const bad = sameOriginJson(request, url); if (bad) return bad;
      let body;
      try { body = await request.json(); } catch { return json({ error: '잘못된 요청 형식입니다.' }, 400); }
      const result = await doAccessAction(env, sess, body);
      if (result.error) return json({ error: result.error }, 400);
      const state = await accessState(env);
      result.patch(state); // 목록 조회가 늦게 반영돼도 방금 바꾼 내용은 바로 보이게
      return json(state);
    } catch {
      return json({ error: '권한 저장소에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.' }, 503);
    }
  }

  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, no-cache');
  return out;
}
