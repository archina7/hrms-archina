// 구글 로그인으로 사이트 전체를 보호하는 Cloudflare Pages 미들웨어.
//
// 필요한 환경 변수 (Cloudflare Pages 프로젝트 설정):
//   GOOGLE_CLIENT_ID  Google OAuth 클라이언트 ID (일반 변수)
//   ALLOWED_EMAILS    접속 허용 구글 이메일, 쉼표로 구분 (비밀값)
//   SESSION_SECRET    세션 쿠키 서명용 임의 문자열, 32자 이상 (비밀값)
// 하나라도 없으면 모든 요청을 막는다 (fail closed).

const COOKIE = 'hrms_session';
const SESSION_HOURS = 12;
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

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

function allowedEmails(env) {
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

async function makeSession(email, secret) {
  const payload = bytesToB64url(
    enc.encode(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 }))
  );
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return payload + '.' + bytesToB64url(sig);
}

async function readSession(value, secret) {
  if (!value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlToBytes(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(dec.decode(b64urlToBytes(payload)));
    if (typeof data.email !== 'string' || !(data.exp > Date.now() / 1000)) return null;
    return data.email;
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
  return String(claims.email || '').toLowerCase();
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
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

function page(title, inner) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1f2933; --muted:#616e7c; --line:#e4e7eb; --err:#b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14171c; --card:#1d2128; --text:#e4e7eb; --muted:#9aa5b1; --line:#323843; --err:#f97066; }
  }
  body { margin:0; background:var(--bg); color:var(--text); line-height:1.5;
    font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif; }
  main { max-width:420px; margin:12vh auto 0; padding:0 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:28px 24px; text-align:center; }
  h1 { font-size:1.2rem; margin:0 0 6px; }
  p { color:var(--muted); margin:0 0 20px; font-size:.92rem; }
  #gbtn { display:flex; justify-content:center; min-height:44px; }
  #msg { color:var(--err); margin:16px 0 0; font-size:.9rem; }
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
<p>허용된 구글 계정으로 로그인해 주세요.</p>
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
        if (res.ok) { location.replace(NEXT); return; }
        msg.textContent = j.error || ('로그인 실패 (HTTP ' + res.status + ')');
        google.accounts.id.disableAutoSelect();
      });
    }).catch(function () { msg.textContent = '네트워크 오류로 로그인하지 못했습니다.'; });
  }
</script>`
  );
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (!env.GOOGLE_CLIENT_ID || !env.SESSION_SECRET || allowedEmails(env).size === 0) {
    return html(page('설정 필요', '<h1>로그인 설정이 끝나지 않았습니다</h1><p>관리자에게 문의해 주세요.</p>'), 503);
  }

  // 서버 코드 파일은 정적 파일로 내보내지 않는다
  if (path === '/functions' || path.startsWith('/functions/')) {
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

  if (path === '/auth/google') {
    if (request.method !== 'POST') return json({ error: 'POST만 허용됩니다.' }, 405);
    // CSRF 방지: 같은 사이트에서 보낸 JSON 요청만 받는다
    if (request.headers.get('Origin') !== url.origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
      return json({ error: '잘못된 요청 형식입니다.' }, 415);
    }
    let email;
    try {
      const body = await request.json();
      email = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID);
    } catch (e) {
      return json({ error: '구글 로그인 확인 실패: ' + e.message }, 401);
    }
    if (!allowedEmails(env).has(email)) {
      return json({ error: `${email} 계정은 접속 권한이 없습니다. 관리자에게 요청해 주세요.` }, 403);
    }
    const value = await makeSession(email, env.SESSION_SECRET);
    return new Response(JSON.stringify({ ok: true, email }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(value, SESSION_HOURS * 3600),
      },
    });
  }

  // 그 밖의 모든 경로는 로그인 필요. 허용 목록에서 빠진 사람은 다음 요청부터 바로 막힌다.
  const email = await readSession(getCookie(request, COOKIE), env.SESSION_SECRET);
  if (!email || !allowedEmails(env).has(email)) {
    const accept = request.headers.get('Accept') || '';
    if (request.method === 'GET' && accept.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { Location: '/login?next=' + encodeURIComponent(path + url.search), 'Cache-Control': 'no-store' },
      });
    }
    return json({ error: '로그인이 필요합니다.' }, 401);
  }

  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'private, no-cache');
  return out;
}
