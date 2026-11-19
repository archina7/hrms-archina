// 전체 기능 테스트: 헤드리스 Chrome(CDP)으로 실제 화면을 조작하고 결과를 PASS/FAIL로 기록
import fs from 'fs'; import crypto from 'crypto'; import { spawn } from 'child_process';
const [chrome, profile, shotDir] = process.argv.slice(2);
const O = 'http://127.0.0.1:' + (process.env.PORT || '8792');
const secret = fs.readFileSync('.dev.vars', 'utf8').match(/^SESSION_SECRET=(.*)$/m)[1].trim();
const b = x => Buffer.from(x).toString('base64url');
const mk = (email, name) => { const p = b(JSON.stringify({ email, name, exp: Math.floor(Date.now() / 1000) + 900 })); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url'); };
const results = []; let section = '';
const check = (name, ok, detail = '') => { results.push({ section, name, ok: !!ok, detail: String(detail).slice(0, 110) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (email, path, body, accept = 'application/json') => {
  const r = await fetch(O + path, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { ...(email ? { Cookie: 'hrms_session=' + mk(email, email.split('@')[0]) } : {}), Accept: accept, ...(body ? { 'Content-Type': 'application/json', Origin: O } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, loc: r.headers.get('location') };
};

// ---------- 1. 로그인·접근 보호 (서버) ----------
section = '1. 로그인 보호';
let r = await api(null, '/', null, 'text/html'); check('로그인 없이 / → 로그인 화면으로', r.s === 302 && /\/login/.test(r.loc), r.s + ' ' + r.loc);
r = await api(null, '/login', null, 'text/html'); check('로그인 화면 표시(구글 버튼)', r.s === 200 && /gsi\/client/.test(r.j));
r = await api(null, '/api/chat', { system: 'x', messages: [{ role: 'user', content: 'hi' }] }); check('로그인 없이 챗봇 서버 호출 차단', r.s === 401, r.s);
for (const p of ['/.dev.vars', '/wrangler.toml', '/functions/_middleware.js']) { r = await api('archina7@gmail.com', p, null, 'text/html'); check(`${p} 숨김(404)`, r.s === 404, r.s); }

// ---------- 2. 접근 관리 (서버) ----------
section = '2. 접근 관리';
r = await api('tester@example.com', '/', null, 'text/html'); check('권한 없는 계정 → 접근 요청 화면(403)', r.s === 403 && /접근 권한 요청/.test(r.j), r.s);
r = await api('tester@example.com', '/auth/request', { reason: '기능테스트' }); check('접근 권한 요청 접수', r.s === 200 && r.j.ok, JSON.stringify(r.j));
r = await api('archina7@gmail.com', '/api/access'); check('관리자 화면에 대기 요청 표시', r.s === 200 && r.j.pending.some(p => p.email === 'tester@example.com'), r.j.pending && r.j.pending.length + '건');
r = await api('archina7@gmail.com', '/api/access', { action: 'approve', email: 'tester@example.com', role: 'user' }); check('사용자로 승인', r.s === 200 && r.j.users.some(u => u.email === 'tester@example.com'));
r = await api('tester@example.com', '/', null, 'text/html'); check('승인된 계정 입장', r.s === 200 && /건설 인사관리/.test(r.j), r.s);
r = await api('tester@example.com', '/api/access'); check('일반 사용자는 접근 관리 불가', r.s === 403, r.s);
r = await api('archina7@gmail.com', '/api/access', { action: 'revoke', email: 'tester@example.com' }); check('권한 회수', r.s === 200 && !r.j.users.some(u => u.email === 'tester@example.com'));
r = await api('tester@example.com', '/', null, 'text/html'); check('회수된 계정 다시 차단', r.s === 403, r.s);

// ---------- 3~11. 화면 기능 (브라우저) ----------
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9340', '--window-size=1400,900', '--user-data-dir=' + profile, 'about:blank']);
let ws; for (let i = 0; i < 40; i++) { try { const t = await (await fetch('http://127.0.0.1:9340/json')).json(); const pg = t.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(res => ws.onopen = res);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (x.result.exceptionDetails) throw new Error(x.result.exceptionDetails.exception?.description || 'eval error'); return x.result.result.value; };
const T = async (name, expr, pred = v => !!v) => { try { const v = await ev(expr); check(name, pred(v), typeof v === 'object' ? JSON.stringify(v) : v); return v; } catch (e) { check(name, false, 'ERR ' + e.message); } };
const shot = async f => { const x = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shotDir + '/' + f, Buffer.from(x.result.data, 'base64')); };
// 폼을 채워 제출하고 오류 문구를 돌려주는 도우미. 확인창·입력창은 기본값으로 자동 응답.
const HELPERS = `window.__fill=(vals)=>{const f=document.getElementById('modalForm');for(const k in vals){f.elements[k].value=vals[k];}f.dispatchEvent(new Event('submit',{cancelable:true}));const e=document.getElementById('formError');return e?e.textContent:'';};window.confirm=()=>true;window.prompt=(m,d)=>d;true`;
await send('Runtime.enable'); await send('Network.enable');
await send('Network.setCookie', { name: 'hrms_session', value: mk('archina7@gmail.com', '나종운'), url: O + '/' });
await send('Page.navigate', { url: O + '/' });
for (let i = 0; i < 60; i++) { try { if (await ev('typeof App!=="undefined" && !!App.me')) break; } catch {} await sleep(250); }
await ev(HELPERS);
await ev('localStorage.clear(); resetToSample(); render(); true');

section = '3. 대시보드';
await T('재직 인원 36명', 'document.querySelectorAll(".kpi .value")[0].textContent', v => v === '36명');
await T('현장 7곳', 'document.querySelectorAll(".kpi .sub")[1].textContent', v => /7곳/.test(v));
await T('조치 필요 경고 18건', 'document.querySelectorAll(".kpi .value")[3].textContent', v => v === '18건');
await T('현장별 인원 막대 7개', 'document.querySelectorAll(".bars .row").length', v => v === 7);
await T('로그인 사용자·최고 관리자 표시', 'document.getElementById("userBox").textContent', v => /archina7@gmail.com/.test(v) && /최고 관리자/.test(v));
await shot('ft-dashboard.png');

section = '4. 사원 관리';
await ev('ACTIONS.nav("employees")');
await T('재직 사원 목록 36명', 'document.querySelectorAll("#view tbody tr").length', v => v === 36);
await ev('App.filters["emp.q"]="홍길동"; render(); true');
await T('이름 검색(홍길동) 1건', 'document.querySelectorAll("#view tbody tr").length', v => v === 1);
await ev('App.filters["emp.q"]=""; render(); ACTIONS["emp-new"](); true');
await T('중복 사번 거부', '__fill({empNo:"E2015001",name:"중복",baseSalary:"3000000"})', v => /이미 사용 중인 사번/.test(v));
await T('일용직 일당 누락 거부', '__fill({empNo:"E2026900",name:"테스트",empType:"일용",dailyWage:"0"})', v => /일당/.test(v));
await T('신규 사원 등록', '__fill({empNo:"E2026900",name:"테스트직원",dept:"공사팀",position:"사원",empType:"정규",hireDate:"2026-11-01",baseSalary:"3200000",dailyWage:"0",phone:"010-0000-9000"}); !!findEmp(App.data,"E2026900")');
await T('등록 내용 브라우저 저장', 'JSON.parse(localStorage.getItem("hrms_employees")).some(e=>e.empNo==="E2026900")');
await ev('ACTIONS["emp-edit"]("E2026900")');
await T('사원 정보 수정(직급 → 대리)', '__fill({position:"대리"}); findEmp(App.data,"E2026900").position', v => v === '대리');
await T('관련 기록 있는 사원 삭제 차단', 'window.__a=null; window.alert=m=>window.__a=m; ACTIONS["emp-delete"]("E2015001"); window.__a||""', v => /삭제할 수 없습니다/.test(v));
await T('사원 상세 보기(자격·배치 이력)', 'ACTIONS["emp-detail"]("E2025011"); const t=document.querySelector(".modal").textContent; closeModal(); t', v => /건설기계조종사면허/.test(v) && /배치 이력/.test(v));

section = '5. 현장 배치';
await ev('ACTIONS.nav("sites")');
await T('현장 목록 7곳', 'document.querySelectorAll("#view table")[0].querySelectorAll("tbody tr").length', v => v === 7);
await ev('ACTIONS["asg-new"]()');
await T('중복 배치 거부(홍길동 → 판교)', '__fill({empNo:"E2025010",siteCode:"S001",startDate:"2026-11-20"})', v => /이미/.test(v));
await ev('closeModal(); ACTIONS["asg-new"]()');
await T('신규 사원 현장 배치(테스트직원 → 평택)', '__fill({empNo:"E2026900",siteCode:"S005",role:"공무",startDate:"2026-11-02"}); !!activeAssignment(App.data,"E2026900",today())');
await T('안전 경고 표시(미이수·만료 인원)', 'document.querySelector("#view").textContent.includes("경고")');
await ev('ACTIONS["site-new"]()');
await T('신규 현장 등록', '__fill({code:"S900",name:"테스트 현장",startDate:"2026-12-01",endDate:"2027-12-31"}); !!findSite(App.data,"S900")');
await T('배치 기록 있는 현장 삭제 차단', 'window.__a=null; ACTIONS["site-delete"]("S001"); window.__a||""', v => /삭제할 수 없습니다/.test(v));

section = '6. 자격·교육';
await ev('ACTIONS.nav("certs")');
await ev('App.filters["cert.status"]="expired"; render(); true');
await T('만료 자격증 필터(한동욱·봉준영)', 'document.querySelector("#view tbody").textContent', v => /한동욱/.test(v) && /봉준영/.test(v));
await ev('App.filters["cert.status"]=""; render(); ACTIONS["cert-new"](); true');
await T('만료일이 취득일보다 빠르면 거부', '__fill({empNo:"E2026900",type:"건축기사",acquiredDate:"2026-01-01",expiryDate:"2025-01-01"})', v => /만료일/.test(v));
await T('자격증 등록', '__fill({expiryDate:""}); App.data.certs.some(c=>c.empNo==="E2026900")');
await T('미이수 일용직 안내(권혁준·차민서)', 'document.querySelector(".notice.warn").textContent', v => /권혁준/.test(v) && /차민서/.test(v));

section = '7. 근태';
await ev('App.filters["att.date"]="2026-11-18"; ACTIONS.nav("attendance"); true');
await T('11-18 배치 인원 출역 목록', 'document.querySelectorAll("#attTable tbody tr").length', v => v >= 30);
await T('출역 저장(테스트직원 9시간)', 'const tr=document.querySelector("#attTable tr[data-emp=E2026900]"); tr.querySelector(".att-chk").checked=true; tr.querySelector(".att-hrs").value="9"; ACTIONS["att-save"](); App.data.attendance.find(a=>a.empNo==="E2026900"&&a.date==="2026-11-18")?.hours', v => v === 9);
await T('월간 집계에 반영', 'document.querySelectorAll("#view .card")[1].textContent.includes("테스트직원")');
await T('출역 취소', 'const tr2=document.querySelector("#attTable tr[data-emp=E2026900]"); tr2.querySelector(".att-chk").checked=false; ACTIONS["att-save"](); !App.data.attendance.some(a=>a.empNo==="E2026900"&&a.date==="2026-11-18")');

section = '8. 급여';
await ev('App.filters["pay.month"]="2026-10"; ACTIONS.nav("payroll"); true');
await T('10월 확정 급여 표시(36명+합계행)', 'document.querySelector("#view").textContent.includes("확정됨") && document.querySelectorAll("#view tbody tr").length', v => v === 37);
await T('일용직 급여 = 일당×출역 (홍길동)', 'const p=App.data.payroll.find(x=>x.empNo==="E2025010"&&x.month==="2026-10"); p.base===230000*p.days', v => v === true);
await ev('App.filters["pay.month"]="2026-11"; render(); true');
await T('11월 급여 확정', 'ACTIONS["pay-confirm"](); App.data.payroll.filter(p=>p.month==="2026-11").length', v => v > 0);
await T('11월 확정 취소', 'ACTIONS["pay-unconfirm"](); App.data.payroll.filter(p=>p.month==="2026-11").length', v => v === 0);

section = '9. 인사 챗봇';
await ev('Store.set("chatMode","rule"); ACTIONS["chat-toggle"](); true');
await T('기본 모드: 자격 만료 질문', 'ruleBot("자격증 만료 예정자 알려줘")', v => /봉준영/.test(v) && /한동욱/.test(v));
await T('기본 모드: 평택 현장 인원(테스트직원 포함 9명)', 'htmlToText(ruleBot("평택 현장 인원 몇 명이야?"))', v => /9명/.test(v));
await T('기본 모드: 연차 계산(김건우 20일)', 'htmlToText(ruleBot("김건우 연차 며칠이야"))', v => /20일/.test(v));
await ev('Store.set("chatMode","ai"); updateChatMode(); true');
await T('AI 모드 표시', 'document.getElementById("chatModeLabel").textContent', v => /AI/.test(v));
await T('AI 모드(OpenAI) 실제 답변 — 재직 37명', 'askChat("현재 재직 인원은 몇 명이야? 숫자로 답해줘").then(()=>[...document.querySelectorAll("#chatMsgs .msg.bot")].pop().innerText)', v => /37/.test(v) && !/실패/.test(v));
await shot('ft-chat.png');

section = '10. 접근 관리 화면';
// 고정 대기 대신 화면이 준비될 때까지 기다린다 (로컬 헤드리스 브라우저 ↔ 로컬 서버 요청이 1~3초 걸림)
const waitFor = (cond, ms = 15000) => `new Promise(r=>{const t0=Date.now();(function f(){if(${cond})return r(true);if(Date.now()-t0>${ms})return r(false);setTimeout(f,200)})()})`;
await ev('ACTIONS.nav("access")');
await T('접근 관리 화면 표시(목록 로드)', waitFor('App.access && App.access.users && document.getElementById("accEmail")'));
await T('직접 부여(UI)', 'document.getElementById("accEmail").value="ui.test@example.com"; ACTIONS["access-grant"](); ' + waitFor('App.access.users.some(u=>u.email==="ui.test@example.com")'));
await T('권한 회수(UI)', 'ACTIONS["access-revoke"]("ui.test@example.com"); ' + waitFor('!App.access.users.some(u=>u.email==="ui.test@example.com")'));
await shot('ft-access.png');

section = '11. 설정·모바일';
await ev('ACTIONS.nav("settings")');
await T('JSON 백업 버튼', '!!document.querySelector("[data-act=data-export]")');
await T('샘플 데이터로 초기화', 'ACTIONS["data-sample"](); !findEmp(App.data,"E2026900") && App.data.employees.length===37');
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
await ev('ACTIONS.nav("dashboard")'); await sleep(300);
await T('모바일(375px) 가로 넘침 없음', 'document.documentElement.scrollWidth', v => v <= 375);
await shot('ft-mobile.png');

section = '12. 오류';
check('브라우저 콘솔 오류 0건', errs.length === 0, JSON.stringify(errs));
ws.close(); proc.kill();

// ---------- 결과 ----------
let cur = ''; let pass = 0;
for (const x of results) { if (x.section !== cur) { cur = x.section; console.log('\n[' + cur + ']'); } if (x.ok) pass++; console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '  <- ' + x.detail}`); }
console.log(`\n총 ${results.length}개 중 ${pass}개 통과, ${results.length - pass}개 실패`);
