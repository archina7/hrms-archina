// 성능 테스트 B: AI 챗봇 20명 동시 질문 (실제 화면이 보내는 요청 본문 그대로 → 로컬 중계 함수 → OpenAI)
import fs from 'fs'; import crypto from 'crypto'; import { spawn } from 'child_process';
const [chrome, profile] = process.argv.slice(2);
const O = 'http://127.0.0.1:' + (process.env.PORT || '8791');
const secret = fs.readFileSync('.dev.vars', 'utf8').match(/^SESSION_SECRET=(.*)$/m)[1].trim();
const b = x => Buffer.from(x).toString('base64url');
const mk = (email) => { const p = b(JSON.stringify({ email, name: 'load', exp: Math.floor(Date.now() / 1000) + 900 })); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };

// 1) 화면에서 실제 AI 요청 본문(시스템 프롬프트 + 데이터 요약) 캡처
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9342', '--user-data-dir=' + profile, 'about:blank']);
let ws; for (let i = 0; i < 40; i++) { try { const t = await (await fetch('http://127.0.0.1:9342/json')).json(); const pg = t.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {};
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
await send('Network.setCookie', { name: 'hrms_session', value: mk('archina7@gmail.com'), url: O + '/' });
await send('Page.navigate', { url: O + '/' });
for (let i = 0; i < 80; i++) { if (await ev('typeof aiBot==="function" && typeof App!=="undefined" && App.data.employees.length>0')) break; await sleep(250); }
const system = await ev(`(async()=>{let cap=null;const real=window.fetch;window.fetch=async(u,o)=>{if(String(u).includes('/api/chat')){cap=JSON.parse(o.body);return new Response(JSON.stringify({text:'x'}),{status:200});}return real(u,o)};await aiBot('테스트');window.fetch=real;return cap.system;})()`);
ws.close(); proc.kill();
console.log(`실제 요청 본문 캡처: 시스템 프롬프트 ${system.length.toLocaleString()}자 (${Buffer.byteLength(system).toLocaleString()} bytes)`);

// 2) 20명이 서로 다른 질문을 동시에 보냄
const QUESTIONS = ['재직 인원 몇 명이야?', '자격증 만료 임박자 알려줘', '평택 현장 인원은?', '안전교육 미이수자 있어?', '대전 현장 준공일은?',
  '일용직은 몇 명이야?', '광주 현장 소장은 누구야?', '공사팀 인원은?', '현장 미배치 인원 수는?', '이번 달 출역 연인원은?',
  '봉준영 자격 상태는?', '인천 현장 배치 인원은?', '관리감독자 교육 기한 임박자는?', '부서별 인원 알려줘', '세종 현장 소장은?',
  '퇴사자는 몇 명이야?', '평택 현장 공사기간은?', '정기교육 기한 경과자는?', '계약직은 몇 명이야?', '부산 현장 인원은?'];
const t0 = performance.now();
const results = await Promise.all(QUESTIONS.map(async (q, i) => {
  const s = performance.now();
  try {
    const r = await fetch(O + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: O, Cookie: 'hrms_session=' + mk('archina7@gmail.com') },
      body: JSON.stringify({ system, messages: [{ role: 'user', content: q }] }), signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    return { i, q, ms: performance.now() - s, ok: r.ok && !!j.text, status: r.status, out: j.text || j.error };
  } catch (e) { return { i, q, ms: performance.now() - s, ok: false, status: e.name, out: e.message }; }
}));
const wall = performance.now() - t0;
const ms = results.map(r => r.ms);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${(r.ms / 1000).toFixed(1).padStart(5)}초  ${r.q.padEnd(18)} → ${String(r.out).replace(/\s+/g, ' ').slice(0, 60)}`);
console.log(`\n성공 ${results.filter(r => r.ok).length}/20, 전체 완료 ${(wall / 1000).toFixed(1)}초, 응답 평균 ${(ms.reduce((a, b) => a + b, 0) / ms.length / 1000).toFixed(1)}초, p95 ${(pct(ms, 95) / 1000).toFixed(1)}초, 최대 ${(Math.max(...ms) / 1000).toFixed(1)}초`);
const fails = results.filter(r => !r.ok); if (fails.length) console.log('실패 사유:', JSON.stringify(fails.map(f => f.status + ' ' + f.out)));
