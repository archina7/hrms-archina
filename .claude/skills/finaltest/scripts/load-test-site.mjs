// 성능 테스트 A: 배포 사이트에 가상 사용자 20명 동시 접속 (로그인 없이 가능한 경로)
// 1단계 지속 부하: 20명이 60초 동안 실제 사용자처럼(요청 사이 0.5~1.5초 쉬며) 접속 흐름 반복
// 2단계 순간 폭주: 20명이 동시에 10번씩 쉬지 않고 요청
const BASE = process.env.BASE_URL || 'https://hrms-archina.pages.dev';
const USERS = 20, DURATION_MS = 60_000, BURST_ROUNDS = 10;

// 경로별 기대 상태코드 (다르면 오류로 센다)
const STEPS = [
  { name: '메인(/) → 로그인 이동', path: '/', opts: { headers: { Accept: 'text/html' }, redirect: 'manual' }, expect: 302 },
  { name: '로그인 화면', path: '/login', opts: { headers: { Accept: 'text/html' } }, expect: 200 },
  { name: '로그인 처리(잘못된 토큰)', path: '/auth/google', opts: { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ credential: 'a.b.c' }) }, expect: 401 },
  { name: '로그인 정보(/api/me) 차단', path: '/api/me', opts: {}, expect: 401 },
  { name: '챗봇 서버 차단', path: '/api/chat', opts: { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}' }, expect: 401 },
  { name: '데이터 파일 차단', path: '/data/sample.json', opts: { headers: { Accept: 'text/html' }, redirect: 'manual' }, expect: 302 },
];

const stats = {}; // name → { ms: [], err: 0, codes: {} }
const rec = (name, ms, ok, code) => { const s = stats[name] ||= { ms: [], err: 0, codes: {} }; s.ms.push(ms); if (!ok) s.err++; s.codes[code] = (s.codes[code] || 0) + 1; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hit(step) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + step.path, { ...step.opts, signal: AbortSignal.timeout(15000) });
    await res.arrayBuffer();
    rec(step.name, performance.now() - t0, res.status === step.expect, res.status);
  } catch (e) { rec(step.name, performance.now() - t0, false, e.name === 'TimeoutError' ? 'timeout' : 'network'); }
}

function report(title, wallMs) {
  console.log(`\n=== ${title} ===`);
  console.log('경로'.padEnd(26) + '요청'.padStart(6) + '  오류' + '   평균'.padStart(8) + '    p50' + '    p95' + '    p99' + '    최대   상태코드');
  let total = 0, errs = 0; const all = [];
  for (const [name, s] of Object.entries(stats)) {
    total += s.ms.length; errs += s.err; all.push(...s.ms);
    const avg = s.ms.reduce((a, b) => a + b, 0) / s.ms.length;
    console.log(name.padEnd(26) + String(s.ms.length).padStart(6) + String(s.err).padStart(6) + `${avg.toFixed(0)}ms`.padStart(8) + `${pct(s.ms, 50).toFixed(0)}ms`.padStart(7) + `${pct(s.ms, 95).toFixed(0)}ms`.padStart(7) + `${pct(s.ms, 99).toFixed(0)}ms`.padStart(7) + `${Math.max(...s.ms).toFixed(0)}ms`.padStart(8) + '   ' + JSON.stringify(s.codes));
  }
  console.log(`합계: 요청 ${total}건, 오류 ${errs}건 (${(errs / total * 100).toFixed(2)}%), 처리량 ${(total / (wallMs / 1000)).toFixed(1)}건/초, 전체 p95 ${pct(all, 95).toFixed(0)}ms, p99 ${pct(all, 99).toFixed(0)}ms`);
}

// 예열 (콜드스타트 제외)
for (const s of STEPS) await hit(s);
for (const k of Object.keys(stats)) delete stats[k];

// 1단계: 지속 부하
let t0 = Date.now();
await Promise.all(Array.from({ length: USERS }, async () => {
  while (Date.now() - t0 < DURATION_MS) {
    for (const s of STEPS) { await hit(s); await sleep(500 + Math.random() * 1000); if (Date.now() - t0 >= DURATION_MS) break; }
  }
}));
report(`1단계 지속 부하: 동시 사용자 ${USERS}명 × ${DURATION_MS / 1000}초 (요청 사이 0.5~1.5초)`, Date.now() - t0);

// 2단계: 순간 폭주
for (const k of Object.keys(stats)) delete stats[k];
t0 = Date.now();
await Promise.all(Array.from({ length: USERS }, async () => { for (let i = 0; i < BURST_ROUNDS; i++) await hit(STEPS[i % STEPS.length]); }));
report(`2단계 순간 폭주: ${USERS}명이 동시에 ${BURST_ROUNDS}회씩 쉬지 않고 요청`, Date.now() - t0);
