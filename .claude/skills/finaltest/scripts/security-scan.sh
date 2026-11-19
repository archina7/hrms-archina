#!/usr/bin/env bash
# 보안 진단 자동 점검 (Git Bash). 프로젝트 루트에서 실행:
#   bash .claude/skills/finaltest/scripts/security-scan.sh [배포주소]
# 비밀값은 화면에 출력하지 않는다. 키는 앞부분 일부로만 검색한다.
BASE="${1:-https://hrms-archina.pages.dev}"
PASS=0; FAIL=0; WARN=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
warn() { echo "  WARN  $1"; WARN=$((WARN+1)); }

echo "[1] 비밀값 유출"
if [ -f .dev.vars ]; then
  K=$(grep '^OPENAI_API_KEY=' .dev.vars | cut -d= -f2- | tr -d '\r\n')
  if [ -n "$K" ] && [ ${#K} -gt 24 ]; then
    P=${K:0:24}
    [ "$(git log -p --all | grep -c "$P")" = "0" ] && ok "OpenAI 키가 git 커밋 이력에 없음" || bad "OpenAI 키가 git 커밋 이력에 있음 → 즉시 키 교체 필요"
    [ "$(git grep -l "$P" | wc -l)" = "0" ] && ok "OpenAI 키가 추적 파일에 없음" || bad "OpenAI 키가 추적 파일에 있음"
    N=$(grep -rl --exclude=.dev.vars --exclude-dir=.git --exclude-dir=.wrangler --exclude-dir=node_modules "$P" . 2>/dev/null | wc -l)
    [ "$N" = "0" ] && ok "OpenAI 키가 .dev.vars 외 파일에 없음" || bad "OpenAI 키가 .dev.vars 외 파일 ${N}개에 있음"
  else warn ".dev.vars에 OPENAI_API_KEY 없음 (검색 생략)"; fi
fi
git check-ignore -q .dev.vars && ok ".dev.vars가 git 제외 대상" || bad ".dev.vars가 git 제외되지 않음"
[ -z "$(git ls-files | grep -E '(^|/)(\.dev\.vars|\.env)(\..*)?$' | grep -v '\.example$')" ] && ok "비밀 파일이 저장소에 없음" || bad "비밀 파일이 저장소에 있음"
N=$(git grep -nE 'sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}' -- ':!*.example' | wc -l)
[ "$N" = "0" ] && ok "API 키 형태 문자열(sk-...) 없음" || bad "API 키 형태 문자열 ${N}건"
[ -x .git/hooks/pre-commit ] && grep -q 'sk-' .git/hooks/pre-commit && ok "커밋 차단 장치(pre-commit) 설치됨" || warn "커밋 차단 장치(pre-commit) 없음 — 이 PC에서 다시 설치 필요"

echo "[2] 배포 사이트 노출 ($BASE)"
code() { curl -s -o /dev/null -w "%{http_code}" -H "Accept: text/html" "$BASE$1"; }
[ "$(code /)" = "302" ] && ok "로그인 없이 / → 로그인 이동" || bad "로그인 없이 / 응답 $(code /) (302 기대)"
for p in /.dev.vars /.dev.vars.example /.git/config /wrangler.toml /functions/_middleware.js /functions/api/chat.js /.claude/skills/finaltest/SKILL.md; do
  c=$(code "$p"); [ "$c" = "404" ] && ok "$p 숨김" || bad "$p 응답 $c (404 기대)"
done
for p in /api/me /api/access /api/chat; do
  c=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p"); { [ "$c" = "401" ] || [ "$c" = "405" ]; } && ok "$p 로그인 없이 차단($c)" || bad "$p 로그인 없이 응답 $c"
done
c=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "Origin: https://evil.example" -d '{"credential":"a.b.c"}' "$BASE/auth/google")
[ "$c" = "403" ] && ok "다른 사이트에서 로그인 요청 차단(CSRF)" || bad "다른 사이트 로그인 요청 응답 $c (403 기대)"
c=$(curl -s -o /dev/null -w "%{http_code}" "http://${BASE#https://}/login")
case "$c" in 301|308) ok "HTTP → HTTPS 이동($c)";; *) warn "HTTP 접속 응답 $c";; esac

echo "[3] 코드 점검"
grep -q "HttpOnly; Secure; SameSite=Lax" functions/_middleware.js && ok "세션 쿠키 HttpOnly·Secure·SameSite" || bad "세션 쿠키 보안 속성 누락"
grep -q "email_verified" functions/_middleware.js && ok "구글 이메일 인증(email_verified) 확인" || bad "email_verified 확인 없음"
grep -q "claims.aud !== clientId" functions/_middleware.js && ok "구글 토큰 대상(aud) 확인" || bad "aud 확인 없음"
N=$(grep -oE 'src="https?://[^"]+"' index.html | grep -vE '@?[0-9]+\.[0-9]+\.[0-9]+' | wc -l)
[ "$N" = "0" ] && ok "외부 스크립트 버전 고정" || bad "버전 고정 안 된 외부 스크립트 ${N}개"
# 키 값 자체나 브라우저에서 직접 키를 보내는 코드가 있는지 본다 (환경변수 이름을 안내하는 문구는 허용)
grep -qE "x-api-key|Authorization: *['\"\`]Bearer|sk-(proj-|ant-)[A-Za-z0-9_-]{10,}" index.html && bad "index.html에 API 키 또는 키 전송 코드" || ok "index.html에 API 키·키 전송 코드 없음"
H=$(curl -s -D - -o /dev/null "$BASE/login" | tr -d '\r')
echo "$H" | grep -qi '^content-security-policy:' && ok "CSP 보안 헤더" || warn "CSP(Content-Security-Policy) 헤더 없음"
echo "$H" | grep -qiE '^x-frame-options:|frame-ancestors' && ok "다른 사이트 안에 넣기(iframe) 차단 헤더" || warn "X-Frame-Options/frame-ancestors 헤더 없음 (클릭재킹 방어)"
echo "$H" | grep -qi '^strict-transport-security:' && ok "HSTS 헤더" || warn "HSTS(Strict-Transport-Security) 헤더 없음"

echo
echo "보안 자동 점검: PASS ${PASS} / FAIL ${FAIL} / WARN ${WARN}"
[ "$FAIL" = "0" ]
