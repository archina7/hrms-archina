// 인사 챗봇 AI 모드 중계 (브라우저 → 이 함수 → OpenAI)
//
// API 키는 브라우저나 저장소에 두지 않고 서버 환경 변수로만 읽는다.
//   OPENAI_API_KEY  OpenAI API 키 (필수, 비밀값)
//   OPENAI_MODEL    사용할 모델 (선택, 기본값 DEFAULT_MODEL)
// 로컬: 프로젝트 루트의 .dev.vars 파일 (git 제외)
// 배포: Cloudflare Pages 비밀값 (npx wrangler pages secret put OPENAI_API_KEY --project-name hrms-archina)
//
// 이 경로도 functions/_middleware.js의 구글 로그인 보호를 거친다.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_SYSTEM_CHARS = 200000;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function validMessages(list) {
  return Array.isArray(list) && list.length >= 1 && list.length <= MAX_MESSAGES && list.every(m =>
    m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= MAX_MESSAGE_CHARS);
}

export async function onRequestPost({ request, env }) {
  if (!env.OPENAI_API_KEY) return json({ error: '서버에 OPENAI_API_KEY가 설정되지 않았습니다' }, 503);

  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) return json({ error: '허용되지 않은 요청입니다' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: '잘못된 요청 형식입니다' }, 400); }
  const { system, messages } = body || {};
  if (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS || !validMessages(messages)) {
    return json({ error: '요청 내용이 올바르지 않거나 너무 깁니다' }, 400);
  }

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || DEFAULT_MODEL,
        messages: [{ role: 'system', content: system }, ...messages],
        max_completion_tokens: 2000,
      }),
    });
  } catch {
    return json({ error: 'OpenAI 서버에 연결하지 못했습니다' }, 502);
  }

  if (!res.ok) {
    // 키 값이나 OpenAI 원문 오류는 브라우저로 보내지 않는다 (오류 종류만 구분)
    let errType = '';
    try { errType = ((await res.json()).error || {}).type || ''; } catch { /* 본문 없음 */ }
    const reason = res.status === 401 ? 'API 키 오류'
      : errType === 'insufficient_quota' ? 'OpenAI 크레딧 부족 (결제 설정에서 충전 필요)'
      : res.status === 429 ? '요청 한도 초과 (잠시 후 다시 시도)'
      : res.status === 404 ? '모델 이름 오류 (OPENAI_MODEL 확인)'
      : `OpenAI 오류 ${res.status}`;
    return json({ error: reason }, 502);
  }

  const data = await res.json();
  const choice = (data.choices || [])[0] || {};
  const text = (choice.message && choice.message.content) || '';
  if (choice.finish_reason === 'content_filter') return json({ text: '이 요청에는 답변할 수 없습니다.' });
  return json({ text });
}

export function onRequest() {
  return json({ error: 'POST만 허용됩니다' }, 405);
}
