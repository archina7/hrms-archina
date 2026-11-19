# 건설회사 인사관리시스템 (HRMS)

## 프로젝트 개요
건설회사의 인력·현장 배치·자격/교육·근태/급여를 한 곳에서 관리하고, 인사 챗봇으로 데이터를 질문·조회하는 웹앱.
- 주요 사용자: 본사 인사담당자, 현장소장(현장에서 모바일로 사용)
- 목표: 엑셀로 흩어진 인사 데이터를 통합하고, 현장 배치와 자격 만료를 한눈에 파악

작업 절차와 세부 규칙은 아래 문서를 따른다.
@작업규칙.md

## 기술 스택
- **단일 `index.html`** (HTML + CSS + 바닐라 JavaScript), 빌드 도구·서버 없음
- 외부 라이브러리는 CDN에서 **버전을 고정**해서만 사용 (예: Chart.js 4.4.1, SheetJS xlsx 0.18.5)
- 데이터 저장: 브라우저 `localStorage` + JSON 내보내기/가져오기(백업용), 엑셀(xlsx) 내보내기

## 폴더 구조
```
/
├── index.html          # 앱 본체 (모든 화면과 로직)
├── data/sample.json    # 가상 샘플 데이터 (자동 생성 — 직접 수정 금지)
├── tools/gen-sample.js # sample.json 생성 스크립트
├── functions/
│   ├── _middleware.js  # 구글 로그인 보호 (Cloudflare Pages Functions)
│   └── api/chat.js     # 챗봇 AI 모드 → OpenAI 중계 (OPENAI_API_KEY 사용)
├── .dev.vars           # 로컬 비밀값 (git 제외 — 커밋 금지)
├── .dev.vars.example   # 비밀값 항목 예시 (실제 값 없음)
├── docs/               # 기획·화면 설계 문서
├── CLAUDE.md
└── 작업규칙.md
```

## 핵심 모듈과 데이터 모델

| 모듈 | 컬렉션 | 주요 필드 |
|------|--------|-----------|
| 인력/사원 관리 | `employees` | 사번(empNo), 이름, 부서, 직급, 고용형태(정규/계약/일용), 입사일, 퇴사일, 생년월일, 연락처, 재직상태 |
| 현장 배치 관리 | `sites` | 현장코드, 현장명, 발주처, 공사기간(시작/종료), 현장소장(empNo), 소재지 |
|  | `assignments` | 사번, 현장코드, 배치 시작일, 종료일, 담당업무 |
| 자격증·교육 관리 | `certs` | 사번, 자격 종류(건축기사·안전관리자 등), 취득일, 만료일 |
|  | `trainings` | 사번, 교육명(법정 안전보건교육 등), 이수일, 다음 이수 기한 |
| 근태·급여 | `attendance` | 사번, 날짜, 현장코드, 출역 여부, 근무시간 |
|  | `payroll` | 사번, 귀속월, 기본급/일당, 출역일수, 수당, 공제(4대보험 개략), 실지급액 |

| 인사 챗봇 | `chatLogs` | 질문, 답변, 시각 (최근 100건만 보관) |

- 모든 레코드는 `id`(고유값), `createdAt`, `updatedAt`을 가진다.

## 인사 챗봇
화면 우측 하단 플로팅 버튼으로 여는 대화창. 앱에 저장된 데이터를 자연어로 조회한다.
- 질문 예시: "이번 달 자격증 만료 예정자 알려줘", "OO현장 배치 인원 몇 명이야?", "홍길동 이번 달 출역일수는?", "연차 규정 알려줘"
- **기본 모드(규칙 기반)**: 키워드·패턴 매칭으로 질문 의도를 분류 → `localStorage` 데이터를 조회해 답변. 외부 통신 없음.
- **AI 모드(선택)**: OpenAI를 서버 경유로 호출. 설정 화면에서 모드만 고른다.
  - 흐름: 브라우저 `aiBot()` → `/api/chat` (`functions/api/chat.js`, 구글 로그인 보호) → OpenAI Chat Completions
  - 키: `OPENAI_API_KEY`, 모델: `OPENAI_MODEL`(기본 `gpt-4o-mini`) — **서버 환경 변수로만** 관리
    - 로컬: `.dev.vars` (git 제외, `.dev.vars.example`을 복사해 작성)
    - 배포: Cloudflare 비밀값 `npx wrangler pages secret put OPENAI_API_KEY --project-name hrms-archina`
  - API 키를 `index.html`·저장소·브라우저 저장소에 절대 넣지 않는다. `.git/hooks/pre-commit`이 비밀 파일과 `sk-...` 문자열 커밋을 막는다.
  - `index.html`을 파일로 직접 열면 AI 모드가 동작하지 않는다 (서버 함수가 없음) → 자동으로 기본 모드 답변
  - 질문에 필요한 **최소한의 요약 데이터**만 전송 (연락처·생년월일·계좌 등 민감정보는 전송 금지)
- 답변 못 하는 질문은 "해당 정보를 찾을 수 없습니다"라고 답하고, 관련 메뉴로 이동 링크를 제시한다.
- 챗봇은 **조회 전용** — 데이터 등록·수정·삭제는 하지 않는다.
- 자격증·교육은 **만료/기한 30일 전**부터 대시보드에 경고 표시.

## UI 규칙
- 모든 화면 문구는 **한국어**
- 레이아웃: 좌측 사이드 메뉴(대시보드 / 사원 관리 / 현장 배치 / 자격·교육 / 근태 / 급여 / 설정) + 우측 콘텐츠 (모바일은 상단 가로 메뉴)
- 날짜 표기 `YYYY-MM-DD`, 금액은 천 단위 콤마 + "원" (예: `3,250,000원`)
- 모바일 화면(폭 375px)에서도 사용 가능해야 함 (현장 사용)
- 목록 화면은 검색·필터·정렬 제공

## 개인정보 원칙
- **주민등록번호 저장 금지** (생년월일만 저장)
- 샘플·테스트 데이터는 반드시 **가상 인물**만 사용
- 계좌번호 등 민감정보는 화면에서 일부 마스킹 (예: `123-****-7890`)

## 코드 구조 (index.html)
- `<script id="core">`: DOM을 쓰지 않는 순수 로직 (유틸, 도메인 조회, `calcPayroll`, `getAlerts`, `buildSampleData`)
- 두 번째 `<script>`: 화면(VIEWS), 버튼 동작(ACTIONS, `data-act` 이벤트 위임), 챗봇(INTENTS, `ruleBot`, `aiBot`)

## 샘플 데이터
- 원본은 `index.html`의 `buildSampleData()`이다. 처음 실행하면 이 함수로 샘플이 채워진다.
- 샘플을 바꿀 때는 코드를 수정한 뒤 `node tools/gen-sample.js .`로 `data/sample.json`을 다시 만든다.
- `data/sample.json`은 설정 > JSON 가져오기로 불러올 수 있다.

## 실행 방법
브라우저에서 `index.html` 파일을 직접 연다. (설치 불필요, 엑셀 내보내기만 인터넷 필요)

## 배포
| 항목 | 값 |
|---|---|
| GitHub 저장소 | https://github.com/archina7/hrms-archina (브랜치 `main`, 공개 저장소) |
| Cloudflare Pages | 프로젝트 `hrms-archina` → https://hrms-archina.pages.dev (Git 연동, 빌드 없음, 출력 폴더 `/`) |
| 접속 제한 | `functions/_middleware.js` — 구글 로그인 후 허용 이메일만 접속 |

- `main`에 push하면 Cloudflare가 자동 배포한다. `wrangler pages deploy`로 직접 올리지 않는다.
- 비밀값 `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`(쉼표 구분), `SESSION_SECRET`, `OPENAI_API_KEY`(+선택 `OPENAI_MODEL`)는 Cloudflare 비밀값으로만 둔다. 저장소에 넣지 않는다. 바꾸면 재배포해야 반영된다.
- OpenAI 키를 Cloudflare에 넣을 때는 키를 명령줄에 쓰지 않고 `.dev.vars`에서 바로 넘긴다:
  `grep '^OPENAI_API_KEY=' .dev.vars | cut -d= -f2- | npx wrangler pages secret put OPENAI_API_KEY --project-name hrms-archina`
- 키 값을 화면에 출력하지 않는다 (cat·echo 금지, 확인은 앞 8자와 길이만).
- 공개 저장소이므로 API 키·실제 개인정보를 커밋하지 않는다.
- 인사 데이터는 각 사용자 브라우저(localStorage)에 저장된다. 서버에는 저장되지 않으며 사용자끼리 공유되지 않는다.
