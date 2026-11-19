// 권한 저장소(KV) 장애 시뮬레이션: 서버 없이 functions/_middleware.js를 직접 불러 시험한다.
// 기대: 최고 관리자는 KV가 고장 나도 입장(200), 일반 계정은 503으로 안전하게 막힘.
// 사용: node .claude/skills/finaltest/scripts/kv-outage-test.mjs   (프로젝트 루트에서)
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto'; import { pathToFileURL } from 'url';
const tmp = path.join(os.tmpdir(), `mw-${process.pid}.mjs`);
fs.copyFileSync('functions/_middleware.js', tmp); // .js → .mjs로 복사해 ESM으로 불러온다
const { onRequest } = await import(pathToFileURL(tmp).href);
const SECRET = 'kv-outage-test-secret-0123456789abcdef';
const b = x => Buffer.from(x).toString('base64url');
const cookie = email => { const p = b(JSON.stringify({ email, name: 'n', exp: Math.floor(Date.now() / 1000) + 600 })); return 'hrms_session=' + p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); };
const down = async () => { throw new Error('KV down'); };
const env = { GOOGLE_CLIENT_ID: 'x', SESSION_SECRET: SECRET, ALLOWED_EMAILS: 'boss@example.com', ACCESS_KV: { get: down, list: down, put: down, delete: down } };
const run = async (email, p, accept = 'text/html') => {
  const res = await onRequest({ request: new Request('https://hrms.test' + p, { headers: { Cookie: cookie(email), Accept: accept } }), env, data: {}, next: async () => new Response('APP OK') });
  return res.status;
};
const cases = [
  ['KV 장애 + 최고 관리자 화면', await run('boss@example.com', '/'), 200],
  ['KV 장애 + 최고 관리자 /api/me', await run('boss@example.com', '/api/me', 'application/json'), 200],
  ['KV 장애 + 일반 계정 화면 → 503', await run('staff@example.com', '/'), 503],
  ['KV 장애 + 일반 계정 챗봇 → 503', await run('staff@example.com', '/api/chat', 'application/json'), 503],
];
fs.unlinkSync(tmp);
let pass = 0;
for (const [name, got, want] of cases) { const ok = got === want; if (ok) pass++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${got} (기대 ${want})`}`); }
console.log(`\nKV 장애 대응: 총 ${cases.length}개 중 ${pass}개 통과`);
process.exitCode = pass === cases.length ? 0 : 1;
