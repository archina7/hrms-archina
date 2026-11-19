---
name: final-check
description: 건설 인사관리시스템(hrms-archina)의 배포 전 최종점검을 4단계로 진행한다 — ① 코드리뷰 후 리뷰 결과대로 수정 ② 기능테스트 ③ 성능테스트(20명 동시접속) ④ 보안진단. 사용자가 "최종점검", "/final-check", "배포 전 점검", "출시 전 검사", "전체 점검해줘", "리뷰하고 테스트까지", "보안진단", "QA 돌려줘"처럼 여러 단계의 점검을 한꺼번에 요청하면 반드시 이 스킬을 사용한다. 단계 하나만 콕 집어 요청해도(예: "성능테스트만 다시") 이 스킬의 해당 단계 절차와 스크립트를 따른다.
---

# 최종점검 (final-check)

건설 인사관리시스템을 배포하기 전에 품질·안정성·보안을 한 번에 확인하는 절차다.
이 프로젝트에서 실제로 해 보고 효과가 확인된 방법만 담았다. 단계마다 결과를 숫자로 남기고,
고친 것과 못 고친 것을 구분해 마지막에 한 번에 보고한다.

## 시작 전에

- 프로젝트 루트(`index.html`, `functions/`, `wrangler.toml`이 있는 폴더)에서 진행한다. 아래 스크립트 경로는 모두 이 기준이다.
- `CLAUDE.md`와 `작업규칙.md`를 먼저 읽는다. 배포 주소, 비밀값 관리 규칙, 접근 관리 구조가 거기에 있다.
- `git status`로 커밋 안 된 변경이 있는지 본다. 있으면 그 변경도 리뷰 대상에 넣는다.
- 테스트 결과물(로그, 스크린샷, 로컬 KV 데이터)은 프로젝트 밖 임시 폴더(scratchpad)에 둔다. 프로젝트에 남기지 않는다.
- 사용자가 특정 단계만 원하면 그 단계만 한다. 전체를 원하면 1→4 순서로 한다(리뷰에서 고친 코드를 테스트가 검증하도록).

### 꼭 지킬 것 (이 프로젝트에서 실제로 문제가 됐던 것들)

- **비밀값을 화면에 출력하지 않는다.** `.dev.vars`를 cat/echo 하지 말고, 확인이 필요하면 앞 8자와 길이만 보인다. Cloudflare 비밀값은 `wrangler pages secret list`로 이름만 확인한다.
- **운영 환경을 바꾸는 일은 사용자 확인을 먼저 받는다.** 예: `SESSION_SECRET` 교체(모든 사용자가 다시 로그인해야 함), 운영 KV 데이터 수정, 비밀값 변경. 테스트는 로컬 서버와 로컬 KV로 한다.
- **한글이 든 요청 본문은 curl 대신 node로 보낸다.** Windows Git Bash의 curl은 한글을 깨뜨려 OpenAI가 "error parsing the body"를 돌려준다(키 문제로 오해하기 쉽다).
- **로컬 서버는 끝나면 반드시 `stop-test-servers.ps1`로 정리한다.** 백그라운드 작업 중지만으로는 `workerd`가 남아 포트와 `.wrangler/state` 파일을 잡고, 다음 테스트가 이상한 결과(예전 코드 응답)를 낸다.
- **로컬 서버는 `--persist-to <임시폴더>`로 띄운다.** 프로젝트의 `.wrangler/state`와 섞이지 않게 한다.
- **고정 시간만큼 기다리는 테스트를 만들지 않는다.** 이 PC에서 헤드리스 Chrome → 로컬 서버 요청은 1~3초씩 걸린다(curl은 수 ms). 화면이 준비될 때까지 조건을 확인하며 기다린다. 실패하면 앱 문제인지 테스트 대기 문제인지 먼저 가린다.

로컬 서버 띄우기 (Bash, 백그라운드 실행):
```bash
npx --no-install wrangler pages dev --port 8792 --persist-to "<scratchpad>/wstate-<단계>" > "<scratchpad>/dev.log" 2>&1
```
`Ready on` 줄이 로그에 나올 때까지 기다린 뒤 테스트한다. `.dev.vars`의 `ALLOWED_EMAILS`가 로컬 최고 관리자다.

---

## 1단계: 코드리뷰 → 리뷰 결과대로 수정

1. **리뷰 대상 정하기**: 사용자가 정해 주지 않으면 "마지막 최종점검 이후 변경"을 본다. 커밋 메시지에 `최종점검`이 들어간 마지막 커밋을 찾고(`git log --oneline --grep=최종점검 -1`), 없으면 최근 기능 커밋들을 사용자와 정한다.
2. **리뷰 실행**: 내장 `code-review` 스킬을 Skill 도구로 호출한다(백그라운드 실행됨). 끝나면 지적 목록을 받는다.
3. **지적마다 진짜인지 확인한다.** 리뷰는 검증 없이 후보를 내놓는다. 이 프로젝트에서도 "wrangler.toml 때문에 GOOGLE_CLIENT_ID가 빠진다", "미리보기 배포가 운영 KV를 쓴다"는 실제로는 문제가 아니었다(비밀값 목록·프로젝트 설정으로 확인). 근거를 찾아 `진짜 / 아님(근거)`로 나눈다.
4. **진짜인 것은 모두 고친다.** 중요(important)부터 고치고, 작은 것(nit)도 함께 고친다. 고칠 때 원칙:
   - 권한 판단은 서버(`functions/_middleware.js`)에서만. 화면은 표시만.
   - KV는 사람별 키(`user:`, `pending:`)로 다루고, 문서 하나를 통째로 읽고 쓰지 않는다(늦은 값이 다른 변경을 덮어씀).
   - 다른 사람이 입력한 값(이름·사유 등)은 화면에서 `esc()`로 표시한다.
   - CSS 색상은 `:root` 변수로(작업규칙).
5. 고친 내용은 2단계 테스트로 검증하므로 여기서는 문법 확인(`node --check` 또는 브라우저 로드)까지만 한다.

## 2단계: 기능테스트

로컬 서버(포트 8792)를 띄운 뒤 세 가지를 실행한다.

```bash
node .claude/skills/final-check/scripts/functional-test.mjs "C:/Program Files/Google/Chrome/Application/chrome.exe" "<scratchpad>/chrome-ft" "<scratchpad>"
PORT=8792 node .claude/skills/final-check/scripts/access-security-test.mjs
node .claude/skills/final-check/scripts/kv-outage-test.mjs
```

- `functional-test.mjs` (58개 항목): 헤드리스 Chrome으로 실제 화면을 조작한다. 로그인 보호, 접근 관리 흐름, 대시보드, 사원·현장·자격·근태·급여 CRUD와 검증 규칙, 챗봇 기본·AI 모드(실제 OpenAI 1회 호출), 접근 관리 화면, 설정, 375px 모바일, 콘솔 오류. 스크린샷 `ft-*.png`를 scratchpad에 남긴다.
  - 기대값(재직 36명, 현장 7곳, 경고 18건 등)은 샘플 데이터 v2 기준이다. 샘플을 바꿨다면 스크립트의 기대값도 함께 고친다.
  - 날짜에 따라 달라지는 값(만료 D-day, 경고 건수)은 기준일 2026-11-19 근처에서만 맞다. 날짜 때문에 틀린 것은 앱 오류가 아니니 기대값을 오늘 기준으로 고친다.
- `access-security-test.mjs` (25개 내외): 위조 쿠키, 숨김 파일, CSRF, 권한 상승 시도, 최고 관리자 보호, 본인 권한 변경 금지, 특이 이메일 주소, 회수 유지, 모두 거절.
- `kv-outage-test.mjs` (4개): KV 장애 시 최고 관리자는 들어오고 일반 계정은 503으로 막히는지. 서버 없이 실행된다.

추가로 `file://`에서도 앱이 열리는지(서버 없이 쓰는 경우) 확인한다: 7개 화면이 콘솔 오류 없이 렌더링되면 된다.

실패가 나오면 원인을 찾아 고치고 해당 테스트를 다시 돌린다. 끝나면 `stop-test-servers.ps1`.

## 3단계: 성능테스트 (20명 동시접속)

```bash
node .claude/skills/final-check/scripts/load-test-site.mjs
PORT=8791 node .claude/skills/final-check/scripts/load-test-ai.mjs "C:/Program Files/Google/Chrome/Application/chrome.exe" "<scratchpad>/chrome-load"
```

- **A. 배포 사이트** (`load-test-site.mjs`): 가상 사용자 20명이 60초 동안 접속 흐름을 반복(요청 사이 0.5~1.5초) + 20명 순간 폭주. 약 1,400건, 무료 한도(하루 10만 건)의 1~2%. 로그인 없이 가능한 경로만 측정한다.
  - 로그인 후 경로까지 운영에서 재려면 `SESSION_SECRET`을 알아야 하는데 운영 값은 저장해 두지 않았다. 교체하면 모두 재로그인해야 하므로 **사용자가 원할 때만** 교체하고 새 값은 `.dev.vars`에만 둔다.
- **B. AI 챗봇 20명 동시 질문** (`load-test-ai.mjs`, 로컬 서버 포트 8791 필요): 화면이 실제로 보내는 요청 본문(시스템 프롬프트 + 데이터 요약)을 캡처해 서로 다른 질문 20개를 동시에 보낸다. OpenAI 실제 호출 20회(gpt-4o-mini, 몇 센트 이하) — 비용이 드니 처음 실행할 때 사용자에게 알린다.
  - 답변 내용도 훑어본다. 숫자가 틀리면(예: 퇴사자까지 센 재직 인원) 성능 문제는 아니지만 정확도 문제로 보고한다. 해결책은 집계값을 `aiContextData()`에서 미리 계산해 넘기는 것.
- OpenAI 한도는 키로 짧은 요청 하나를 보내 응답 헤더 `x-ratelimit-limit-requests/tokens`로 확인한다(키는 출력하지 않는다).
- 판정 기준: 오류율 0%, 사이트 p95 < 500ms, AI 응답 p95 < 10초, 429 없음. 기준을 넘으면 원인(콜드스타트, KV 읽기 수, 프롬프트 크기)을 분석해 보고한다.

## 4단계: 보안진단

```bash
bash .claude/skills/final-check/scripts/security-scan.sh
```

자동 점검 항목: 비밀값 유출(git 이력·추적 파일·기타 파일), `.gitignore`·pre-commit 장치, 배포 사이트의 숨김 파일·API 차단·CSRF·HTTPS, 세션 쿠키 속성, 구글 토큰 검증(`email_verified`, `aud`), 외부 스크립트 버전 고정, 보안 헤더(CSP·클릭재킹 방어·HSTS).

자동 점검 뒤 직접 확인할 것(코드를 읽고 판단):
- **XSS**: `index.html`에서 `innerHTML`에 들어가는 값 중 사용자·외부 입력(직원 데이터, 접근 요청 이름·사유, AI 답변)이 모두 `esc()`를 거치는지. 미들웨어의 HTML도 `escapeHtml()`을 거치는지.
- **권한**: 새로 생긴 API 경로가 미들웨어의 권한 확인 뒤에 있는지, 관리자 전용 기능이 서버에서 `isAdmin`을 확인하는지.
- **개인정보**: 주민번호 저장 금지, AI로 연락처·생년월일·계좌가 전송되지 않는지(`aiContextData()`), 샘플이 가상 인물인지.
- **비밀값 흐름**: OpenAI 키가 서버(`env.OPENAI_API_KEY`)에서만 쓰이고 응답·로그로 나가지 않는지.
- 필요하면 내장 `security-review` 스킬로 변경분을 한 번 더 본다.

FAIL은 고친다. WARN(예: 보안 헤더 없음)은 위험도와 해결 방법을 설명하고 사용자에게 고칠지 묻는다 — 헤더 추가는 화면 동작(외부 CDN·구글 로그인)에 영향을 줄 수 있어 시험이 필요하기 때문이다.

---

## 마무리

1. `pwsh -File .claude/skills/final-check/scripts/stop-test-servers.ps1` 로 테스트 서버·브라우저 정리 (남은 프로세스 0개 확인).
2. 고친 것이 있으면 파일을 이름으로 지정해 `git add`하고 커밋한다. 메시지에 `최종점검`을 넣어 다음 점검의 기준점이 되게 한다. pre-commit 장치가 비밀값을 검사한다.
3. `git push origin main` → Cloudflare 자동 배포. `npx --no-install wrangler pages deployment list --project-name hrms-archina`에서 방금 커밋이 성공했는지 확인하고, `security-scan.sh`의 [2] 배포 사이트 항목을 다시 돌려 보호가 유지되는지 본다.
4. 아래 형식으로 보고한다.

## 보고 형식

```
## 최종점검 결과 — <날짜> (커밋 <해시>)

| 단계 | 결과 | 요약 |
|---|---|---|
| ① 코드리뷰·수정 | 지적 N건 → 수정 N건 / 문제 아님 N건 | 주요 수정 한 줄 |
| ② 기능테스트 | 58/58, 접근보안 25/25, KV장애 4/4 | 실패·수정 내용 |
| ③ 성능테스트 | 오류 0%, 사이트 p95 Nms, AI p95 N초 | 한도 대비 여유 |
| ④ 보안진단 | PASS N / FAIL N / WARN N | 남은 위험 |

### 고친 것
### 고치지 않은 것 (이유와 권장 조치)
### 사용자가 직접 확인할 것 (예: 실제 구글 계정 로그인)
```

숫자는 실제 실행 결과만 쓴다. 실행하지 못한 단계는 "실행 안 함"과 이유를 적는다.
