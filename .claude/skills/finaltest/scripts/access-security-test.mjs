// 접근 관리·권한 보안 테스트 (로컬 wrangler pages dev 대상, 로컬 KV 사용)
// 사용: PORT=8793 node .claude/skills/finaltest/scripts/access-security-test.mjs   (프로젝트 루트에서)
// 세션 쿠키는 .dev.vars의 SESSION_SECRET로 만든다 (로컬 서버도 같은 값을 쓴다).
import fs from 'fs'; import crypto from 'crypto';
const O = 'http://127.0.0.1:' + (process.env.PORT || '8793');
const SUPER = process.env.SUPER_EMAIL || 'archina7@gmail.com';
const secret = fs.readFileSync('.dev.vars', 'utf8').match(/^SESSION_SECRET=(.*)$/m)[1].trim();
const b = x => Buffer.from(x).toString('base64url');
const ck = (email, name = 'tester') => { const p = b(JSON.stringify({ email, name, exp: Math.floor(Date.now() / 1000) + 600 })); return 'hrms_session=' + p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url'); };
const req = async (c, path, body, { origin = O, accept = 'application/json' } = {}) => {
  const r = await fetch(O + path, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { ...(c ? { Cookie: c } : {}), Accept: accept, ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j };
};
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail.slice(0, 100) : JSON.stringify(detail).slice(0, 100) });
const ADMIN = ck(SUPER, '최고관리자'), OUT = ck('sec.outsider@example.com'), ODD = ck("o'brien@corp.xn--3e0b707e"), ADM2 = ck('sec.admin2@example.com'), FORGED = ck(SUPER).replace(/.$/, c => c === 'A' ? 'B' : 'A');
const html = { accept: 'text/html' };
let r;
r = await req(null, '/', null, html); check('로그인 없이 / → 로그인 이동(302)', r.s === 302, r.s);
r = await req(FORGED, '/api/me'); check('위조된 세션 쿠키 거부(401)', r.s === 401, r.s);
for (const p of ['/.dev.vars', '/.git/config', '/wrangler.toml', '/functions/_middleware.js', '/functions/api/chat.js']) { r = await req(ADMIN, p, null, html); check(`${p} 노출 안 됨(404)`, r.s === 404, r.s); }
r = await req(OUT, '/', null, html); check('권한 없는 계정 → 요청 화면(403)', r.s === 403, r.s);
r = await req(OUT, '/api/chat', { system: 'x', messages: [{ role: 'user', content: 'hi' }] }); check('권한 없는 계정 챗봇 호출 차단', r.s === 403, r.s);
r = await req(OUT, '/auth/request', { reason: '<script>alert(1)</script>' }); check('접근 요청 접수', r.s === 200, r.j);
r = await req(OUT, '/api/access'); check('권한 없는 계정 관리 API 차단', r.s === 403, r.s);
r = await req(ADMIN, '/api/access', { action: 'approve', email: 'sec.outsider@example.com', role: 'user' }, { origin: 'https://evil.example' }); check('다른 사이트에서 보낸 요청 차단(CSRF)', r.s === 403, r.s);
r = await req(ADMIN, '/api/access', { action: 'approve', email: 'sec.outsider@example.com', role: 'superadmin' }); check('최고 관리자 권한은 부여 불가', r.s === 400, r.j);
r = await req(ADMIN, '/api/access', { action: 'approve', email: 'sec.outsider@example.com', role: 'user' }); check('사용자로 승인', r.s === 200, r.s);
r = await req(OUT, '/api/access', { action: 'grant', email: 'x@example.com', role: 'admin' }); check('일반 사용자의 권한 부여 시도 차단', r.s === 403, r.s);
r = await req(ADMIN, '/api/access', { action: 'revoke', email: SUPER }); check('최고 관리자 회수 불가', r.s === 400, r.j);
r = await req(ADMIN, '/api/access', { action: 'grant', email: SUPER, role: 'user' }); check('최고 관리자 주소로 부여 불가', r.s === 400, r.j);
r = await req(ADMIN, '/api/access', { action: 'grant', email: 'not-an-email', role: 'user' }); check('잘못된 이메일 직접 부여 거부', r.s === 400, r.j);
await req(ADMIN, '/api/access', { action: 'grant', email: 'sec.admin2@example.com', role: 'admin' });
r = await req(ADM2, '/api/access', { action: 'revoke', email: 'sec.admin2@example.com' }); check('관리자 본인 권한 회수 불가', r.s === 400, r.j);
r = await req(ADM2, '/api/access', { action: 'setRole', email: 'sec.admin2@example.com', role: 'user' }); check('관리자 본인 권한 변경 불가', r.s === 400, r.j);
r = await req(ODD, '/auth/request', { reason: '특이 주소' }); check('특이 주소(작은따옴표·.한국) 요청 접수', r.s === 200, r.j);
r = await req(ADMIN, '/api/access', { action: 'deny', email: "o'brien@corp.xn--3e0b707e" }); check('특이 주소 요청 거절 가능', r.s === 200 && !r.j.pending.some(p => p.email.startsWith("o'brien")), r.s);
r = await req(ADMIN, '/api/access', { action: 'revoke', email: 'sec.outsider@example.com' }); check('권한 회수', r.s === 200, r.s);
r = await req(ck('sec.other@example.com'), '/auth/request', { reason: '회수 직후 다른 요청' });
r = await req(OUT, '/', null, html); check('회수 직후 다른 사람 요청이 있어도 회수 유지', r.s === 403, r.s);
r = await req(ADMIN, '/api/access', { action: 'denyAll' }); check('대기 요청 모두 거절', r.s === 200 && r.j.pending.length === 0, r.j.pending && r.j.pending.length);
// 정리
await req(ADMIN, '/api/access', { action: 'revoke', email: 'sec.admin2@example.com' });

let pass = 0;
for (const x of results) { if (x.ok) pass++; console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '  <- ' + x.detail}`); }
console.log(`\n접근·권한 보안: 총 ${results.length}개 중 ${pass}개 통과, ${results.length - pass}개 실패`);
process.exitCode = pass === results.length ? 0 : 1;
