/**
 * 노블홍 API — Cloudflare Worker (전체 포팅)
 *
 * 라우트:
 *   POST  /api/consultation/submit              풀폼 상담 접수 (7-Layer + Airtable + TG + Gmail + Cafe24)
 *   POST  /api/consultation/quick               사이드바 간편 (Cafe24 in_course2=5002)
 *   POST  /api/consultation/bar                 하단 가로바 (Cafe24 in_course2=5001)
 *   POST  /api/admin/otp/request                OTP 발급 (Telegram)
 *   POST  /api/admin/otp/verify                 OTP 검증 → JWT 세션 발급
 *   GET   /api/admin/me                         세션 확인
 *   POST  /api/admin/logout                     세션 삭제
 *   GET   /api/admin/consultations/list         상담 목록 (관리자)
 *   POST  /api/admin/consultations/update       상담 상태/메모 수정 (관리자)
 *   POST  /api/admin/consultations/delete       상담 삭제 (관리자)
 *   GET   /api/admin/blacklist/list             블랙리스트 목록 (관리자)
 *   POST  /api/admin/blacklist/add              블랙리스트 추가 (관리자)
 *   POST  /api/admin/blacklist/delete           블랙리스트 삭제 (관리자)
 *   GET|POST /api/admin/content                 콘텐츠 모듈 9종 CRUD (관리자)
 *   POST  /api/admin/upload                     R2 이미지 업로드 (관리자)
 *   GET   /api/content                          공개 콘텐츠 조회
 *   GET   /api/admin/analytics/status           GA4 연결 상태 확인
 *   GET   /api/admin/analytics/summary          GA4 방문통계 D1 스냅샷 조회
 *   POST  /api/admin/analytics/sync             GA4 방문통계 수집 + D1/R2 영속화
 *   GET|POST /api/couple-manager/search         레거시 커플매니저 스크레이핑
 *
 * Bindings: env.BUCKET (R2 "noblehong-r2"), env.DB (D1 "noblehong-db")
 * Secrets (wrangler secret put):
 *   ADMIN_JWT_SECRET,
 *   ADMIN_TG_BOT_TOKEN, ADMIN_TG_CHAT_ID,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_DEBUG_CHAT_ID,
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 *   CRM_ENDPOINT, ADMIN_BYPASS_IPS,
 *   ADMIN_USERNAME, ADMIN_PASSWORD,
 *   GA4_OAUTH_CLIENT_ID, GA4_OAUTH_CLIENT_SECRET, GA4_OAUTH_REFRESH_TOKEN,
 * Vars:
 *   R2_PUBLIC_URL, ALLOWED_ORIGINS,
 *   GMAIL_FROM, GMAIL_TO, CRM_COURSE_CODE,
 *   ADMIN_OTP_TTL (default 300), ADMIN_SESSION_TTL (default 43200),
 *   ADMIN_URL, GA4_PROPERTY_ID
 */

// ─────────────────────────────────────────────────────────────────
// 콘텐츠 모듈 매핑
// ─────────────────────────────────────────────────────────────────
// 콘텐츠 모듈 정의: D1 테이블 + 한글 컬럼 매핑
// table: D1 테이블명
// columns: 모듈별 정형 컬럼 (공통 pinned/정렬/상태/created_at/updated_at 제외)
// boolColumns: checkbox(0/1 ↔ boolean) 변환 대상
const MODULES = {
  press: {
    table: "content_press",
    name: "언론기사",
    primary: "제목",
    dateField: "게시일",
    columns: ["제목", "매체", "링크", "게시일", "썸네일"],
    boolColumns: [],
  },
  campaign: {
    table: "content_campaign",
    name: "공익캠페인",
    primary: "제목",
    dateField: "게시일",
    columns: ["제목", "본문", "게시일", "썸네일"],
    boolColumns: [],
  },
  awards: {
    table: "content_awards",
    name: "수상내역",
    primary: "제목",
    dateField: "수상일",
    columns: ["제목", "기관", "수상일", "증빙이미지"],
    boolColumns: [],
  },
  notice: {
    table: "content_notice",
    name: "공지사항",
    primary: "제목",
    dateField: "게시일",
    columns: ["제목", "본문", "게시일", "첨부이미지"],
    boolColumns: [],
  },
  mou: {
    table: "content_mou",
    name: "MOU",
    primary: "제휴사",
    dateField: "체결일",
    columns: ["제휴사", "체결일", "사진", "설명"],
    boolColumns: [],
  },
  lovecol: {
    table: "content_lovecol",
    name: "러브칼럼",
    primary: "제목",
    dateField: "게시일",
    columns: ["제목", "본문", "저자", "게시일", "썸네일"],
    boolColumns: [],
  },
  youtube: {
    table: "content_youtube",
    name: "유튜브영상",
    primary: "제목",
    dateField: "게시일",
    columns: [
      "제목",
      "영상타입",
      "YouTubeURL",
      "설명",
      "썸네일",
      "게시일",
      "자동수집",
    ],
    boolColumns: ["자동수집"],
  },
  instagram: {
    table: "content_instagram",
    name: "인스타그램",
    primary: "제목",
    dateField: "게시일",
    columns: ["제목", "표지이미지", "게시글링크", "짧은내용", "게시일"],
    boolColumns: [],
  },
  blog: {
    table: "content_blog",
    name: "네이버블로그",
    primary: "제목",
    dateField: "게시일",
    columns: ["제목", "표지이미지", "게시글링크", "짧은내용", "게시일"],
    boolColumns: [],
  },
};

const ALLOWED_UPLOAD_MODULES = new Set([
  "press",
  "campaign",
  "awards",
  "notice",
  "mou",
  "lovecol",
  "youtube",
  "instagram",
  "blog",
  "shared",
]);

const VALID_STATUS = ["접수", "상담중", "완료", "거절", "보류"];
const MIN_SUBMIT_MS = 3000;
const RATE_LIMIT_PER_HOUR = 10;

// ─────────────────────────────────────────────────────────────────
// 응답/CORS
// ─────────────────────────────────────────────────────────────────
function json(body, status = 200, extra = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const vercelPreview =
    /^https:\/\/[a-z0-9-]+(-noblehong0-9075s-projects)?\.vercel\.app$/;
  const ok = allowed.includes(origin) || vercelPreview.test(origin);
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
  if (ok) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function mergeHeaders(response, extraHeaders) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
    else h.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers: h });
}

// ─────────────────────────────────────────────────────────────────
// 쿠키
// ─────────────────────────────────────────────────────────────────
function parseCookies(request) {
  const raw = request.headers.get("cookie") || "";
  const out = {};
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i < 0) return;
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────
// base64url / utf8
// ─────────────────────────────────────────────────────────────────
function b64uDecode(str) {
  const s =
    str.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64uEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8Base64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function utf8Base64url(str) {
  return utf8Base64(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─────────────────────────────────────────────────────────────────
// Crypto 헬퍼
// ─────────────────────────────────────────────────────────────────
async function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function hmacSign(data, secret) {
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return b64uEncode(new Uint8Array(sig));
}

async function hmacVerify(data, signatureB64u, secret) {
  const key = await hmacKey(secret, ["verify"]);
  const sig = b64uDecode(signatureB64u);
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomOTP() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}

// ─────────────────────────────────────────────────────────────────
// JWT (HS256)
// ─────────────────────────────────────────────────────────────────
async function signJWT(payload, secret, expSec) {
  const header = utf8Base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = utf8Base64url(
    JSON.stringify({ ...payload, iat: now, exp: now + expSec }),
  );
  const sig = await hmacSign(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  try {
    const valid = await hmacVerify(`${h}.${b}`, s, secret);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(b)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000))
      return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireAuth(request, env) {
  const secret = env.ADMIN_JWT_SECRET;
  if (!secret) return { error: json({ error: "Server misconfigured" }, 500) };
  const cookies = parseCookies(request);
  const auth = await verifyJWT(cookies.admin_session, secret);
  if (!auth) return { error: json({ error: "Not authenticated" }, 401) };
  return { auth };
}

// ─────────────────────────────────────────────────────────────────
// 공용 헬퍼
// ─────────────────────────────────────────────────────────────────
// Vercel/CDN 등 신뢰할 수 있는 프록시를 거친 요청은 cf-connecting-ip가 프록시 서버 IP로
// 잡히고 진짜 사용자 IP는 x-forwarded-for 첫 항목에 들어온다. Origin이 ALLOWED_ORIGINS에
// 매칭될 때만 xff를 신뢰해서 IP 위조 공격(직접 Worker 호출 + 임의 xff)을 차단한다.
function clientIP(request, env) {
  const cfIp = request.headers.get("cf-connecting-ip") || "";
  const xff = (request.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  if (!xff) return cfIp;
  const origin = request.headers.get("origin") || "";
  const allowedList = String(env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowedList.includes(origin) ? xff : cfIp;
}

// 관리자/테스트 IP 화이트리스트 — MIN_SUBMIT_MS 가드 + Airtable rate limit 우회
function isBypassedIP(env, ip) {
  if (!ip || !env.ADMIN_BYPASS_IPS) return false;
  return String(env.ADMIN_BYPASS_IPS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(ip);
}

function str(v, max = 500) {
  return String(v || "")
    .trim()
    .slice(0, max);
}

// 자유입력 단일라인 정화: 제어문자·개행 → 공백, 연속공백 축소, trim, 길이 컷.
// 줄바꿈 폭주·구조 스푸핑·제어문자 주입을 무력화한다 (CRM/Telegram/D1 공통 위생).
// SQL 인젝션은 D1 바인딩 + cafe24 SQLInject + encodeURIComponent로 이미 실행 차단됨.
function cleanLine(v, max = 100) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// KST 시간 포맷 ("2026.04.27 19:34")
function formatKoreanDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${yy}.${mm}.${dd} ${hh}:${mi}`;
}

const SOURCE_LABEL = {
  quick: "사이드바",
  bar: "하단바",
  submit: "상담문의",
  "fall-meeting": "가을미팅신청",
  meta: "Meta 광고",
  "meta-ig": "Meta · Instagram",
  "meta-fb": "Meta · Facebook",
};

// 접수 알림 공통 포맷 — 굵은 헤더 + 구분선 + `- <b>라벨</b>  값` (이모지/IP 없음)
// 접수경로(홈페이지 폼 3종 / Meta)가 달라도 같은 모양으로 나가야 한다.
function buildLeadMessage(env, headerLabel, rows, recordId) {
  const adminBase = env.ADMIN_URL || "https://noblehong.vercel.app/admin";
  const adminLink = `${adminBase}/?id=${encodeURIComponent(recordId || "")}`;
  const bodyLines = rows
    .filter(([, v]) => v && String(v).trim() !== "")
    .map(([k, v]) => `- <b>${escapeHtml(k)}</b>  ${escapeHtml(v)}`);
  const divider = "─────────────────────";
  return [
    `<b>[새 상담 접수]</b> ${escapeHtml(headerLabel)}`,
    divider,
    ...bodyLines,
    divider,
    `<a href="${escapeHtml(adminLink)}">어드민에서 열기 →</a>`,
  ].join("\n");
}

// 홈페이지 폼 접수 알림 (일반 채널)
function buildConsultMessage(env, source, fields, recordId) {
  const personalBits = [];
  if (fields.gender) personalBits.push(fields.gender);
  if (fields.birthYear) personalBits.push(String(fields.birthYear));
  if (fields.marriage) personalBits.push(fields.marriage);
  const addr = fields.address
    ? fields.address + (fields.addressDetail ? " " + fields.addressDetail : "")
    : "";
  const msg = String(fields.message || "");
  return buildLeadMessage(
    env,
    SOURCE_LABEL[source] || source,
    [
      ["이름", fields.name],
      ["인적사항", personalBits.join(" · ")],
      ["연락처", fields.phone],
      ["지역", addr],
      ["상담내용", msg.length > 100 ? msg.slice(0, 100) + "…" : msg],
      ["접수시각", formatKoreanDate()],
    ],
    recordId,
  );
}

// 채널 이름 → 토큰. 미배달 재발송(tgOutboxFlush)이 이 매핑으로 원래 채널을 복원한다.
function tgTokenFor(env, channel) {
  if (channel === "인프라")
    return (
      env.INFRA_TG_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN
    );
  if (channel === "디버그")
    return env.ADMIN_TG_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  return env.TELEGRAM_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN;
}

// 일반 접수 채널 (사장님이 보는 채널)
function tgConsult(env, source, fields, recordId) {
  const token = env.TELEGRAM_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || env.ADMIN_TG_CHAT_ID;
  return tgSend(env, token, chatId, buildConsultMessage(env, source, fields, recordId), {
    channel: "접수",
  });
}

// 디버그/에러 채널 — 관리자/에러 봇 우선, 없으면 일반 채널 폴백
function tgDebug(env, message) {
  const token = env.ADMIN_TG_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const chatId =
    env.TELEGRAM_DEBUG_CHAT_ID || env.ADMIN_TG_CHAT_ID || env.TELEGRAM_CHAT_ID;
  return tgSend(env, token, chatId, message, { channel: "디버그" });
}

// 인프라 장애 채널 — 리드 알림봇 오염 방지용 별도 채널. 미설정 시 tgDebug 폴백
//
// 이 경로는 "장애를 알리는 경로" 자체다. 여기서 또 실패를 알리려 들면 재귀가 된다.
// 그래서 폴백도 추적도 끄고(silent), 결과는 health_state 기록으로만 남긴다 —
// 그 기록은 아이맥 폴러가 하트비트 응답으로 받아 시간당 리포트에 싣는다.
function sendInfraAlert(env, message, opts = {}) {
  if (env.INFRA_TG_BOT_TOKEN && env.INFRA_TG_CHAT_ID)
    return tgSend(env, env.INFRA_TG_BOT_TOKEN, env.INFRA_TG_CHAT_ID, message, {
      channel: "인프라",
      silent: !!opts.silent,
    });
  return tgDebug(env, message);
}

// ─────────────────────────────────────────────────────────────────
// 헬스체크 — 이 크론은 "데드맨 스위치" 하나만 본다.
//
// 사이트 접수경로 프로브(폼 3종 + 홈/자산/cleanUrls)는 2026-07-25부로
// 아이맥 폴러가 1시간마다 직접 돈다. 아이맥은 진짜 외부 시점이고 주기도 6배 촘촘해서
// 워커가 같은 걸 6시간마다 또 찌르는 건 중복이었다.
//
// 대신 아이맥이 못 하는 것 하나가 남는다 — 자기 자신의 죽음.
// 아이맥이 꺼지면 체크도 알림도 멈추는데 그 침묵은 "정상"과 구분되지 않는다.
// 그리고 아이맥이 멈춘 상태 = Meta 접수 전면 정지(자체 폼 유입은 사실상 0)다.
// 그 침묵을 여기서 하트비트 노후로 잡는다.
// ─────────────────────────────────────────────────────────────────

// 아이맥 폴러 생존 확인 — Meta 접수는 폴러가 유일한 경로라 폴러 침묵 = 접수 정지다.
// 폴링 주기 1시간의 3배를 넘도록 하트비트가 없으면 장애로 본다(1회 실패는 다음 정각에 자연 복구).
const POLLER_STALE_HOURS = 3;

async function probeMetaPoller(env) {
  const p = {
    name: "Meta 폴러 하트비트",
    expect: `${POLLER_STALE_HOURS}시간 이내`,
  };
  try {
    const r = await env.DB.prepare(
      `SELECT checked_at, detail FROM health_state WHERE id = 'meta_poller'`,
    ).first();
    // 아직 한 번도 안 찍힘 = 폴러 미배포 상태. 전환 전에 오보를 내지 않도록 통과시킨다.
    if (!r?.checked_at)
      return { ...p, got: "기록없음(폴러 미배포)", ok: true, reachable: true };
    const ageMs = Date.now() - Date.parse(r.checked_at);
    if (!Number.isFinite(ageMs))
      return { ...p, got: "시각 파싱불가", ok: false, reachable: false };
    return {
      ...p,
      got: `${Math.round(ageMs / 60000)}분 전`,
      ok: ageMs <= POLLER_STALE_HOURS * 3600 * 1000,
      reachable: true,
    };
  } catch (e) {
    return {
      ...p,
      got: "ERR:" + String(e?.message || e).slice(0, 60),
      ok: false,
      reachable: false,
    };
  }
}

async function readHealthState(env) {
  try {
    const r = await env.DB.prepare(
      `SELECT status, since FROM health_state WHERE id = 'site'`,
    ).first();
    return r || null;
  } catch {
    return null;
  }
}

async function writeHealthState(env, status, detail, since) {
  try {
    await env.DB.prepare(
      `INSERT INTO health_state (id, status, detail, since, checked_at)
       VALUES ('site', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         detail = excluded.detail,
         since = excluded.since,
         checked_at = excluded.checked_at`,
    )
      .bind(status, detail, since, new Date().toISOString())
      .run();
  } catch (e) {
    // 상태 저장 실패해도 체크 자체는 계속 — 다만 스팸 방지가 풀리므로 알림
    await sendInfraAlert(
      env,
      `[노블홍/healthcheck] 상태 저장 실패 — ${String(e?.message || e).slice(0, 120)}`,
    );
  }
}

async function runHealthCheck(env) {
  const poller = await probeMetaPoller(env);
  const nowIso = new Date().toISOString();

  // 3단계 판정 — degraded 를 조용히 ok 로 접으면 "정상" 오판이 난다.
  //   fail     : 하트비트가 노후 → 폴러 정지 = Meta 접수 정지
  //   degraded : 상태 조회 자체가 실패 → 판정 불가(D1 문제일 수 있음)
  //   ok       : 하트비트 신선
  const status = poller.ok ? "ok" : poller.reachable ? "fail" : "degraded";

  const prev = await readHealthState(env);
  const prevStatus = prev?.status || "unknown";
  const detail = poller.ok
    ? ""
    : `${poller.name} ${poller.expect}→${poller.got}`.slice(0, 400);

  // 상태 변화시에만 알림 (지속 장애 스팸 0)
  if (status !== prevStatus) {
    if (status === "fail") {
      await sendInfraAlert(
        env,
        `<b>[노블홍/healthcheck] 🔴 Meta 접수 정지 의심</b>\n──────────────\n` +
          `- <b>${poller.name}</b>  기대 ${poller.expect} → 실제 ${poller.got}` +
          `\n- <b>감지시각</b>  ${nowIso}` +
          `\n\n※ 폴러가 멈추면 Meta 접수가 통째로 끊긴다(자체 폼 유입 사실상 0).\n` +
          `아이맥 전원/네트워크 확인 후:\n` +
          `<code>launchctl kickstart -k gui/501/com.noblehong.meta-lead-poller</code>\n` +
          `로그: <code>tail -20 ~/noblehong-meta-lead-poller/logs/worker.log</code>`,
      );
    } else if (status === "degraded") {
      await sendInfraAlert(
        env,
        `<b>[노블홍/healthcheck] ⚠️ 판정 불가</b>\n──────────────\n` +
          `- <b>${poller.name}</b>  ${String(poller.got).slice(0, 70)}` +
          `\n- <b>시각</b>  ${nowIso}` +
          `\n\n※ 폴러 장애가 아니라 D1/체커 문제일 수 있음. 수동 확인 필요.`,
      );
    } else {
      const downFrom = prev?.since
        ? `\n- <b>직전 이상 시작</b>  ${prev.since}`
        : "";
      await sendInfraAlert(
        env,
        `<b>[노블홍/healthcheck] 🟢 폴러 정상 복구</b>\n──────────────\n` +
          `- <b>${poller.name}</b>  ${poller.got}${downFrom}` +
          `\n- <b>복구시각</b>  ${nowIso}`,
      );
    }
    await writeHealthState(env, status, detail, nowIso);
  } else {
    await writeHealthState(env, status, detail, prev?.since || nowIso);
  }
  return { status, detail };
}

// ─────────────────────────────────────────────────────────────────
// 텔레그램 전송 — 실패를 삼키지 않는다.
//
// 이전 구현은 fetch 응답 코드를 보지 않고 catch {} 로 전부 삼켰다. 그래서 봇 토큰이
// 죽어도 "접수는 D1·카페24까지 멀쩡히 처리되는데 알림만 안 오는" 무성 실패가 났고,
// 경보가 하나도 뜨지 않아 사람이 눈치챌 때까지 시간이 걸렸다(2026-09 봇토큰 교체 사고).
//
// 자가복구 3단 —
//   1) 일시 오류(429·5xx·네트워크)는 백오프를 두고 재시도한다.
//   2) 그래도 실패하면 인프라 채널로 원문을 폴백 전송한다. 채널이 바뀔지언정
//      알림 자체는 살린다.
//   3) 폴백까지 실패하면 tg_outbox 에 적재하고 크론이 재발송한다.
//      토큰을 갈아끼우면 밀린 알림이 그때 자동으로 배달된다.
//
// 감지 — health_state('tg_delivery') 에 기록하고 상태가 바뀔 때만 인프라봇에 알린다.
// ─────────────────────────────────────────────────────────────────
const TG_MAX_RETRY = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 토큰 무효·채팅 없음은 몇 번을 더 보내도 결과가 같다. 재시도는 일시 오류에만 쓴다.
function tgPermanent(status) {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

async function tgPost(token, chatId, text) {
  if (!token || !chatId)
    return { ok: false, reason: "토큰/채널 미설정", permanent: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    if (r.ok) return { ok: true };
    let desc = "";
    try {
      desc = String((await r.json())?.description || "").slice(0, 120);
    } catch {}
    return {
      ok: false,
      reason: `HTTP ${r.status}${desc ? " " + desc : ""}`,
      permanent: tgPermanent(r.status),
    };
  } catch (e) {
    return {
      ok: false,
      reason: String(e?.message || e).slice(0, 120),
      permanent: false,
    };
  }
}

// 재시도까지 포함한 채널 1개 전송
async function tgDeliver(token, chatId, text) {
  let last = { ok: false, reason: "미시도", permanent: false };
  for (let i = 0; i <= TG_MAX_RETRY; i++) {
    last = await tgPost(token, chatId, text);
    if (last.ok || last.permanent) return last;
    await sleep(400 * (i + 1));
  }
  return last;
}

// 미배달 알림 적재. 테이블이 없어도 본 흐름(접수 처리)을 막지 않는다.
async function tgOutboxPush(env, channel, chatId, text, reason) {
  if (!env.DB) return false;
  try {
    await env.DB.prepare(
      `INSERT INTO tg_outbox (channel, chat_id, text, tries, last_error, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
      .bind(
        channel,
        String(chatId || ""),
        text,
        String(reason || "").slice(0, 200),
        new Date().toISOString(),
      )
      .run();
    return true;
  } catch {
    return false;
  }
}

// 전송 계통 상태 기록 + 상태가 바뀔 때만 알림(지속 장애 스팸 0)
async function tgRecordHealth(env, channel, res, queued) {
  if (!env.DB) return;
  const nowIso = new Date().toISOString();
  const status = res.ok ? "ok" : "fail";
  let prev = null;
  try {
    prev = await env.DB.prepare(
      `SELECT status, since FROM health_state WHERE id = 'tg_delivery'`,
    ).first();
  } catch {}
  const prevStatus = prev?.status || "unknown";
  const detail = res.ok
    ? ""
    : `${channel}: ${res.reason}${queued ? " · 큐 적재" : " · 유실"}`.slice(
        0,
        400,
      );
  const since = status === prevStatus && prev?.since ? prev.since : nowIso;

  try {
    await env.DB.prepare(
      `INSERT INTO health_state (id, status, detail, since, checked_at)
       VALUES ('tg_delivery', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         detail = excluded.detail,
         since = excluded.since,
         checked_at = excluded.checked_at`,
    )
      .bind(status, detail, since, nowIso)
      .run();
  } catch {}

  if (status === prevStatus) return;

  if (status === "fail") {
    await sendInfraAlert(
      env,
      `<b>[노블홍/telegram] 🔴 알림 전송 실패</b>\n──────────────\n` +
        `- <b>경로</b>  ${escapeHtml(channel)}\n` +
        `- <b>사유</b>  ${escapeHtml(res.reason)}\n` +
        `- <b>미배달</b>  ${queued ? "tg_outbox 적재 · 복구되면 자동 재발송" : "적재 실패 — 유실"}\n` +
        `- <b>감지시각</b>  ${nowIso}\n\n` +
        `※ 접수 자체는 D1·카페24까지 정상 처리된다. 끊긴 것은 알림뿐이다.\n` +
        `봇 토큰을 교체했다면 워커 시크릿도 같이 갈아야 한다.`,
      { silent: true },
    );
  } else {
    await sendInfraAlert(
      env,
      `<b>[노블홍/telegram] 🟢 알림 전송 복구</b>\n──────────────\n` +
        `- <b>경로</b>  ${escapeHtml(channel)}\n` +
        (prev?.since ? `- <b>장애 시작</b>  ${prev.since}\n` : "") +
        `- <b>복구시각</b>  ${nowIso}`,
      { silent: true },
    );
  }
}

// 채널 1개 전송 + 자가복구 + 감지.
// silent 는 인프라 경로 전용이다 — 알림 경로가 자기 실패를 또 알리면 재귀가 된다.
async function tgSend(env, token, chatId, text, opts = {}) {
  const { channel = "일반", silent = false } = opts;
  const res = await tgDeliver(token, chatId, text);

  if (res.ok) {
    if (!silent) await tgRecordHealth(env, channel, res, false);
    return res;
  }

  // 자가복구 2 — 인프라 채널로 원문을 돌려보낸다(인프라 경로 자신은 제외)
  let recovered = false;
  if (
    !silent &&
    channel !== "인프라" &&
    env.INFRA_TG_BOT_TOKEN &&
    env.INFRA_TG_CHAT_ID
  ) {
    const fb = await tgDeliver(
      env.INFRA_TG_BOT_TOKEN,
      env.INFRA_TG_CHAT_ID,
      `<b>[노블홍/telegram] ↪️ ${escapeHtml(channel)} 채널 대체 배달</b>\n` +
        `<i>원래 채널 전송 실패: ${escapeHtml(res.reason)}</i>\n──────────────\n` +
        text,
    );
    recovered = fb.ok;
  }

  // 자가복구 3 — 대체 배달도 안 되면 적재해 두고 크론이 다시 시도한다
  let queued = false;
  if (!recovered) queued = await tgOutboxPush(env, channel, chatId, text, res.reason);

  if (!silent) await tgRecordHealth(env, channel, res, queued || recovered);
  return res;
}

// 미배달 재발송 — 크론(6시간)이 돈다. 토큰을 갈아끼우면 밀린 알림이 여기서 나간다.
async function tgOutboxFlush(env, limit = 25) {
  if (!env.DB) return { sent: 0, left: 0 };
  let rows = [];
  try {
    rows =
      (
        await env.DB.prepare(
          `SELECT id, channel, chat_id, text FROM tg_outbox ORDER BY id LIMIT ?`,
        )
          .bind(limit)
          .all()
      )?.results || [];
  } catch {
    return { sent: 0, left: 0 };
  }

  let sent = 0;
  for (const row of rows) {
    const token = tgTokenFor(env, row.channel);
    const r = await tgDeliver(token, row.chat_id, row.text);
    if (r.ok) {
      sent++;
      try {
        await env.DB.prepare(`DELETE FROM tg_outbox WHERE id = ?`)
          .bind(row.id)
          .run();
      } catch {}
      continue;
    }
    try {
      await env.DB.prepare(
        `UPDATE tg_outbox SET tries = tries + 1, last_error = ? WHERE id = ?`,
      )
        .bind(String(r.reason).slice(0, 200), row.id)
        .run();
    } catch {}
    // 토큰이 아직 죽어 있으면 남은 것도 같은 결과다. 헛돌지 않고 다음 크론에 미룬다.
    if (r.permanent) break;
  }

  let left = 0;
  try {
    left =
      (await env.DB.prepare(`SELECT COUNT(*) AS c FROM tg_outbox`).first())?.c ||
      0;
  } catch {}
  return { sent, left };
}

// 알림 계통 요약 — 하트비트 응답에 실어 아이맥 폴러 리포트에 노출한다.
async function tgSummary(env) {
  if (!env.DB) return null;
  try {
    const st = await env.DB.prepare(
      `SELECT status, detail, since FROM health_state WHERE id = 'tg_delivery'`,
    ).first();
    let queued = 0;
    try {
      queued =
        (await env.DB.prepare(`SELECT COUNT(*) AS c FROM tg_outbox`).first())
          ?.c || 0;
    } catch {}
    return {
      status: st?.status || "unknown",
      detail: st?.detail || "",
      since: st?.since || "",
      queued,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Airtable rate limit (공통 — 상담 3종 submit/quick/bar에서 사용)
// ─────────────────────────────────────────────────────────────────
async function checkRateLimit(env, ip) {
  if (!ip) return { limited: false };
  if (isBypassedIP(env, ip)) return { limited: false };
  if (!env.DB) return { limited: false };
  const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM consultations WHERE "IP" = ? AND "제출일시" > ?`,
    )
      .bind(ip, oneHourAgo)
      .first();
    return { limited: (r?.c || 0) >= RATE_LIMIT_PER_HOUR };
  } catch {
    return { limited: false };
  }
}

// Airtable 호환 record id ('rec' + 14자 alphanumeric)
function generateRecordId() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.getRandomValues(new Uint8Array(14));
  let s = "rec";
  for (let i = 0; i < 14; i++) s += chars[buf[i] % 62];
  return s;
}

function generateBlacklistId() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.getRandomValues(new Uint8Array(14));
  let s = "bl";
  for (let i = 0; i < 14; i++) s += chars[buf[i] % 62];
  return s;
}

// 연락처 정규화 (숫자만 추출) — 블랙리스트 저장/매칭 키
function normalizePhone(p) {
  return String(p || "").replace(/[^0-9]/g, "");
}

// 블랙리스트 매칭 — phone(숫자만) 정확 일치. DB 에러는 false(차단 안 함)로 처리해 가용성 보장
async function checkBlacklist(env, phone) {
  if (!env || !env.DB) return false;
  const digits = normalizePhone(phone);
  if (!digits) return false;
  try {
    const r = await env.DB.prepare(
      `SELECT id FROM blacklist WHERE 연락처 = ? LIMIT 1`,
    )
      .bind(digits)
      .first();
    return !!r;
  } catch {
    return false;
  }
}

const CONSULT_COLUMNS = [
  "id",
  "이름",
  "연락처",
  "성별",
  "혼인여부",
  "출생연도",
  "주소",
  "상세주소",
  "문의내용",
  "관리자메모",
  "개인정보동의",
  "마케팅동의",
  "상태",
  "출처",
  "IP",
  "UserAgent",
  "Referrer",
  "제출일시",
  "createdTime",
  "접속국가",
  "접속지역",
  "접속도시",
  "방문쿠키",
];

async function saveConsultation(env, fields) {
  if (!env.DB) return { error: "DB binding not configured" };
  const id = generateRecordId();
  const now = fields["제출일시"] || new Date().toISOString();
  const values = [
    id,
    fields["이름"] || "",
    fields["연락처"] || "",
    fields["성별"] || null,
    fields["혼인여부"] || null,
    fields["출생연도"] || null,
    fields["주소"] || null,
    fields["상세주소"] || null,
    fields["문의내용"] || null,
    fields["관리자메모"] || null,
    fields["개인정보동의"] ? 1 : 0,
    fields["마케팅동의"] ? 1 : 0,
    fields["상태"] || "접수",
    fields["출처"] || null,
    fields["IP"] || null,
    fields["UserAgent"] || null,
    fields["Referrer"] || null,
    now,
    now,
    fields["접속국가"] || null,
    fields["접속지역"] || null,
    fields["접속도시"] || null,
    fields["방문쿠키"] || null,
  ];
  const placeholders = CONSULT_COLUMNS.map(() => "?").join(",");
  const cols = CONSULT_COLUMNS.map((c) => `"${c}"`).join(",");
  try {
    await env.DB.prepare(
      `INSERT INTO consultations (${cols}) VALUES (${placeholders})`,
    )
      .bind(...values)
      .run();
    return { id };
  } catch (e) {
    return { error: String(e?.message || e).slice(0, 200) };
  }
}

// D1 row → Airtable 호환 응답 객체로 변환
function rowToAirtableShape(row) {
  if (!row) return null;
  const { id, createdTime, ...rest } = row;
  // boolean 컬럼 정규화 (D1은 INTEGER 0/1로 저장)
  if ("개인정보동의" in rest) rest["개인정보동의"] = !!rest["개인정보동의"];
  if ("마케팅동의" in rest) rest["마케팅동의"] = !!rest["마케팅동의"];
  // null 필드 제거 (Airtable 응답 형태와 비슷하게)
  const fields = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== null && v !== undefined && v !== "") fields[k] = v;
  }
  return { id, fields, createdTime };
}

// Worker 응답 후에도 비동기 작업(카페24 POST, Gmail 전송 등) 완료를 보장
function bgRun(env, promise) {
  if (env && env.__ctx && typeof env.__ctx.waitUntil === "function") {
    env.__ctx.waitUntil(promise);
  }
  return promise;
}

// ─────────────────────────────────────────────────────────────────
// Cafe24 CRM POST — UTF-8 인코딩 + 원본 폼(sub02_05_1.html) 필드 구조 재현
//   u_hp1/u_hp2/u_hp3 분할, agree1/agree2 포함, charset=UTF-8
// 카페24 호스팅의 ASP는 inc_top.html의 `Response.CharSet="utf-8"` /
// `<meta charset=utf-8>` 흐름으로 form 데이터를 UTF-8로 디코드한다.
// (DBConnect.asp의 `Session.Codepage = 949`는 주석 처리되어 있음.)
// EUC-KR로 보내면 한글이 UTF-8로 잘못 디코드 → MSSQL varchar에 `?` 폴백.
// ─────────────────────────────────────────────────────────────────
function buildForm(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

// 2자리 연도 → 4자리 피벗 (예: 58 → 1958, 05 → 2005, 기준: 올해 2자리)
function pivotYY(yy, cy) {
  return yy <= cy % 100 ? 2000 + yy : 1900 + yy;
}
// 생년 보정식: 잡다한 형식의 생년 입력을 유효 4자리 연도로 정규화해 일정한 값만 cafe24로 전송.
//  복원: "1962"→"1962" | "82"→"1982" | "19627016"·"1972년"·"1998.0"·"1991, 12,"→앞 4자리 연도
//  복원불가/미입력("", "*", "9182", "느금마" 등) → "1911" (미상·오류 공통 센티넬)
//    → 상담원이 "1911"을 보면 '생년 미입력 또는 잘못된 값'임을 즉시 인지 가능
//  ※ cafe24 m_birthY 컬럼이 varchar(4)라 4자리 초과 숫자를 보내면 '*'로 깨짐 → 반드시 4자리로.
const BIRTHY_UNKNOWN = "1911"; // 미상/오류 공통값 (현재 고객층에 실재 불가능한 연도라 식별 용이)
function normBirthYear(raw) {
  const cy = new Date().getFullYear();
  const MIN_Y = 1925;
  const MAX_Y = cy - 18;
  const d = String(raw == null ? "" : raw).replace(/\D/g, "");
  let y = null;
  if (d.length >= 4) {
    const h4 = parseInt(d.slice(0, 4), 10);
    if (h4 >= MIN_Y && h4 <= MAX_Y) y = h4;
    else if (d.length > 4) y = pivotYY(parseInt(d.slice(0, 2), 10), cy);
  } else if (d.length === 2 || d.length === 3) {
    y = pivotYY(parseInt(d.slice(0, 2), 10), cy);
  }
  return y != null && y >= MIN_Y && y <= MAX_Y ? String(y) : BIRTHY_UNKNOWN;
}

// 카페24 전송 결과를 접수 레코드에 남긴다.
// 전송은 fire-and-forget 이라 지금까진 실패해야만 디버그 채널에 흔적이 남고
// "잘 들어갔다"는 아무 데도 안 남았다. 시간당 리포트로 답하려면 성공도 기록해야 한다.
// 기록 자체가 실패해도 접수/전송에는 영향 없다(조용히 넘어간다).
async function recordCafe24Result(env, recordId, status) {
  if (!env?.DB || !recordId) return;
  try {
    await env.DB.prepare(`UPDATE consultations SET cafe24 = ? WHERE id = ?`)
      .bind(String(status).slice(0, 120), recordId)
      .run();
  } catch {}
}

// 최근 N시간 카페24 전송 집계 — 하트비트 응답으로 아이맥에 돌려줘 시간당 리포트에 싣는다
async function cafe24Summary(env, hours = 24) {
  try {
    const r = await env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN cafe24 = 'ok' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN cafe24 LIKE 'fail:%' THEN 1 ELSE 0 END) AS fail
       FROM consultations
       WHERE 제출일시 >= datetime('now', ?)`,
    )
      .bind(`-${Number(hours) || 24} hours`)
      .first();
    return {
      hours,
      total: r?.total || 0,
      ok: r?.ok || 0,
      fail: r?.fail || 0,
    };
  } catch {
    return null;
  }
}

async function postToCafe24(env, fields, { suppressDebug = false } = {}) {
  if (!env.CRM_ENDPOINT) throw new Error("CRM_ENDPOINT not configured");

  // 전화번호 분할 (원본 폼과 동일: u_hp1/u_hp2/u_hp3)
  const hp = String(fields.u_hp || "")
    .replace(/[^0-9]/g, "")
    .slice(0, 11);
  const hp1 = hp.slice(0, 3);
  const hp2 = hp.length === 11 ? hp.slice(3, 7) : hp.slice(3, 6);
  const hp3 = hp.length === 11 ? hp.slice(7, 11) : hp.slice(6, 10);

  const params = {
    in_course2: fields.in_course2 || "5002",
    in_course_desc: String(fields.in_course_desc || "").slice(0, 30),
    u_name: cleanLine(fields.u_name, 8),
    u_hp1: hp1,
    u_hp2: hp2,
    u_hp3: hp3,
    u_gender: fields.u_gender || "",
    u_married: fields.u_married || "",
    u_birthY: normBirthYear(fields.u_birthY),
    u_memo: cleanLine(fields.u_memo, 300),
    agree1: fields.agree1 || "Y",
    agree2: fields.agree2 || "N",
  };

  const body = buildForm(params);

  // CF Workers는 URL의 IP literal을 차단(1003) → hostname 필수
  // crm.noblehong.com (DNS A 1.234.1.48, Proxy OFF) 사용
  // Host 헤더로 www.noblehong.com 명시 → 카페24 IIS 가상호스트 매칭
  const _url = new URL(env.CRM_ENDPOINT);
  const _hostnameUrl = `http://crm.noblehong.com${_url.pathname}${_url.search}`;

  // 카페24 IIS는 종종 일시 지연(App Pool recycle, MSSQL 락) 발생.
  // 15s 타임아웃 + 1회 재시도(1.5s 대기). 총 최대 ~31.5s.
  const TIMEOUT_MS = 15000;
  const MAX_ATTEMPTS = 2;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(_hostnameUrl, {
        method: "POST",
        headers: {
          Host: _url.host, // www.noblehong.com — 카페24 IIS 가상호스트 매칭
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) noblehong-cf-worker",
          Referer: "https://www.noblehong.com/sub02/sub02_05_1.html",
        },
        body,
        signal: ctrl.signal,
        redirect: "manual",
      });
      // 응답은 UTF-8 HTML (inc_top.html: Response.CharSet="utf-8")
      const bytes = new Uint8Array(await r.arrayBuffer());
      let text = "";
      try {
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        text = new TextDecoder("euc-kr").decode(bytes);
      }
      // 가을미팅 진단은 D1에 기록하므로 개인정보 포함 디버그 알림을 보내지 않는다.
      if (!suppressDebug) bgRun(
        env,
        tgDebug(
          env,
          `[노블홍/cafe24-debug] status=${r.status} attempt=${attempt}\nname=${fields.u_name}\nhp=${fields.u_hp}\nbody(head)=${text
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 280)}`,
        ),
      );
      if (text.includes("알 수 없는 오류"))
        throw new Error("CRM returned error alert");
      return { ok: true, status: r.status, attempt };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// 브라우저 Pixel과 같은 event_id를 사용해 중복 전환을 하나로 묶는다.
// 광고 성과 측정에 별도로 동의한 접수에만 호출한다.
async function sendFallMeetingCapi(env, { eventId, phone, fbp, fbc, sourceUrl, ip, userAgent }) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_ACCESS_TOKEN) return;
  const phoneBytes = new TextEncoder().encode(phone.replace(/\D/g, ""));
  const digest = await crypto.subtle.digest("SHA-256", phoneBytes);
  const ph = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const userData = { ph: [ph], client_ip_address: ip, client_user_agent: userAgent };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  const payload = {
    data: [{
      event_name: "Lead",
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: "website",
      event_source_url: sourceUrl,
      user_data: userData,
      custom_data: { content_name: "가을미팅신청" },
    }],
    access_token: env.META_CAPI_ACCESS_TOKEN,
  };
  const response = await fetch(`https://graph.facebook.com/v24.0/${encodeURIComponent(env.META_PIXEL_ID)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Meta CAPI HTTP ${response.status}`);
}

// ─────────────────────────────────────────────────────────────────
// Gmail OAuth 전송 (submit 전용)
// ─────────────────────────────────────────────────────────────────
async function sendAdminEmail(env, d) {
  const CID = env.GMAIL_CLIENT_ID;
  const CS = env.GMAIL_CLIENT_SECRET;
  const RT = env.GMAIL_REFRESH_TOKEN;
  const FROM = env.GMAIL_FROM || "noblehong0@gmail.com";
  const TO = env.GMAIL_TO || "noblehong1004@naver.com";
  if (!CID || !CS || !RT) return;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CID,
      client_secret: CS,
      refresh_token: RT,
      grant_type: "refresh_token",
    }).toString(),
  });
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error("No access_token");

  const subject = `[노블홍] 상담 신청: ${d.name} (${d.genderKo}, ${d.marriage})`;
  const subjB64 = "=?UTF-8?B?" + utf8Base64(subject) + "?=";
  const html = buildEmailHtml(d);

  const rfc822 = [
    `From: 노블홍 <${FROM}>`,
    `To: ${TO}`,
    `Subject: ${subjB64}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    utf8Base64(html),
  ].join("\r\n");

  const raw = utf8Base64url(rfc822);

  const sendRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  );
  if (!sendRes.ok) {
    throw new Error("Gmail send fail: " + (await sendRes.text()).slice(0, 200));
  }
}

function buildEmailHtml(d) {
  const e = escapeHtml;
  return `<!doctype html><html><body style="font-family:Pretendard,'맑은 고딕',Arial,sans-serif;background:#f7f6f2;padding:24px;margin:0">
<div style="max-width:580px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
  <div style="background:#0f1420;color:#e7c07b;padding:22px 28px">
    <div style="font-size:12px;letter-spacing:2px;color:#c4a55a">NOBLE HONG — 상담 접수 알림</div>
    <div style="font-size:18px;font-weight:700;margin-top:4px;color:#e7c07b">신규 상담 신청이 접수되었습니다</div>
  </div>
  <div style="padding:24px 28px">
    <div style="font-size:20px;font-weight:700;color:#0f1420">${e(d.name)}
      <span style="color:#8c7030;font-size:14px;font-weight:500"> (${e(d.genderKo)} · ${e(d.marriage)} · ${e(d.birthYear)}년생)</span>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;border-top:1px solid #eee;padding-top:16px;font-size:14px;width:100%">
      <tr><td style="color:#8c7030;font-weight:600;padding:4px 0;width:100px">연락처</td><td style="padding:4px 0">${e(d.phone)}</td></tr>
      <tr><td style="color:#8c7030;font-weight:600;padding:4px 0">주소</td><td style="padding:4px 0">${e(d.address)} ${e(d.addressDetail)}</td></tr>
      <tr><td style="color:#8c7030;font-weight:600;padding:4px 0;vertical-align:top">문의내용</td><td style="padding:4px 0;white-space:pre-wrap">${e(d.message) || '<span style="color:#aaa">(미입력)</span>'}</td></tr>
      <tr><td style="color:#8c7030;font-weight:600;padding:4px 0">IP</td><td style="padding:4px 0;font-family:monospace;color:#888">${e(d.ip)}</td></tr>
      <tr><td style="color:#8c7030;font-weight:600;padding:4px 0">Record</td><td style="padding:4px 0;font-family:monospace;color:#888">${e(d.recordId)}</td></tr>
    </table>
    <div style="margin-top:20px;padding:14px;background:#f9f7f2;border-left:3px solid #c4a55a;font-size:13px;color:#5c5040;line-height:1.6">
      담당 커플매니저가 24시간 이내 연락드립니다.<br>
      Airtable에서 상태를 <b>접수 → 상담중</b>으로 업데이트해 주세요.
    </div>
  </div>
  <div style="background:#f7f6f2;padding:14px 28px;color:#888;font-size:12px;text-align:center">© 노블홍 결혼정보회사</div>
</div></body></html>`;
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 상담 풀폼 /api/consultation/submit
// ─────────────────────────────────────────────────────────────────
async function handleConsultationSubmit(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Honeypot
  if (body._hp && String(body._hp).length > 0) {
    const ip = clientIP(request, env);
    tgDebug(
      env,
      `[노블홍/consultations] ⚠️ honeypot 트리거 (submit)\nIP: ${ip}\n_hp: ${String(body._hp).slice(0, 80)}\n이름: ${body.name || ""}\n연락처: ${body.phone || ""}`,
    );
    return json({ ok: true, message: "접수되었습니다" });
  }
  // Timestamp
  const loadTs = parseInt(body._ts, 10);
  if (
    loadTs &&
    Date.now() - loadTs < MIN_SUBMIT_MS &&
    !isBypassedIP(env, clientIP(request, env))
  )
    return json({ error: "Too fast" }, 429);

  // 필드 유효성
  const name = cleanLine(body.name, 50);
  const genderRaw = str(body.gender, 10).toLowerCase();
  const marriage = str(body.marriage, 10);
  const birthYear = parseInt(body.birthYear, 10);

  // 전화번호 정규화: 모든 비숫자 제거 → 길이별 하이픈 복원
  const phoneDigits = str(body.phone, 40).replace(/[^0-9]/g, "");
  let phone = "";
  if (phoneDigits.length === 11) {
    phone = `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 7)}-${phoneDigits.slice(7, 11)}`;
  } else if (phoneDigits.length === 10) {
    phone = `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6, 10)}`;
  } else {
    phone = phoneDigits; // regex에서 실패시킬 것
  }

  // address: 폼에서 region으로 올 수도 있으므로 둘 다 허용
  const address = cleanLine(body.address || body.region, 200);
  const addressDetail = cleanLine(body.addressDetail, 200);
  const message = cleanLine(body.message, 500);

  const genderKo = ["남", "남성", "male", "m"].includes(genderRaw)
    ? "남성"
    : ["여", "여성", "female", "f"].includes(genderRaw)
      ? "여성"
      : "";
  const validMarriage = ["초혼", "미혼", "재혼", "돌싱", "사별"];
  const yearNow = new Date().getFullYear();

  const errors = [];
  if (!name) errors.push("name");
  if (!genderKo) errors.push("gender");
  if (!validMarriage.includes(marriage)) errors.push("marriage");
  if (!(birthYear >= 1940 && birthYear <= yearNow - 19))
    errors.push("birthYear");
  if (!/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(phone)) errors.push("phone");
  if (!body.agreePrivacy) errors.push("agreePrivacy");
  if (/\bhttps?:\/\/|\bwww\.|t\.me\/|bit\.ly/i.test(message))
    errors.push("message_url");
  if (errors.length) {
    console.log(
      "[submit] VALIDATION_FAILED",
      JSON.stringify({
        errors,
        received: {
          name,
          gender: body.gender,
          genderRaw,
          marriage,
          birthYear: body.birthYear,
          phone_in: body.phone,
          phoneDigits,
          phoneFormatted: phone,
          agreePrivacy: body.agreePrivacy,
          hasHp: !!body._hp,
        },
      }),
    );
    tgDebug(
      env,
      `[노블홍/consultations-debug] ⚠️ Validation 실패\nerrors: ${errors.join(", ")}\n이름: ${body.name || ""}\n연락처: ${body.phone || ""}\ngender: ${body.gender || ""}\nmarriage: ${body.marriage || ""}\nbirthYear: ${body.birthYear || ""}\nagreePrivacy: ${body.agreePrivacy}`,
    );
    return json({ error: "Invalid fields", fields: errors }, 400);
  }
  console.log(
    "[submit] VALIDATION_OK",
    JSON.stringify({ name, phone, genderKo, marriage }),
  );

  const ip = clientIP(request, env);
  const ua = str(request.headers.get("user-agent") || "", 500);
  const referrer = str(
    request.headers.get("referer") || body.referrer || "",
    300,
  );
  const TG_TOKEN = env.TELEGRAM_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN;
  const TG_CHAT = env.TELEGRAM_CHAT_ID || env.ADMIN_TG_CHAT_ID;

  if (!env.DB) return json({ error: "Server misconfigured" }, 500);

  // 블랙리스트 차단 — fake 200 + 어드민 알림. 모든 후속 처리 스킵
  if (await checkBlacklist(env, phone)) {
    bgRun(
      env,
      tgDebug(
        env,
        `[노블홍/consultations] 🚫 블랙리스트 차단\nIP: ${ip}\n이름: ${name}\n연락처: ${phone}`,
      ),
    );
    return json({ ok: true, message: "접수되었습니다" });
  }

  try {
    const { limited } = await checkRateLimit(env, ip);
    if (limited) {
      await tgDebug(
        env,
        `[노블홍/consultations] ⚠️ Rate limit 초과\nIP: ${ip}\n이름: ${name}`,
      );
      return json({ error: "Too many submissions" }, 429);
    }

    const { id: recordId, error: saveError } = await saveConsultation(env, {
      이름: name,
      성별: genderKo,
      혼인여부: marriage,
      출생연도: birthYear,
      연락처: phone,
      주소: address,
      상세주소: addressDetail,
      문의내용: message,
      개인정보동의: !!body.agreePrivacy,
      마케팅동의: !!body.agreeMarketing,
      상태: "접수",
      출처: "상담문의",
      IP: ip,
      UserAgent: ua,
      Referrer: referrer,
      제출일시: new Date().toISOString(),
    });
    if (saveError) {
      await tgDebug(env, `❌ DB 저장 실패 · 상담문의\nIP: ${ip}\n${saveError}`);
      return json({ error: "Failed to save" }, 500);
    }

    await tgConsult(
      env,
      "submit",
      {
        name,
        phone,
        gender: genderKo,
        birthYear,
        marriage,
        address,
        addressDetail,
        message,
      },
      recordId,
    );

    // best-effort (이메일 + 카페24)
    bgRun(
      env,
      sendAdminEmail(env, {
        name,
        genderKo,
        marriage,
        birthYear,
        phone,
        address,
        addressDetail,
        message,
        ip,
        recordId,
      }).catch((e) =>
        tgDebug(
          env,
          `[노블홍/consultations] Gmail 발송 실패\nIP:${ip}\n${String(e).slice(0, 200)}`,
        ),
      ),
    );
    bgRun(
      env,
      postToCafe24(env, {
        in_course2: env.CRM_COURSE_CODE || "5002",
        in_course_desc: "본상담-풀폼",
        u_name: name,
        u_hp: phone.replace(/[^0-9]/g, ""),
        u_gender: genderKo === "남성" ? "1" : "2",
        u_married: marriage === "재혼" ? "2" : "1",
        u_birthY: String(birthYear),
        u_memo:
          (message || "") +
          (address ? `\n거주지: ${address} ${addressDetail}` : ""),
        agree1: body.agreePrivacy ? "Y" : "N",
        agree2: body.agreeMarketing ? "Y" : "N",
      })
        .then(() => recordCafe24Result(env, recordId, "ok"))
        .catch(async (e) => {
          await recordCafe24Result(
            env,
            recordId,
            `fail:${String(e?.message || e).slice(0, 80)}`,
          );
          await tgDebug(
            env,
            `[노블홍/consultations] 카페24 전송 실패 (우리측 접수 OK)\nRecord:${recordId}\n${String(e).slice(0, 200)}`,
          );
        }),
    );

    return json({
      ok: true,
      message:
        "상담 신청이 접수되었습니다. 담당 커플매니저가 24시간 이내 연락드리겠습니다.",
    });
  } catch (err) {
    await tgDebug(
      env,
      `[노블홍/consultations] 500 에러\nIP:${ip}\n${String(err?.message || err).slice(0, 200)}`,
    );
    return json({ error: "Server error" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
function fallJson(body, status = 200) {
  return json(body, status, { "Cache-Control": "private, no-store" });
}

function fallGeo(request) {
  // Vercel rewrite가 전달한 방문자 지역을 우선한다. 직접 Worker 접속은 CF edge 값.
  const header = (name, max = 80) => cleanLine(request.headers.get(name), max);
  let city = header("x-vercel-ip-city");
  try { city = decodeURIComponent(city); } catch { city = ""; }
  return {
    country: header("x-vercel-ip-country", 4) || cleanLine(request.cf?.country, 4),
    region: header("x-vercel-ip-country-region", 40) || cleanLine(request.cf?.region, 40),
    city: cleanLine(city || request.cf?.city, 80),
  };
}

async function recordFallStage(env, fields, stage, detail = "") {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO fall_meeting_audit
       (id, consultation_id, visit_id, ip, country, region, city, stage, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, fields.recordId || null, fields.visitId || null, fields.ip || null,
      fields.geo?.country || null, fields.geo?.region || null, fields.geo?.city || null,
      stage, cleanLine(detail, 120), createdAt).run();
  } catch {
    // D1 장애 때도 비식별 오류 코드만 R2에 남긴다. 공개 R2에는 IP·쿠키·고객정보를 쓰지 않는다.
    try {
      await env.BUCKET?.put(`diagnostics/fall-meeting/${createdAt.slice(0, 10)}/${id}.json`,
        JSON.stringify({ stage, detail: cleanLine(detail, 120), at: createdAt }),
        { httpMetadata: { contentType: "application/json" } });
    } catch {}
  }
}

async function snapshotFallAudit(env) {
  if (!env.DB || !env.BUCKET) return;
  const date = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00+09:00`).toISOString();
  const end = new Date(new Date(start).getTime() + 86400000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT stage, COUNT(*) AS count FROM fall_meeting_audit
     WHERE created_at >= ? AND created_at < ? GROUP BY stage`,
  ).bind(start, end).all();
  const counts = Object.fromEntries((rows.results || []).map((row) => [row.stage, row.count]));
  await env.BUCKET.put(`analytics/fall-meeting/${date}.json`,
    JSON.stringify({ date, counts, generatedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json" } });
}

async function verifyFallTurnstile(env, token) {
  if (!env.FALL_TURNSTILE_SECRET || !token || token.length > 2048)
    return { ok: false, status: 422 };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.FALL_TURNSTILE_SECRET, response: token }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: 503 };
    const result = await response.json();
    return { ok: result.success === true && result.action === "fall_meeting" &&
      ["noblehong.com", "www.noblehong.com"].includes(result.hostname), status: 422 };
  } catch {
    return { ok: false, status: 503 };
  } finally { clearTimeout(timeout); }
}

async function handleFallMeeting(request, env) {
  if (request.method !== "POST") return fallJson({ error: "Method not allowed" }, 405);
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json"))
    return fallJson({ error: "application/json required" }, 415);
  if (Number(request.headers.get("content-length") || 0) > 8192)
    return fallJson({ error: "Request too large" }, 413);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return fallJson({ error: "Request too large" }, 413);
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON");
  } catch { return fallJson({ error: "Invalid JSON" }, 400); }
  if (body._hp) return fallJson({ ok: true, tracked: false });
  const loadTs = Number(body._ts);
  if (loadTs && Date.now() - loadTs < MIN_SUBMIT_MS && !isBypassedIP(env, clientIP(request, env)))
    return fallJson({ error: "Too fast" }, 429);
  const name = cleanLine(body.name, 30);
  const phoneDigits = str(body.phone, 30).replace(/\D/g, "");
  const phone = phoneDigits.length === 11
    ? `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 7)}-${phoneDigits.slice(7)}` : "";
  const gender = body.gender === "남성" || body.gender === "여성" ? body.gender : "";
  const age = Number(body.age);
  const errors = [];
  if (!name) errors.push("name");
  if (!/^010-\d{4}-\d{4}$/.test(phone)) errors.push("phone");
  if (!gender) errors.push("gender");
  if (!Number.isInteger(age) || age < 55 || age > 75) errors.push("age");
  if (body.agreePrivacy !== true) errors.push("agreePrivacy");
  if (errors.length) return fallJson({ error: "Invalid fields", fields: errors }, 400);
  if (!env.DB) return fallJson({ error: "Server misconfigured" }, 500);
  const ip = clientIP(request, env);
  if (await checkBlacklist(env, phone)) return fallJson({ ok: true, tracked: false });
  const { limited } = await checkRateLimit(env, ip);
  if (limited) return fallJson({ error: "Too many submissions" }, 429);
  const verified = await verifyFallTurnstile(env, str(body.turnstileToken, 2050));
  if (!verified.ok) return fallJson({ error: verified.status === 503 ? "Verification unavailable" : "Verification required" }, verified.status);
  const geo = fallGeo(request);
  const visitId = /^[0-9a-f-]{36}$/i.test(str(body.visitId, 40)) ? body.visitId : null;
  const ua = str(request.headers.get("user-agent") || "", 500);
  let sourceUrl = "https://noblehong.com/fall-meeting/";
  try {
    const candidate = new URL(request.headers.get("referer") || sourceUrl);
    if (["noblehong.com", "www.noblehong.com", "noblehong.vercel.app"].includes(candidate.hostname))
      sourceUrl = candidate.origin + candidate.pathname;
  } catch {}
  const trackingConsent = body.trackingConsent === true;
  const eventId = trackingConsent && /^[0-9a-f-]{36}$/i.test(str(body.eventId, 40))
    ? body.eventId : null;
  const { id: recordId, error: saveError } = await saveConsultation(env, {
    이름: name, 연락처: phone, 성별: gender,
    문의내용: `가을미팅신청 · 나이 ${age}세 · Meta 광고 성과 측정 ${trackingConsent ? "동의" : "미동의"}`,
    개인정보동의: true, 마케팅동의: false,
    상태: "접수", 출처: "가을미팅신청",
    IP: ip, UserAgent: ua, Referrer: sourceUrl,
    접속국가: geo.country, 접속지역: geo.region, 접속도시: geo.city, 방문쿠키: visitId,
    제출일시: new Date().toISOString(),
  });
  const auditFields = { recordId, visitId, ip, geo };
  if (saveError) {
    await recordFallStage(env, auditFields, "d1_save_failed", "save_error");
    return fallJson({ error: "Failed to save" }, 500);
  }
  await recordFallStage(env, auditFields, "d1_saved");
  bgRun(env, tgConsult(env, "fall-meeting", {
    name, phone, gender, message: `가을미팅신청 · 나이 ${age}세`,
  }, recordId).catch(() => {}));
  bgRun(env, postToCafe24(env, {
    in_course2: env.CRM_COURSE_CODE || "5002",
    in_course_desc: "가을미팅신청",
    u_name: name, u_hp: phoneDigits,
    u_gender: gender === "남성" ? "1" : "2",
    u_birthY: "1911", // 나이만 수집하므로 정확한 출생연도를 임의로 만들지 않는다.
    u_memo: "가을미팅신청",
    agree1: "Y", agree2: "N",
  }, { suppressDebug: true }).then(async (result) => {
      if (result.status >= 400) throw new Error(`CRM HTTP ${result.status}`);
      await recordCafe24Result(env, recordId, "ok");
      await recordFallStage(env, auditFields, "crm_ok", `http:${result.status}; attempt:${result.attempt}`);
    })
    .catch(async (error) => {
      await recordCafe24Result(env, recordId, `fail:${String(error?.message || error).slice(0, 80)}`);
      await recordFallStage(env, auditFields, "crm_failed", String(error?.message || error));
    }));
  if (eventId) {
    bgRun(env, sendFallMeetingCapi(env, {
      eventId, phone, ip, userAgent: ua, sourceUrl,
      fbp: str(body.fbp, 150), fbc: str(body.fbc, 150),
    }).then(() => recordFallStage(env, auditFields, "capi_ok"))
      .catch((error) => recordFallStage(env, auditFields, "capi_failed", String(error?.message || error))));
  }
  return fallJson({ ok: true, tracked: !!eventId, reference: recordId });
}

// 핸들러: 사이드바 간편 /api/consultation/quick
// ─────────────────────────────────────────────────────────────────
async function handleConsultationQuick(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (body._hp && String(body._hp).length > 0) {
    const ip = clientIP(request, env);
    tgDebug(
      env,
      `[노블홍/quick] ⚠️ honeypot 트리거\nIP: ${ip}\n_hp: ${String(body._hp).slice(0, 80)}\n이름: ${body.name || ""}\n연락처: ${body.phone || ""}`,
    );
    return json({ ok: true, message: "접수되었습니다" });
  }
  const loadTs = parseInt(body._ts, 10);
  if (
    loadTs &&
    Date.now() - loadTs < MIN_SUBMIT_MS &&
    !isBypassedIP(env, clientIP(request, env))
  )
    return json({ error: "Too fast" }, 429);

  const name = cleanLine(body.name, 50);
  const phone = str(body.phone, 30).replace(/\s+/g, "");
  const errors = [];
  if (!name) errors.push("name");
  if (!/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(phone)) errors.push("phone");
  if (errors.length)
    return json({ error: "Invalid fields", fields: errors }, 400);

  const ip = clientIP(request, env);
  const ua = str(request.headers.get("user-agent") || "", 500);
  const referrer = str(
    request.headers.get("referer") || body.referrer || "",
    300,
  );
  const TG_TOKEN = env.TELEGRAM_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN;
  const TG_CHAT = env.TELEGRAM_CHAT_ID || env.ADMIN_TG_CHAT_ID;
  if (!env.DB) return json({ error: "Server misconfigured" }, 500);

  // 블랙리스트 차단 — fake 200 + 어드민 알림. 모든 후속 처리 스킵
  if (await checkBlacklist(env, phone)) {
    bgRun(
      env,
      tgDebug(
        env,
        `[노블홍/quick] 🚫 블랙리스트 차단\nIP: ${ip}\n이름: ${name}\n연락처: ${phone}`,
      ),
    );
    return json({ ok: true, message: "접수되었습니다" });
  }

  try {
    const { limited } = await checkRateLimit(env, ip);
    if (limited) {
      await tgDebug(
        env,
        `[노블홍/quick] ⚠️ Rate limit 초과\nIP: ${ip}\n이름: ${name}`,
      );
      return json({ error: "Too many submissions" }, 429);
    }

    const { id: recordId, error: saveError } = await saveConsultation(env, {
      이름: name,
      연락처: phone,
      문의내용: "[간편상담신청] 사이드바에서 접수",
      상태: "접수",
      출처: "간편상담신청",
      IP: ip,
      UserAgent: ua,
      Referrer: referrer,
      제출일시: new Date().toISOString(),
    });
    if (saveError) {
      await tgDebug(
        env,
        `[노블홍/quick] Airtable 저장 실패\nIP: ${ip}\n${saveError}`,
      );
      return json({ error: "Failed to save" }, 500);
    }

    await tgConsult(env, "quick", { name, phone }, recordId);

    bgRun(
      env,
      postToCafe24(env, {
        in_course2: env.CRM_COURSE_CODE || "5002",
        in_course_desc: "간편상담-사이드바",
        u_name: name,
        u_hp: phone.replace(/[^0-9]/g, ""),
        u_memo: "[간편상담신청] 사이드바에서 접수",
        agree1: "Y",
        agree2: "N",
      })
        .then(() => recordCafe24Result(env, recordId, "ok"))
        .catch(async (e) => {
          await recordCafe24Result(
            env,
            recordId,
            `fail:${String(e?.message || e).slice(0, 80)}`,
          );
          return tgDebug(
            env,
            `[노블홍/quick] 카페24 전송 실패\nRecord:${recordId}\n${String(e).slice(0, 200)}`,
          );
        }),
    );

    return json({
      ok: true,
      message:
        "상담 신청이 접수되었습니다. 24시간 이내 담당자가 연락드리겠습니다.",
    });
  } catch (err) {
    await tgDebug(
      env,
      `[노블홍/quick] 500 에러\nIP:${ip}\n${String(err?.message || err).slice(0, 200)}`,
    );
    return json({ error: "Server error" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: Meta lead → Make → Worker  /api/lead/meta
//   인증: X-Meta-Secret 헤더 (timing-safe 비교)
//   Body (한글 키): { 이름, 연락처, 성별, 혼인여부, 출생년도, 지역, 광고명 }
//   처리: D1 consultations INSERT + Telegram 알림 + 카페24 CRM(u_memo 출처태그)
// ─────────────────────────────────────────────────────────────────
// Meta lead 텔레그램 메시지 — 홈페이지 폼과 같은 buildLeadMessage 포맷
function buildMetaLeadMessage(env, fields, recordId, platformLabel) {
  const headerPlat = platformLabel ? `Meta · ${platformLabel}` : "Meta 광고";
  const personalBits = [];
  if (fields.gender) personalBits.push(fields.gender);
  if (fields.birthYear) personalBits.push(String(fields.birthYear));
  if (fields.marriage) personalBits.push(fields.marriage);
  return buildLeadMessage(
    env,
    headerPlat,
    [
      ["이름", fields.name],
      ["인적사항", personalBits.join(" · ")],
      ["연락처", fields.phone],
      ["지역", fields.address],
      ["광고", fields.adName],
      ["접수시각", formatKoreanDate()],
    ],
    recordId,
  );
}
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─────────────────────────────────────────────────────────────────
// Meta Graph 원본 field_data 매핑 (아이맥 폴러 경로)
// 폴러는 원본 field_data 를 그대로 넘긴다 — 매핑을 워커가 쥐고 있어야 폼 질문이 바뀌어도
// 아이맥 재배포 없이 워커만 고치면 된다.
// 실측(2026-07-25): 폼마다 질문 name 이 다르다.
//   1304445771796402 = full_name / phone_number / 성별 / 혼인여부 / 출생년도 / 지역_(시군까지만입력)
//   1658915391822063 = 이름 / 전화번호 / 성별 / 혼인여부 / 출생년도 / 지역 + 지역_(시군까지만입력)
// 정확일치를 우선순위대로 훑고, 없으면 부분일치로 폴백한다.
// ─────────────────────────────────────────────────────────────────
const META_FIELD_RULES = [
  ["name", ["full_name", "이름", "성함"], /이름|성함|name/i],
  [
    "phone",
    ["phone_number", "전화번호", "연락처"],
    // ⚠ 아이맥 폴러의 hasPhone() 과 반드시 같은 범위를 유지할 것.
    //   폴러가 좁으면 리드를 스킵하면서 처리완료로 마킹해버려 영구 유실된다
    //   (조회창 48시간이라 나중에 고쳐도 재수집 불가). 동기화는 폴러 테스트가 강제한다.
    /연락처|전화|휴대|핸드폰|phone|mobile|cell/i,
  ],
  ["gender", ["성별"], /성별|gender/i],
  ["marriage", ["혼인여부"], /혼인|결혼|marriage/i],
  ["birthYear", ["출생년도", "출생연도"], /출생|생년|birth/i],
  [
    "region",
    ["지역_(시군까지만입력)", "지역", "주소"],
    /지역|주소|소재지|region|city/i,
  ],
];

// export 는 테스트용 — Workers 런타임은 default export 만 본다
export function mapMetaFieldData(fieldData) {
  const items = (Array.isArray(fieldData) ? fieldData : [])
    .map((f) => ({
      name: String(f?.name || "").trim(),
      value: String(
        (Array.isArray(f?.values) ? f.values[0] : f?.values) || "",
      ).trim(),
    }))
    .filter((i) => i.name);

  const out = {};
  const used = new Set();
  for (const [key, exact, fuzzy] of META_FIELD_RULES) {
    let hit = null;
    for (const want of exact) {
      hit = items.find(
        (i) => i.name.toLowerCase() === want.toLowerCase() && i.value,
      );
      if (hit) break;
    }
    if (!hit) hit = items.find((i) => i.value && fuzzy.test(i.name));
    out[key] = hit ? hit.value : "";
    if (hit) used.add(hit.name);
  }
  // 매핑에 안 걸린 응답은 버리지 않고 원본 그대로 남긴다 (폼에 질문이 추가돼도 유실 0)
  out.extras = items
    .filter((i) => i.value && !used.has(i.name))
    .map((i) => `${i.name}=${i.value}`);
  return out;
}

// Meta leadId 선점 — INSERT OR IGNORE 로 유니크를 잡고 changes=0 이면 이미 처리한 리드.
// 폴러의 48시간 겹침 조회 때문에 이 게이트가 없으면 중복 접수가 확정적으로 난다.
async function claimMetaLead(env, leadId, createdTime) {
  try {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO meta_leads (lead_id, created_time, claimed_at)
       VALUES (?, ?, ?)`,
    )
      .bind(leadId, createdTime || null, new Date().toISOString())
      .run();
    return (r?.meta?.changes || 0) > 0 ? "claimed" : "duplicate";
  } catch {
    // 멱등 테이블 장애로 리드를 버리진 않는다 — 중복 1건이 유실 1건보다 낫다
    return "error";
  }
}

// 저장이 실패했으면 선점을 풀어 다음 폴링에서 다시 시도되게 한다
async function releaseMetaLead(env, leadId) {
  try {
    await env.DB.prepare(`DELETE FROM meta_leads WHERE lead_id = ?`)
      .bind(leadId)
      .run();
  } catch {}
}

async function linkMetaLead(env, leadId, consultationId) {
  try {
    await env.DB.prepare(
      `UPDATE meta_leads SET consultation_id = ? WHERE lead_id = ?`,
    )
      .bind(consultationId, leadId)
      .run();
  } catch {}
}

async function handleMetaLead(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  const expected = env.META_LEAD_SECRET;
  if (!expected) {
    await tgDebug(env, `[노블홍/meta-lead] META_LEAD_SECRET 미설정 — 차단`);
    return json({ error: "Server misconfigured" }, 500);
  }
  const provided = request.headers.get("x-meta-secret") || "";
  if (!timingSafeEqualStr(provided, expected)) {
    const ip = clientIP(request, env);
    await tgDebug(
      env,
      `[노블홍/meta-lead] ⚠️ 시크릿 불일치 차단\nIP: ${ip}\nprovided len: ${provided.length}`,
    );
    return json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // 두 경로를 모두 받는다:
  //   (1) 아이맥 폴러 — Graph 원본 { leadId, createdTime, platform, adName, fieldData[] }
  //   (2) Make 웹훅   — 평면 한글키 { 이름, 연락처, ... }  ← 전환기 하위호환
  const g = mapMetaFieldData(body.fieldData);

  const name = cleanLine(body["이름"] || body.name || g.name || "", 50);
  // 연락처 정규화: +82, 0082, 82 prefix → 0 으로 통일 (Meta는 E.164로 보냄)
  let phone = str(body["연락처"] || body.phone || g.phone || "", 30).replace(
    /[\s()]/g,
    "",
  );
  phone = phone
    .replace(/^\+?0{0,2}82-?/, "0")
    .replace(/^82(?=1\d)/, "0")
    // Meta/Make가 국가코드 없이 로컬번호(0…)에 +만 붙인 경우: +010… → 010…
    .replace(/^\+(?=0)/, "");
  const gender = str(body["성별"] || g.gender || "", 10);
  const marriage = str(body["혼인여부"] || g.marriage || "", 10);
  // 실측상 출생년도 응답이 자유입력이라 25건 중 11건이 4자리가 아니다("75", "1975년생" 등).
  // 여기서 자르면 normBirthYear 가 볼 원본이 손상되므로 넉넉히 받고 보정은 카페24 단계에 맡긴다.
  const birthYearRaw = str(
    body["출생년도"] || body["출생연도"] || g.birthYear || "",
    20,
  );
  const region = cleanLine(body["지역"] || g.region || "", 100);
  const adName = cleanLine(body["광고명"] || body.adName || "", 200);
  // 플랫폼: ig/fb 정규화 (instagram, facebook, IG, FB, instagram_feed 등 모두 수용)
  const platformRaw = String(body["플랫폼"] || body.platform || "")
    .toLowerCase()
    .trim();
  let platform = "";
  if (/(^|[^a-z])ig|insta/.test(platformRaw)) platform = "ig";
  else if (/(^|[^a-z])fb|face/.test(platformRaw)) platform = "fb";
  const sourceKey = platform ? `meta-${platform}` : "meta";
  const sourceLabel = SOURCE_LABEL[sourceKey] || "Meta 광고";

  const errors = [];
  if (!name) errors.push("이름");
  if (!/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(phone)) errors.push("연락처");
  if (errors.length)
    return json({ error: "Invalid fields", fields: errors }, 400);

  const ip = clientIP(request, env);
  const ua = str(request.headers.get("user-agent") || "Make/Meta", 500);
  if (!env.DB) return json({ error: "Server misconfigured" }, 500);

  // leadId 멱등 게이트 — 폴러가 48시간 겹침 조회를 하므로 여기서 막지 않으면
  // 같은 리드가 매시간 재접수된다. 블랙리스트 검사보다 먼저 선점해야 차단 알림도 1회로 끝난다.
  const leadId = str(body.leadId || body.lead_id || "", 40).replace(
    /[^0-9A-Za-z_-]/g,
    "",
  );
  if (leadId) {
    const claim = await claimMetaLead(env, leadId, body.createdTime);
    if (claim === "duplicate") return json({ ok: true, duplicate: true });
  }

  // 블랙리스트 차단 — fake 200 반환 + 어드민 알림. D1/카페24/TG 전부 스킵
  if (await checkBlacklist(env, phone)) {
    bgRun(
      env,
      tgDebug(
        env,
        `[노블홍/meta-lead] 🚫 블랙리스트 차단\nIP: ${ip}\n이름: ${name}\n연락처: ${phone}\n광고: ${adName || "-"}`,
      ),
    );
    return json({ ok: true, id: null });
  }

  let saved = false;
  try {
    // 매핑 안 된 폼 응답은 문의내용 꼬리에 원본 그대로 붙인다 (폼 질문이 늘어도 유실 0)
    const messageText = cleanLine(
      [
        adName ? `[Meta 광고] ${adName}` : "[Meta 광고]",
        g.extras.length ? `· ${g.extras.join(" · ")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      500,
    );
    const { id: recordId, error: saveError } = await saveConsultation(env, {
      이름: name,
      연락처: phone,
      성별: gender || null,
      혼인여부: marriage || null,
      출생연도: birthYearRaw || null,
      주소: region || null,
      문의내용: messageText,
      개인정보동의: true,
      상태: "접수",
      출처: adName ? `${sourceKey}:${adName}` : sourceKey,
      IP: ip,
      UserAgent: ua,
      Referrer: str(request.headers.get("referer") || "make.com", 300),
      제출일시: new Date().toISOString(),
    });
    if (saveError) {
      // 선점을 풀어야 다음 폴링(1시간 뒤)에서 같은 리드를 다시 시도한다 — 안 풀면 영구 유실
      if (leadId) await releaseMetaLead(env, leadId);
      await tgDebug(
        env,
        `[노블홍/meta-lead] D1 저장 실패\nIP: ${ip}\n${saveError}`,
      );
      return json({ error: "Failed to save" }, 500);
    }
    if (leadId) await linkMetaLead(env, leadId, recordId);
    saved = true;

    const platformLabel =
      platform === "ig" ? "Instagram" : platform === "fb" ? "Facebook" : "";
    const tgText = buildMetaLeadMessage(
      env,
      {
        name,
        phone,
        gender,
        marriage,
        birthYear: birthYearRaw,
        address: region,
        adName,
      },
      recordId,
      platformLabel,
    );
    await tgSend(
      env,
      env.TELEGRAM_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID || env.ADMIN_TG_CHAT_ID,
      tgText,
      { channel: "접수" },
    );

    // 카페24 CRM (MSSQL) INSERT — fire-and-forget. 실패해도 D1/TG 영향 없음
    const cafe24Tag =
      platform === "ig"
        ? "Meta광고-IG"
        : platform === "fb"
          ? "Meta광고-FB"
          : "Meta광고";
    const cafe24Memo = adName ? `[${cafe24Tag}] ${adName}` : `[${cafe24Tag}]`;
    bgRun(
      env,
      postToCafe24(env, {
        in_course2: env.CRM_COURSE_CODE || "5002",
        in_course_desc: cafe24Tag,
        u_name: name,
        u_hp: phone.replace(/[^0-9]/g, ""),
        u_gender: gender === "남성" ? "1" : gender === "여성" ? "2" : "",
        u_married: marriage === "초혼" ? "1" : marriage === "재혼" ? "2" : "",
        u_birthY: birthYearRaw || "",
        u_memo: cafe24Memo,
        agree1: "Y",
        agree2: "N",
      })
        .then(() => recordCafe24Result(env, recordId, "ok"))
        .catch(async (e) => {
          await recordCafe24Result(
            env,
            recordId,
            `fail:${String(e?.message || e).slice(0, 80)}`,
          );
          await tgDebug(
            env,
            `[노블홍/meta-lead] 카페24 전송 실패\nRecord:${recordId}\n${String(e).slice(0, 200)}`,
          );
        }),
    );

    return json({ ok: true, id: recordId });
  } catch (err) {
    // 저장 전에 터졌으면 선점을 풀어 다음 폴링에서 재시도. 저장 후(알림 단계) 실패면
    // 선점을 유지해야 같은 리드가 다시 접수되지 않는다.
    if (leadId && !saved) await releaseMetaLead(env, leadId);
    await tgDebug(
      env,
      `[노블홍/meta-lead] 500 에러\nIP:${ip}\n${String(err?.message || err).slice(0, 200)}`,
    );
    return json({ error: "Server error" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 폴러 하트비트 /api/lead/meta/heartbeat
//   아이맥 폴러가 매 실행마다(1시간) 찍는다.
//   아이맥이 꺼지거나 launchd 가 내려가면 폴러는 스스로 "죽었다"를 알릴 수 없다.
//   그 침묵을 워커 크론이 이 시각의 노후로 대신 감지한다.
// ─────────────────────────────────────────────────────────────────
async function handleMetaLeadHeartbeat(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const expected = env.META_LEAD_SECRET;
  if (!expected) return json({ error: "Server misconfigured" }, 500);
  if (!timingSafeEqualStr(request.headers.get("x-meta-secret") || "", expected))
    return json({ error: "Unauthorized" }, 401);
  if (!env.DB) return json({ error: "Server misconfigured" }, 500);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  // site = 아이맥이 1시간마다 직접 찌른 사이트 접수경로 판정(ok/fail/degraded).
  // 워커는 이 값으로 알림을 내지 않는다 — 알림은 아이맥이 이미 보냈다. 사후 확인용 기록.
  const site = str(String(body.site || ""), 20);
  const detail = str(
    `forms=${num(body.forms)} fetched=${num(body.fetched)} delivered=${num(body.delivered)} dup=${num(body.duplicates)} skipped=${num(body.skipped)}${site ? ` site=${site}` : ""}`,
    200,
  );
  const nowIso = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO health_state (id, status, detail, since, checked_at)
       VALUES ('meta_poller', 'ok', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'ok', detail = excluded.detail, checked_at = excluded.checked_at`,
    )
      .bind(detail, nowIso, nowIso)
      .run();
  } catch (e) {
    return json({ error: "Failed to record" }, 500);
  }
  // 카페24 전송 실적을 응답에 실어 보낸다 — 아이맥이 시간당 리포트에 그대로 싣는다.
  // 별도 엔드포인트를 만들지 않고 이미 있는 왕복에 얹는다.
  return json({
    ok: true,
    at: nowIso,
    cafe24: await cafe24Summary(env, 24),
    tg: await tgSummary(env),
  });
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 하단바 /api/consultation/bar
// ─────────────────────────────────────────────────────────────────
async function handleConsultationBar(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (body._hp && String(body._hp).length > 0) {
    const ip = clientIP(request, env);
    tgDebug(
      env,
      `[노블홍/bar] ⚠️ honeypot 트리거\nIP: ${ip}\n_hp: ${String(body._hp).slice(0, 80)}\n이름: ${body.name || ""}\n연락처: ${body.phone || ""}`,
    );
    return json({ ok: true, message: "접수되었습니다" });
  }
  const loadTs = parseInt(body._ts, 10);
  if (
    loadTs &&
    Date.now() - loadTs < MIN_SUBMIT_MS &&
    !isBypassedIP(env, clientIP(request, env))
  )
    return json({ error: "Too fast" }, 429);

  const name = cleanLine(body.name, 50);
  const phone = str(body.phone, 30).replace(/\s+/g, "");
  const genderKo = str(body.gender, 10);
  const marriage = str(body.marriage, 10);
  const birthYear = parseInt(body.birthYear, 10);
  const errors = [];
  if (!name) errors.push("name");
  if (!/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(phone)) errors.push("phone");
  if (!body.agreePrivacy) errors.push("agreePrivacy");
  if (genderKo && !["남성", "여성"].includes(genderKo)) errors.push("gender");
  const validMarriage = ["", "초혼", "미혼", "재혼", "돌싱", "사별"];
  if (marriage && !validMarriage.includes(marriage)) errors.push("marriage");
  const yearNow = new Date().getFullYear();
  if (body.birthYear && !(birthYear >= 1940 && birthYear <= yearNow - 19))
    errors.push("birthYear");
  if (errors.length)
    return json({ error: "Invalid fields", fields: errors }, 400);

  const ip = clientIP(request, env);
  const ua = str(request.headers.get("user-agent") || "", 500);
  const referrer = str(
    request.headers.get("referer") || body.referrer || "",
    300,
  );
  const TG_TOKEN = env.TELEGRAM_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN;
  const TG_CHAT = env.TELEGRAM_CHAT_ID || env.ADMIN_TG_CHAT_ID;
  if (!env.DB) return json({ error: "Server misconfigured" }, 500);

  // 블랙리스트 차단 — fake 200 + 어드민 알림. 모든 후속 처리 스킵
  if (await checkBlacklist(env, phone)) {
    bgRun(
      env,
      tgDebug(
        env,
        `[노블홍/bar] 🚫 블랙리스트 차단\nIP: ${ip}\n이름: ${name}\n연락처: ${phone}`,
      ),
    );
    return json({ ok: true, message: "접수되었습니다" });
  }

  try {
    const { limited } = await checkRateLimit(env, ip);
    if (limited) {
      await tgDebug(
        env,
        `[노블홍/bar] ⚠️ Rate limit 초과\nIP: ${ip}\n이름: ${name}`,
      );
      return json({ error: "Too many submissions" }, 429);
    }

    const fields = {
      이름: name,
      연락처: phone,
      문의내용: "[하단바 접수] 메인 페이지 하단 가로바에서 접수",
      개인정보동의: !!body.agreePrivacy,
      마케팅동의: !!body.agreeMarketing,
      상태: "접수",
      출처: "하단바",
      IP: ip,
      UserAgent: ua,
      Referrer: referrer,
      제출일시: new Date().toISOString(),
    };
    if (genderKo) fields["성별"] = genderKo;
    if (marriage) fields["혼인여부"] = marriage;
    if (birthYear) fields["출생연도"] = birthYear;

    const { id: recordId, error: saveError } = await saveConsultation(
      env,
      fields,
    );
    if (saveError) {
      await tgDebug(
        env,
        `[노블홍/bar] Airtable 저장 실패\nIP: ${ip}\n${saveError}`,
      );
      return json({ error: "Failed to save" }, 500);
    }

    await tgConsult(
      env,
      "bar",
      { name, phone, gender: genderKo, birthYear, marriage },
      recordId,
    );

    bgRun(
      env,
      postToCafe24(env, {
        in_course2: "5001",
        in_course_desc: "간편상담-하단바",
        u_name: name,
        u_hp: phone.replace(/[^0-9]/g, ""),
        u_gender: genderKo === "남성" ? "1" : genderKo === "여성" ? "2" : "",
        u_married: marriage === "재혼" ? "2" : marriage ? "1" : "",
        u_birthY: birthYear ? String(birthYear) : "",
        u_memo: "[하단바 접수] 메인 페이지 하단 가로바에서 접수",
        agree1: body.agreePrivacy ? "Y" : "N",
        // ↓ 아래 .then/.catch 에서 전송 결과를 consultations.cafe24 에 기록한다
        agree2: body.agreeMarketing ? "Y" : "N",
      })
        .then(() => recordCafe24Result(env, recordId, "ok"))
        .catch(async (e) => {
          await recordCafe24Result(
            env,
            recordId,
            `fail:${String(e?.message || e).slice(0, 80)}`,
          );
          return tgDebug(
            env,
            `[노블홍/bar] 카페24 전송 실패\nRecord:${recordId}\n${String(e).slice(0, 200)}`,
          );
        }),
    );

    return json({
      ok: true,
      message:
        "상담 신청이 접수되었습니다. 24시간 이내 담당자가 연락드리겠습니다.",
    });
  } catch (err) {
    await tgDebug(
      env,
      `[노블홍/bar] 500 에러\nIP:${ip}\n${String(err?.message || err).slice(0, 200)}`,
    );
    return json({ error: "Server error" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: OTP 발급 /api/admin/otp/request
// ─────────────────────────────────────────────────────────────────
async function handleOtpRequest(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  // OTP는 고객 알림 채널(TELEGRAM_CHAT_ID)로 통일 전송. ADMIN_TG_* 는 레거시 fallback.
  const BOT = env.TELEGRAM_BOT_TOKEN || env.ADMIN_TG_BOT_TOKEN;
  const CHAT = env.TELEGRAM_CHAT_ID || env.ADMIN_TG_CHAT_ID;
  const SECRET = env.ADMIN_JWT_SECRET;
  const TTL = parseInt(env.ADMIN_OTP_TTL || "300", 10);
  if (!BOT || !CHAT || !SECRET)
    return json({ error: "Server misconfigured" }, 500);

  const ip = clientIP(request, env);
  const ua = str(request.headers.get("user-agent") || "", 200);

  const otp = randomOTP();
  const expiresAt = Math.floor(Date.now() / 1000) + TTL;
  const otpHash = await sha256Hex(otp);
  const payload = `${otpHash}.${expiresAt}`;
  const sig = await hmacSign(payload, SECRET);
  const cookieValue = `${payload}.${sig}`;

  try {
    const tgText = [
      `[노블홍/admin] 🔐 관리자 로그인 OTP`,
      `코드: <b>${otp}</b>`,
      `만료: ${Math.floor(TTL / 60)}분 후`,
      `IP: ${ip}`,
      `UA: ${ua.slice(0, 80)}`,
    ].join("\n");
    const tgRes = await fetch(
      `https://api.telegram.org/bot${BOT}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT,
          text: tgText,
          parse_mode: "HTML",
        }),
      },
    );
    if (!tgRes.ok) {
      const errText = (await tgRes.text()).slice(0, 200);
      return json({ error: "Failed to send OTP", detail: errText }, 502);
    }
  } catch {
    return json({ error: "Telegram unreachable" }, 502);
  }

  const cookie = `admin_otp_pending=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL}`;
  return json(
    {
      ok: true,
      message: "Telegram 관리자 채팅에서 OTP를 확인하세요.",
      expiresIn: TTL,
    },
    200,
    { "Set-Cookie": cookie },
  );
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: OTP 검증 /api/admin/otp/verify
// ─────────────────────────────────────────────────────────────────
async function handleOtpVerify(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const SECRET = env.ADMIN_JWT_SECRET;
  const SESSION_TTL = parseInt(env.ADMIN_SESSION_TTL || "43200", 10);
  if (!SECRET) return json({ error: "Server misconfigured" }, 500);

  const otp = String(body.otp || "").trim();
  if (!/^\d{6}$/.test(otp)) return json({ error: "Invalid OTP format" }, 400);

  const cookies = parseCookies(request);
  const pending = cookies.admin_otp_pending || "";
  const parts = pending.split(".");
  if (parts.length !== 3)
    return json({ error: "OTP not requested or expired" }, 400);

  const [otpHash, expiresAtStr, sig] = parts;
  const payload = `${otpHash}.${expiresAtStr}`;
  const valid = await hmacVerify(payload, sig, SECRET);
  if (!valid) return json({ error: "OTP signature invalid" }, 401);

  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() / 1000 > expiresAt)
    return json({ error: "OTP expired" }, 401);

  const submittedHash = await sha256Hex(otp);
  if (submittedHash !== otpHash) return json({ error: "OTP mismatch" }, 401);

  const token = await signJWT({ sub: "admin" }, SECRET, SESSION_TTL);
  const sessionCookie = `admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`;
  const clearPending = `admin_otp_pending=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

  // Telegram 알림 (best-effort)
  try {
    const BOT = env.ADMIN_TG_BOT_TOKEN;
    const CHAT = env.ADMIN_TG_CHAT_ID;
    const ip = clientIP(request, env);
    if (BOT && CHAT) {
      await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT,
          text: `[노블홍/admin] ✅ 관리자 로그인 성공\nIP: ${ip}\n세션 유효: ${Math.floor(SESSION_TTL / 3600)}시간`,
        }),
      });
    }
  } catch {}

  return json({ ok: true, expiresIn: SESSION_TTL }, 200, {
    "Set-Cookie": [sessionCookie, clearPending],
  });
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: ID/PW 로그인 (OTP 대체)
// ─────────────────────────────────────────────────────────────────
async function handleAdminLogin(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const SECRET = env.ADMIN_JWT_SECRET;
  const SESSION_TTL = parseInt(env.ADMIN_SESSION_TTL || "43200", 10);
  const ADMIN_USER = env.ADMIN_USERNAME;
  const ADMIN_PW = env.ADMIN_PASSWORD;
  if (!SECRET || !ADMIN_USER || !ADMIN_PW)
    return json({ error: "Server misconfigured" }, 500);

  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password)
    return json({ error: "Username/Password required" }, 400);

  // 입력 길이 동일하지 않으면 dummy 비교로 timing 일치
  const u1 =
    username.length === ADMIN_USER.length ? username : ADMIN_USER + "x";
  const p1 = password.length === ADMIN_PW.length ? password : ADMIN_PW + "x";
  let userDiff = 0,
    pwDiff = 0;
  for (let i = 0; i < ADMIN_USER.length; i++)
    userDiff |= u1.charCodeAt(i) ^ ADMIN_USER.charCodeAt(i);
  for (let i = 0; i < ADMIN_PW.length; i++)
    pwDiff |= p1.charCodeAt(i) ^ ADMIN_PW.charCodeAt(i);
  const ok =
    userDiff === 0 &&
    pwDiff === 0 &&
    username.length === ADMIN_USER.length &&
    password.length === ADMIN_PW.length;

  const ip = clientIP(request, env);
  const BOT = env.ADMIN_TG_BOT_TOKEN;
  const CHAT = env.ADMIN_TG_CHAT_ID;

  if (!ok) {
    if (BOT && CHAT) {
      bgRun(
        env,
        fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT,
            text: `[노블홍/admin] ⚠️ 로그인 실패\nIP: ${ip}\nID: ${username.slice(0, 30)}`,
          }),
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 500)); // 무차별 대입 방어
    return json({ error: "Invalid credentials" }, 401);
  }

  const token = await signJWT({ sub: "admin" }, SECRET, SESSION_TTL);
  const sessionCookie = `admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`;

  if (BOT && CHAT) {
    bgRun(
      env,
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT,
          text: `[노블홍/admin] ✅ 관리자 로그인 성공\nIP: ${ip}\n세션 유효: ${Math.floor(SESSION_TTL / 3600)}시간`,
        }),
      }),
    );
  }

  return json({ ok: true, expiresIn: SESSION_TTL }, 200, {
    "Set-Cookie": sessionCookie,
  });
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: me / logout
// ─────────────────────────────────────────────────────────────────
async function handleAdminMe(request, env) {
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;
  return json({ ok: true, sub: gate.auth.sub, exp: gate.auth.exp });
}

async function handleAdminLogout(request) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const clear = `admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  return json({ ok: true }, 200, { "Set-Cookie": clear });
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 상담 목록 / 상태변경 (관리자)
// ─────────────────────────────────────────────────────────────────
async function handleConsultationsList(request, env) {
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return json({ error: "DB not configured" }, 500);

  const url = new URL(request.url);
  const source = url.searchParams.get("source") || "";
  const status = url.searchParams.get("status") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const PAGE_SIZE = 50;
  const noStore = { "Cache-Control": "private, no-store" };
  if (source.length > 100 || status.length > 30 || q.length > 100)
    return json({ error: "Filter too long" }, 400, noStore);
  const rawOffset = url.searchParams.get("offset") || "0";
  if (!/^\d{1,4}$/.test(rawOffset) || Number(rawOffset) > 5000)
    return json({ error: "Invalid offset" }, 400, noStore);
  const offset = Number(rawOffset);
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor && offset) return json({ error: "Use cursor or offset" }, 400, noStore);
  let cursor = null;
  if (rawCursor) {
    if (rawCursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(rawCursor))
      return json({ error: "Invalid cursor" }, 400, noStore);
    try {
      const encoded = rawCursor.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const decoded = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(decoded) || decoded.length !== 5 ||
        decoded[0] !== source || decoded[1] !== status || decoded[2] !== q ||
        typeof decoded[3] !== "string" || decoded[3].length > 40 ||
        !/^rec[A-Za-z0-9]{14}$/.test(decoded[4])) throw new Error("cursor scope");
      cursor = [decoded[3], decoded[4]];
    } catch { return json({ error: "Invalid cursor" }, 400, noStore); }
  }

  const where = [];
  const binds = [];
  if (source) {
    // meta / meta-ig / meta-fb 는 광고명 suffix가 붙으므로 prefix LIKE 매칭
    if (/^meta(-(ig|fb))?$/i.test(source)) {
      where.push(`("출처" = ? OR "출처" LIKE ?)`);
      binds.push(source, `${source}:%`);
    } else {
      where.push(`"출처" = ?`);
      binds.push(source);
    }
  }
  if (status) {
    where.push(`"상태" = ?`);
    binds.push(status);
  }
  if (q) {
    where.push(`("이름" LIKE ? OR "연락처" LIKE ? OR "문의내용" LIKE ?)`);
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (cursor) {
    where.push(`("제출일시", id) < (?, ?)`);
    binds.push(...cursor);
  }
  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const r = await env.DB.prepare(
      `SELECT * FROM consultations ${whereSQL} ORDER BY "제출일시" DESC, id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...binds, PAGE_SIZE + 1, offset)
      .all();
    const rows = r.results || [];
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    let nextCursor = null;
    if (hasMore && page.length) {
      const last = page[page.length - 1];
      const bytes = new TextEncoder().encode(JSON.stringify([source, status, q, last["제출일시"], last.id]));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      nextCursor = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return json({ ok: true, records: page.map(rowToAirtableShape),
      offset: hasMore && offset < 5000 ? String(offset + PAGE_SIZE) : null,
      cursor: nextCursor, hasMore }, 200, noStore);
  } catch {
    return json({ error: "DB query failed" }, 500, noStore);
  }
}

async function handleConsultationsUpdate(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;

  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const id = String(body.id || "").trim();
  if (!/^rec[a-zA-Z0-9]{14}$/.test(id))
    return json({ error: "Invalid record id" }, 400);
  const status = String(body.status || "").trim();
  const memo = String(body.memo || "")
    .trim()
    .slice(0, 1000);
  const fields = {};
  if (status) {
    if (!VALID_STATUS.includes(status))
      return json({ error: "Invalid status" }, 400);
    fields["상태"] = status;
  }
  if (memo) fields["관리자메모"] = memo;
  if (Object.keys(fields).length === 0)
    return json({ error: "Nothing to update" }, 400);

  if (!env.DB) return json({ error: "DB not configured" }, 500);
  const sets = [];
  const binds = [];
  if (fields["상태"]) {
    sets.push(`"상태" = ?`);
    binds.push(fields["상태"]);
  }
  if (fields["관리자메모"]) {
    sets.push(`"관리자메모" = ?`);
    binds.push(fields["관리자메모"]);
  }
  binds.push(id);
  try {
    const r = await env.DB.prepare(
      `UPDATE consultations SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...binds)
      .run();
    if ((r.meta?.changes || 0) === 0) return json({ error: "Not found" }, 404);
    const updated = await env.DB.prepare(
      `SELECT * FROM consultations WHERE id = ?`,
    )
      .bind(id)
      .first();
    const shaped = rowToAirtableShape(updated);
    return json({ ok: true, id: shaped.id, fields: shaped.fields });
  } catch (e) {
    return json(
      {
        error: "DB update failed",
        detail: String(e?.message || e).slice(0, 200),
      },
      500,
    );
  }
}

async function handleConsultationsDelete(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;

  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const id = String(body.id || "").trim();
  if (!/^rec[a-zA-Z0-9]{14}$/.test(id))
    return json({ error: "Invalid record id" }, 400);

  if (!env.DB) return json({ error: "DB not configured" }, 500);
  try {
    const r = await env.DB.prepare(`DELETE FROM consultations WHERE id = ?`)
      .bind(id)
      .run();
    const deleted = (r.meta?.changes || 0) > 0;
    return json({ ok: true, id, deleted });
  } catch (e) {
    return json(
      {
        error: "DB delete failed",
        detail: String(e?.message || e).slice(0, 200),
      },
      500,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 블랙리스트 관리 /api/admin/blacklist/{list,add,delete}
//   매칭 키: 연락처(숫자만 정규화). list/add/delete는 모두 관리자 인증 필요
//   4개 폼 핸들러(meta-lead / bar / quick / submit)가 checkBlacklist 호출
// ─────────────────────────────────────────────────────────────────
async function handleBlacklistList(request, env) {
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return json({ error: "DB not configured" }, 500);

  const url = new URL(request.url);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;
  const q = (url.searchParams.get("q") || "").trim();
  const PAGE_SIZE = 100;

  const where = [];
  const binds = [];
  if (q) {
    where.push(`("이름" LIKE ? OR "연락처" LIKE ? OR "사유" LIKE ?)`);
    const like = `%${q.replace(/[^0-9a-zA-Z가-힣\s_-]/g, "")}%`;
    binds.push(like, like, like);
  }
  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const r = await env.DB.prepare(
      `SELECT id, "연락처", "이름", "사유", "등록자", "등록일시" FROM blacklist ${whereSQL} ORDER BY "등록일시" DESC LIMIT ? OFFSET ?`,
    )
      .bind(...binds, PAGE_SIZE, offset)
      .all();
    const records = r.results || [];
    const nextOffset =
      records.length === PAGE_SIZE ? String(offset + PAGE_SIZE) : null;
    return json({ ok: true, records, offset: nextOffset });
  } catch (e) {
    return json(
      {
        error: "DB query failed",
        detail: String(e?.message || e).slice(0, 200),
      },
      500,
    );
  }
}

async function handleBlacklistAdd(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return json({ error: "DB not configured" }, 500);

  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const phoneRaw = String(body.phone || body["연락처"] || "").trim();
  const digits = normalizePhone(phoneRaw);
  if (digits.length < 9 || digits.length > 11)
    return json({ error: "Invalid phone", field: "phone" }, 400);

  const name = String(body.name || body["이름"] || "")
    .trim()
    .slice(0, 50);
  const reason = String(body.reason || body["사유"] || "")
    .trim()
    .slice(0, 500);
  const admin =
    (gate.payload && (gate.payload.sub || gate.payload.email)) || "admin";

  const id = generateBlacklistId();
  const now = new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO blacklist (id, "연락처", "이름", "사유", "등록자", "등록일시") VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, digits, name || null, reason || null, admin, now)
      .run();
    return json({
      ok: true,
      record: {
        id,
        연락처: digits,
        이름: name || null,
        사유: reason || null,
        등록자: admin,
        등록일시: now,
      },
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/UNIQUE|already exists/i.test(msg))
      return json({ error: "이미 등록된 번호입니다", field: "phone" }, 409);
    return json({ error: "DB insert failed", detail: msg.slice(0, 200) }, 500);
  }
}

async function handleBlacklistDelete(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return json({ error: "DB not configured" }, 500);

  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json"))
    return json({ error: "application/json required" }, 415);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const id = String(body.id || "").trim();
  if (!/^bl[a-zA-Z0-9]{14}$/.test(id))
    return json({ error: "Invalid blacklist id" }, 400);

  try {
    const r = await env.DB.prepare(`DELETE FROM blacklist WHERE id = ?`)
      .bind(id)
      .run();
    return json({ ok: true, id, deleted: (r.meta?.changes || 0) > 0 });
  } catch (e) {
    return json(
      {
        error: "DB delete failed",
        detail: String(e?.message || e).slice(0, 200),
      },
      500,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 콘텐츠 CRUD 디스패처 /api/admin/content
// ─────────────────────────────────────────────────────────────────
async function handleAdminContent(request, env) {
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;

  let params;
  const url = new URL(request.url);
  if (request.method === "GET")
    params = Object.fromEntries(url.searchParams.entries());
  else if (request.method === "POST") {
    try {
      params = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
  } else return json({ error: "Method not allowed" }, 405);

  const action = params.action;
  const moduleKey = params.module;
  if (!action) return json({ error: "action required" }, 400);
  if (!moduleKey || !MODULES[moduleKey])
    return json({ error: "invalid module" }, 400);
  const mod = MODULES[moduleKey];
  if (!env.DB) return json({ error: "DB not bound" }, 500);

  try {
    switch (action) {
      case "list":
        return await contentList(env, mod, moduleKey, params);
      case "get":
        return await contentGet(env, mod, params);
      case "create":
        return await contentCreate(env, mod, params);
      case "update":
        return await contentUpdate(env, mod, params);
      case "delete":
        return await contentDelete(env, mod, params);
      case "pin":
        return await contentPin(env, mod, params);
      case "reorder":
        return await contentReorder(env, mod, params);
      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    tgDebug(
      env,
      `[noblehong/admin-content] ${moduleKey}/${action} ${(e?.message || "").slice(0, 160)}`,
    );
    return json({ error: "Server error" }, 500);
  }
}

// D1 row → 어드민 응답 shape (Airtable 호환: { id, fields, createdTime })
function contentRowToShape(row, mod) {
  if (!row) return null;
  const fields = {};
  for (const col of mod.columns) {
    const v = row[col];
    if (v === null || v === undefined || v === "") continue;
    fields[col] = mod.boolColumns.includes(col) ? Number(v) === 1 : v;
  }
  if (Number(row.pinned) === 1) fields.pinned = true;
  if (Number(row["정렬"]) !== 0) fields["정렬"] = Number(row["정렬"]);
  if (row["상태"]) fields["상태"] = row["상태"];
  return { id: row.id, fields, createdTime: row.created_at };
}

async function contentList(env, mod, moduleKey, params) {
  const limit = Math.min(Number(params.limit) || 50, 100);
  const offset = Number(params.offset) || 0;
  const where = [];
  const binds = [];
  if (params.status) {
    where.push(`"상태" = ?`);
    binds.push(params.status);
  }
  if (params.q) {
    where.push(`"${mod.primary}" LIKE ?`);
    binds.push(`%${params.q}%`);
  }
  const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM ${mod.table} ${wsql} ORDER BY pinned DESC, "정렬" DESC, "${mod.dateField}" DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);
  const r = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  const rows = r.results || [];
  const records = rows.map((row) => contentRowToShape(row, mod));
  const nextOffset = rows.length === limit ? String(offset + limit) : null;
  return json({ ok: true, module: moduleKey, records, offset: nextOffset });
}

async function contentGet(env, mod, params) {
  if (!params.id) return json({ error: "id required" }, 400);
  const row = await env.DB.prepare(`SELECT * FROM ${mod.table} WHERE id = ?`)
    .bind(params.id)
    .first();
  if (!row) return json({ error: "not found" }, 404);
  return json({ ok: true, ...contentRowToShape(row, mod) });
}

async function contentCreate(env, mod, params) {
  if (!params.fields || typeof params.fields !== "object")
    return json({ error: "fields required" }, 400);
  const f = params.fields;
  const id = generateRecordId();
  const now = new Date().toISOString();
  const cols = ["id"];
  const ph = ["?"];
  const binds = [id];
  for (const col of mod.columns) {
    cols.push(`"${col}"`);
    ph.push("?");
    let v = f[col];
    if (mod.boolColumns.includes(col)) v = v ? 1 : 0;
    binds.push(v == null ? "" : v);
  }
  cols.push("pinned", `"정렬"`, `"상태"`, "created_at", "updated_at");
  ph.push("?", "?", "?", "?", "?");
  binds.push(
    f.pinned ? 1 : 0,
    Number(f["정렬"]) || 0,
    f["상태"] || "공개",
    now,
    now,
  );
  await env.DB.prepare(
    `INSERT INTO ${mod.table} (${cols.join(", ")}) VALUES (${ph.join(", ")})`,
  )
    .bind(...binds)
    .run();
  const row = await env.DB.prepare(`SELECT * FROM ${mod.table} WHERE id = ?`)
    .bind(id)
    .first();
  return json({ ok: true, ...contentRowToShape(row, mod) });
}

async function contentUpdate(env, mod, params) {
  if (!params.id) return json({ error: "id required" }, 400);
  if (!params.fields || typeof params.fields !== "object")
    return json({ error: "fields required" }, 400);
  const f = params.fields;
  const allowed = new Set([...mod.columns, "pinned", "정렬", "상태"]);
  const sets = [];
  const binds = [];
  for (const key of Object.keys(f)) {
    if (!allowed.has(key)) continue;
    let v = f[key];
    if (key === "pinned" || mod.boolColumns.includes(key)) v = v ? 1 : 0;
    if (key === "정렬") v = Number(v) || 0;
    sets.push(`"${key}" = ?`);
    binds.push(v == null ? "" : v);
  }
  if (!sets.length) return json({ error: "no valid fields" }, 400);
  sets.push(`updated_at = ?`);
  binds.push(new Date().toISOString());
  binds.push(params.id);
  const r = await env.DB.prepare(
    `UPDATE ${mod.table} SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...binds)
    .run();
  if (!r.meta || r.meta.changes === 0) return json({ error: "not found" }, 404);
  const row = await env.DB.prepare(`SELECT * FROM ${mod.table} WHERE id = ?`)
    .bind(params.id)
    .first();
  return json({ ok: true, ...contentRowToShape(row, mod) });
}

async function contentDelete(env, mod, params) {
  if (!params.id) return json({ error: "id required" }, 400);
  const r = await env.DB.prepare(`DELETE FROM ${mod.table} WHERE id = ?`)
    .bind(params.id)
    .run();
  return json({ ok: true, id: params.id, deleted: (r.meta?.changes || 0) > 0 });
}

async function contentPin(env, mod, params) {
  if (!params.id) return json({ error: "id required" }, 400);
  const pinned = params.pinned ? 1 : 0;
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    `UPDATE ${mod.table} SET pinned = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(pinned, now, params.id)
    .run();
  if (!r.meta || r.meta.changes === 0) return json({ error: "not found" }, 404);
  return json({ ok: true, id: params.id, pinned: !!params.pinned });
}

async function contentReorder(env, mod, params) {
  if (!Array.isArray(params.ids))
    return json({ error: "ids array required" }, 400);
  const total = params.ids.length;
  if (!total) return json({ ok: true, updated: 0 });
  const now = new Date().toISOString();
  const stmts = params.ids.map((id, i) =>
    env.DB.prepare(
      `UPDATE ${mod.table} SET "정렬" = ?, updated_at = ? WHERE id = ?`,
    ).bind(total - i, now, id),
  );
  await env.DB.batch(stmts);
  return json({ ok: true, updated: total });
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 이미지 업로드 /api/admin/upload
// ─────────────────────────────────────────────────────────────────
async function handleUpload(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { module: moduleKey, filename, mime, base64 } = body || {};
  if (!moduleKey || !ALLOWED_UPLOAD_MODULES.has(moduleKey))
    return json({ error: "invalid module" }, 400);
  if (!filename || !mime || !base64)
    return json({ error: "filename, mime, base64 required" }, 400);
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime))
    return json({ error: "unsupported mime" }, 415);
  if (!env.BUCKET) return json({ error: "R2 bucket not bound" }, 500);

  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const uuid = crypto.randomUUID();
    const ext = (mime.split("/")[1] || "bin").replace("jpeg", "jpg");
    const key = `${moduleKey}/${uuid}.${ext}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });

    const publicUrl = `${env.R2_PUBLIC_URL}/${key}`;
    return json({ ok: true, url: publicUrl, key, size: bytes.length });
  } catch (err) {
    return json(
      { error: "Upload failed", detail: String(err).slice(0, 200) },
      500,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// YouTube Data API v3 — 채널 영상 자동 동기화 (홍유진TV)
// ─────────────────────────────────────────────────────────────────
function parseYoutubeDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (
    parseInt(m[1] || 0) * 3600 + parseInt(m[2] || 0) * 60 + parseInt(m[3] || 0)
  );
}

// YouTube API 일시적 오류 대비 재시도 fetch
// (search/playlistItems가 간헐적으로 403 "cannot act on behalf of..."을 뱉는 알려진 버그 + 5xx 대응)
async function ytFetchJson(url, label, tries = 3) {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    lastErr = (await res.text()).slice(0, 300);
    const retryable = res.status === 403 || res.status >= 500;
    if (!retryable || i === tries - 1) {
      throw new Error(`${label} ${res.status}: ${lastErr}`);
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
}

async function syncYoutubeVideos(env) {
  if (!env.YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY 미설정");
  if (!env.YOUTUBE_CHANNEL_ID) throw new Error("YOUTUBE_CHANNEL_ID 미설정");
  if (!env.DB) throw new Error("DB binding 없음");

  const KEY = env.YOUTUBE_API_KEY;
  const CHANNEL_ID = env.YOUTUBE_CHANNEL_ID;
  // 채널 업로드 플레이리스트(UC→UU)로 조회 — search.list보다 안정적이고 quota 100배 저렴(1유닛/회)
  const uploadsId = CHANNEL_ID.startsWith("UC")
    ? "UU" + CHANNEL_ID.slice(2)
    : CHANNEL_ID;

  const sUrl =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?key=${KEY}&playlistId=${encodeURIComponent(uploadsId)}` +
    `&part=contentDetails&maxResults=50`;
  const sData = await ytFetchJson(sUrl, "playlistItems.list");
  const videoIds = (sData.items || [])
    .map((i) => i.contentDetails?.videoId)
    .filter(Boolean);
  if (!videoIds.length) return { inserted: 0, updated: 0, total: 0 };

  const vUrl =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?key=${KEY}&id=${videoIds.join(",")}&part=snippet,contentDetails`;
  const vData = await ytFetchJson(vUrl, "videos.list");
  const items = vData.items || [];

  let inserted = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const item of items) {
    const videoId = item.id;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const sn = item.snippet || {};
    const cd = item.contentDetails || {};
    const title = (sn.title || "").slice(0, 500);
    const description = (sn.description || "").slice(0, 2000);
    const thumb =
      sn.thumbnails?.maxres?.url ||
      sn.thumbnails?.high?.url ||
      sn.thumbnails?.medium?.url ||
      sn.thumbnails?.default?.url ||
      "";
    const publishedAt = (sn.publishedAt || "").slice(0, 10);
    const dur = parseYoutubeDuration(cd.duration);
    const videoType = dur > 0 && dur < 60 ? "짧은결혼이야기" : "홍유진TV";

    const existing = await env.DB.prepare(
      `SELECT id FROM content_youtube WHERE "YouTubeURL" = ? LIMIT 1`,
    )
      .bind(url)
      .first();

    if (existing) {
      await env.DB.prepare(
        `UPDATE content_youtube SET "제목" = ?, "설명" = ?, "썸네일" = ?, "게시일" = ?, "영상타입" = ?, "자동수집" = 1, updated_at = ? WHERE id = ?`,
      )
        .bind(
          title,
          description,
          thumb,
          publishedAt,
          videoType,
          now,
          existing.id,
        )
        .run();
      updated++;
    } else {
      const id = generateRecordId();
      await env.DB.prepare(
        `INSERT INTO content_youtube (id, "제목", "영상타입", "YouTubeURL", "설명", "썸네일", "게시일", "자동수집", pinned, "정렬", "상태", created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, '공개', ?, ?)`,
      )
        .bind(
          id,
          title,
          videoType,
          url,
          description,
          thumb,
          publishedAt,
          now,
          now,
        )
        .run();
      inserted++;
    }
  }

  return { inserted, updated, total: items.length };
}

async function handleYoutubeSync(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;

  try {
    const result = await syncYoutubeVideos(env);
    return json({ ok: true, ...result });
  } catch (e) {
    const msg = (e?.message || "").slice(0, 200);
    tgDebug(env, `[noblehong/youtube-sync] ${msg}`);
    return json({ error: "Sync 실패", detail: msg }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// GA4 Data API — 방문통계 스냅샷 영속화 (D1 요약 + R2 원본)
// ─────────────────────────────────────────────────────────────────
const GA4_SUMMARY_METRICS = [
  "totalUsers",
  "activeUsers",
  "newUsers",
  "sessions",
  "screenPageViews",
  "eventCount",
  "keyEvents",
  "engagementRate",
  "averageSessionDuration",
];
const GA4_FLOW_METRICS = [
  "totalUsers",
  "sessions",
  "screenPageViews",
  "keyEvents",
];

function isIsoDate(raw) {
  const s = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function daysInclusive(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.floor((end - start) / 86400000) + 1;
}

function parseGa4Range(rangeKey, startDateInput, endDateInput) {
  const startDate = String(startDateInput || "").trim();
  const endDate = String(endDateInput || "").trim();
  if (startDate || endDate) {
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
      throw new Error("GA4 custom date requires YYYY-MM-DD startDate/endDate");
    }
    const days = daysInclusive(startDate, endDate);
    if (days <= 0)
      throw new Error("GA4 custom date startDate must be before endDate");
    if (days > 366)
      throw new Error("GA4 custom date range is limited to 366 days");
    return {
      rangeKey: `custom_${startDate}_${endDate}`,
      days,
      startDate,
      endDate,
      snapshotStartDate: startDate,
      snapshotEndDate: endDate,
    };
  }
  const raw = String(rangeKey || "28d")
    .trim()
    .toLowerCase();
  const days = raw === "7d" ? 7 : raw === "90d" ? 90 : 28;
  return {
    rangeKey: `${days}d`,
    days,
    startDate: `${days - 1}daysAgo`,
    endDate: "today",
    snapshotStartDate: isoDateUTC(-(days - 1)),
    snapshotEndDate: isoDateUTC(0),
  };
}

function isoDateUTC(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function ga4Date(raw) {
  const s = String(raw || "");
  if (/^\d{8}$/.test(s))
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return s.slice(0, 10);
}

function metricNumber(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

async function ga4AccessToken(env) {
  const clientId = env.GA4_OAUTH_CLIENT_ID;
  const clientSecret = env.GA4_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GA4_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("GA4 OAuth env missing");
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = await tokenRes.json();
  if (!tokenRes.ok || !data.access_token) {
    throw new Error(
      `GA4 token ${tokenRes.status}: ${String(data.error || data.error_description || "").slice(0, 160)}`,
    );
  }
  return data.access_token;
}

async function ga4RunReport(env, accessToken, body) {
  const propertyId = env.GA4_PROPERTY_ID;
  if (!propertyId) throw new Error("GA4_PROPERTY_ID missing");
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `GA4 runReport ${res.status}: ${String(data.error?.message || "").slice(0, 200)}`,
    );
  }
  return data;
}

function ga4Rows(report, dimensions, metrics) {
  return (report.rows || []).map((row) => {
    const out = {};
    dimensions.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value || "";
    });
    metrics.forEach((name, i) => {
      out[name] = metricNumber(row.metricValues?.[i]?.value);
    });
    return out;
  });
}

function sumBy(items, keyFn, seedFn, mergeFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, seedFn(item));
    mergeFn(map.get(key), item);
  }
  return Array.from(map.values());
}

function buildGa4Snapshot(env, range, reports) {
  const dateRows = ga4Rows(reports.date, ["date"], GA4_SUMMARY_METRICS);
  const channelRows = ga4Rows(
    reports.channel,
    ["date", "sessionDefaultChannelGroup", "sessionSourceMedium"],
    GA4_FLOW_METRICS,
  );
  const pageRows = ga4Rows(
    reports.page,
    ["date", "pagePath", "pageTitle"],
    ["screenPageViews", "totalUsers", "sessions"],
  );
  const deviceRows = ga4Rows(
    reports.device,
    ["deviceCategory"],
    GA4_FLOW_METRICS,
  );

  const totals = dateRows.reduce(
    (acc, r) => {
      for (const k of [
        "totalUsers",
        "activeUsers",
        "newUsers",
        "sessions",
        "screenPageViews",
        "eventCount",
        "keyEvents",
      ]) {
        acc[k] += metricNumber(r[k]);
      }
      acc.engagementRateWeighted +=
        metricNumber(r.engagementRate) * metricNumber(r.sessions);
      acc.avgSessionDurationWeighted +=
        metricNumber(r.averageSessionDuration) * metricNumber(r.sessions);
      return acc;
    },
    {
      totalUsers: 0,
      activeUsers: 0,
      newUsers: 0,
      sessions: 0,
      screenPageViews: 0,
      eventCount: 0,
      keyEvents: 0,
      engagementRateWeighted: 0,
      avgSessionDurationWeighted: 0,
    },
  );
  const sessions = Math.max(totals.sessions, 1);
  totals.engagementRate = totals.engagementRateWeighted / sessions;
  totals.averageSessionDuration = totals.avgSessionDurationWeighted / sessions;

  const channels = sumBy(
    channelRows,
    (r) =>
      [
        ga4Date(r.date),
        r.sessionDefaultChannelGroup || "(not set)",
        r.sessionSourceMedium || "(not set)",
      ].join("|"),
    (r) => ({
      date: ga4Date(r.date),
      channel: r.sessionDefaultChannelGroup || "(not set)",
      sourceMedium: r.sessionSourceMedium || "(not set)",
      totalUsers: 0,
      sessions: 0,
      screenPageViews: 0,
      keyEvents: 0,
    }),
    (acc, r) => {
      acc.totalUsers += metricNumber(r.totalUsers);
      acc.sessions += metricNumber(r.sessions);
      acc.screenPageViews += metricNumber(r.screenPageViews);
      acc.keyEvents += metricNumber(r.keyEvents);
    },
  )
    .sort((a, b) => b.totalUsers - a.totalUsers)
    .slice(0, 80);

  const pages = sumBy(
    pageRows,
    (r) => [ga4Date(r.date), r.pagePath || "/"].join("|"),
    (r) => ({
      date: ga4Date(r.date),
      pagePath: r.pagePath || "/",
      pageTitle: r.pageTitle || "",
      screenPageViews: 0,
      totalUsers: 0,
      sessions: 0,
    }),
    (acc, r) => {
      acc.screenPageViews += metricNumber(r.screenPageViews);
      acc.totalUsers += metricNumber(r.totalUsers);
      acc.sessions += metricNumber(r.sessions);
    },
  )
    .sort((a, b) => b.screenPageViews - a.screenPageViews)
    .slice(0, 80);

  const devices = deviceRows
    .map((r) => ({
      deviceCategory: r.deviceCategory || "(not set)",
      totalUsers: metricNumber(r.totalUsers),
      sessions: metricNumber(r.sessions),
      screenPageViews: metricNumber(r.screenPageViews),
      keyEvents: metricNumber(r.keyEvents),
    }))
    .sort((a, b) => b.totalUsers - a.totalUsers);

  const endDate = range.snapshotEndDate || isoDateUTC(0);
  return {
    id: `ga4_${env.GA4_PROPERTY_ID}_${range.rangeKey}_${endDate}_${crypto.randomUUID()}`,
    propertyId: String(env.GA4_PROPERTY_ID),
    rangeKey: range.rangeKey,
    startDate: range.snapshotStartDate || isoDateUTC(-(range.days - 1)),
    endDate: range.snapshotEndDate || endDate,
    createdAt: new Date().toISOString(),
    totals,
    topChannel: channels[0]?.channel || "",
    topPage: pages[0]?.pagePath || "",
    channels,
    pages,
    devices,
    raw: reports,
  };
}

async function persistGa4Snapshot(env, snapshot) {
  if (!env.DB) throw new Error("DB binding missing");
  let rawR2Key = "";
  if (env.BUCKET) {
    rawR2Key = `analytics/ga4/property-${snapshot.propertyId}/${snapshot.endDate}/${snapshot.id}.json`;
    await env.BUCKET.put(rawR2Key, JSON.stringify(snapshot), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        propertyId: snapshot.propertyId,
        rangeKey: snapshot.rangeKey,
        createdAt: snapshot.createdAt,
      },
    });
  }

  const t = snapshot.totals;
  await env.DB.prepare(
    `INSERT INTO ga4_snapshots (
      id, property_id, range_key, start_date, end_date,
      total_users, active_users, new_users, sessions, screen_page_views,
      event_count, key_events, engagement_rate, avg_session_duration,
      top_channel, top_page, raw_r2_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      snapshot.id,
      snapshot.propertyId,
      snapshot.rangeKey,
      snapshot.startDate,
      snapshot.endDate,
      Math.round(t.totalUsers),
      Math.round(t.activeUsers),
      Math.round(t.newUsers),
      Math.round(t.sessions),
      Math.round(t.screenPageViews),
      Math.round(t.eventCount),
      Math.round(t.keyEvents),
      t.engagementRate,
      t.averageSessionDuration,
      snapshot.topChannel,
      snapshot.topPage,
      rawR2Key,
      snapshot.createdAt,
    )
    .run();

  const stmts = [];
  for (const row of snapshot.channels) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO ga4_channel_daily (
          snapshot_id, report_date, channel, source_medium,
          total_users, sessions, screen_page_views, key_events
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshot.id,
        row.date,
        row.channel,
        row.sourceMedium,
        Math.round(row.totalUsers),
        Math.round(row.sessions),
        Math.round(row.screenPageViews),
        Math.round(row.keyEvents),
      ),
    );
  }
  for (const row of snapshot.pages) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO ga4_page_daily (
          snapshot_id, report_date, page_path, page_title,
          screen_page_views, total_users, sessions
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshot.id,
        row.date,
        row.pagePath,
        row.pageTitle,
        Math.round(row.screenPageViews),
        Math.round(row.totalUsers),
        Math.round(row.sessions),
      ),
    );
  }
  for (const row of snapshot.devices) {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO ga4_device_breakdown (
          snapshot_id, device_category, total_users, sessions,
          screen_page_views, key_events
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshot.id,
        row.deviceCategory,
        Math.round(row.totalUsers),
        Math.round(row.sessions),
        Math.round(row.screenPageViews),
        Math.round(row.keyEvents),
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ...snapshot, rawR2Key };
}

async function syncGa4Analytics(env, rangeKey = "28d", startDate, endDate) {
  const range = parseGa4Range(rangeKey, startDate, endDate);
  const accessToken = await ga4AccessToken(env);
  const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
  const reports = {
    date: await ga4RunReport(env, accessToken, {
      dateRanges,
      dimensions: [{ name: "date" }],
      metrics: GA4_SUMMARY_METRICS.map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 120,
    }),
    channel: await ga4RunReport(env, accessToken, {
      dateRanges,
      dimensions: [
        { name: "date" },
        { name: "sessionDefaultChannelGroup" },
        { name: "sessionSourceMedium" },
      ],
      metrics: GA4_FLOW_METRICS.map((name) => ({ name })),
      orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
      limit: 200,
    }),
    page: await ga4RunReport(env, accessToken, {
      dateRanges,
      dimensions: [
        { name: "date" },
        { name: "pagePath" },
        { name: "pageTitle" },
      ],
      metrics: ["screenPageViews", "totalUsers", "sessions"].map((name) => ({
        name,
      })),
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 200,
    }),
    device: await ga4RunReport(env, accessToken, {
      dateRanges,
      dimensions: [{ name: "deviceCategory" }],
      metrics: GA4_FLOW_METRICS.map((name) => ({ name })),
      orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
      limit: 10,
    }),
  };
  const snapshot = buildGa4Snapshot(env, range, reports);
  return persistGa4Snapshot(env, snapshot);
}

async function latestGa4Snapshot(env, rangeKey = "28d", startDate, endDate) {
  if (!env.DB) throw new Error("DB binding missing");
  const propertyId = String(env.GA4_PROPERTY_ID || "");
  if (!propertyId) throw new Error("GA4_PROPERTY_ID missing");
  const range = parseGa4Range(rangeKey, startDate, endDate);
  const row = await env.DB.prepare(
    `SELECT * FROM ga4_snapshots WHERE property_id = ? AND range_key = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(propertyId, range.rangeKey)
    .first();
  if (!row) return null;
  const [channels, pages, devices] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM ga4_channel_daily WHERE snapshot_id = ? ORDER BY total_users DESC LIMIT 20`,
    )
      .bind(row.id)
      .all(),
    env.DB.prepare(
      `SELECT * FROM ga4_page_daily WHERE snapshot_id = ? ORDER BY screen_page_views DESC LIMIT 20`,
    )
      .bind(row.id)
      .all(),
    env.DB.prepare(
      `SELECT * FROM ga4_device_breakdown WHERE snapshot_id = ? ORDER BY total_users DESC`,
    )
      .bind(row.id)
      .all(),
  ]);
  return {
    id: row.id,
    propertyId: row.property_id,
    rangeKey: row.range_key,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    rawR2Key: row.raw_r2_key,
    totals: {
      totalUsers: Number(row.total_users || 0),
      activeUsers: Number(row.active_users || 0),
      newUsers: Number(row.new_users || 0),
      sessions: Number(row.sessions || 0),
      screenPageViews: Number(row.screen_page_views || 0),
      eventCount: Number(row.event_count || 0),
      keyEvents: Number(row.key_events || 0),
      engagementRate: Number(row.engagement_rate || 0),
      averageSessionDuration: Number(row.avg_session_duration || 0),
    },
    topChannel: row.top_channel || "",
    topPage: row.top_page || "",
    channels: channels.results || [],
    pages: pages.results || [],
    devices: devices.results || [],
  };
}

async function latestGa4SnapshotMeta(env) {
  if (!env.DB) return null;
  const propertyId = String(env.GA4_PROPERTY_ID || "");
  if (!propertyId) return null;
  const row = await env.DB.prepare(
    `SELECT id, range_key, start_date, end_date, total_users, sessions, screen_page_views, raw_r2_key, created_at
     FROM ga4_snapshots
     WHERE property_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
  )
    .bind(propertyId)
    .first();
  if (!row) return null;
  return {
    id: row.id,
    rangeKey: row.range_key,
    startDate: row.start_date,
    endDate: row.end_date,
    totalUsers: Number(row.total_users || 0),
    sessions: Number(row.sessions || 0),
    screenPageViews: Number(row.screen_page_views || 0),
    rawR2: Boolean(row.raw_r2_key),
    createdAt: row.created_at,
  };
}

async function handleAnalyticsStatus(request, env) {
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;

  const checkedAt = new Date().toISOString();
  try {
    const accessToken = await ga4AccessToken(env);
    const report = await ga4RunReport(env, accessToken, {
      dateRanges: [{ startDate: "today", endDate: "today" }],
      metrics: [{ name: "totalUsers" }],
      limit: 1,
    });
    return json({
      ok: true,
      connected: true,
      propertyId: String(env.GA4_PROPERTY_ID || ""),
      checkedAt,
      todayUsers: metricNumber(report.rows?.[0]?.metricValues?.[0]?.value),
      latestSnapshot: await latestGa4SnapshotMeta(env),
    });
  } catch (e) {
    return json({
      ok: true,
      connected: false,
      propertyId: String(env.GA4_PROPERTY_ID || ""),
      checkedAt,
      error: String(e?.message || e).slice(0, 200),
      latestSnapshot: await latestGa4SnapshotMeta(env),
    });
  }
}

async function handleAnalyticsSummary(request, env) {
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "28d";
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  try {
    const snapshot = await latestGa4Snapshot(env, range, startDate, endDate);
    return json({ ok: true, snapshot });
  } catch (e) {
    return json(
      {
        error: "Analytics summary failed",
        detail: String(e?.message || e).slice(0, 200),
      },
      500,
    );
  }
}

async function handleAnalyticsSync(request, env) {
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  const gate = await requireAuth(request, env);
  if (gate.error) return gate.error;
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "28d";
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  try {
    const snapshot = await syncGa4Analytics(env, range, startDate, endDate);
    return json({
      ok: true,
      snapshot: {
        id: snapshot.id,
        propertyId: snapshot.propertyId,
        rangeKey: snapshot.rangeKey,
        startDate: snapshot.startDate,
        endDate: snapshot.endDate,
        createdAt: snapshot.createdAt,
        rawR2Key: snapshot.rawR2Key,
        totals: snapshot.totals,
        topChannel: snapshot.topChannel,
        topPage: snapshot.topPage,
      },
      counts: {
        channels: snapshot.channels.length,
        pages: snapshot.pages.length,
        devices: snapshot.devices.length,
      },
    });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 220);
    tgDebug(env, `[noblehong/ga4-sync] ${msg}`);
    return json({ error: "GA4 sync failed", detail: msg }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 공개 조회 /api/content
// ─────────────────────────────────────────────────────────────────
async function handlePublicContent(request, env) {
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  const moduleKey = url.searchParams.get("module");
  if (!moduleKey || !MODULES[moduleKey])
    return json({ error: "invalid module" }, 400);
  const mod = MODULES[moduleKey];
  if (!env.DB) return json({ error: "DB not bound" }, 500);

  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
  const offset = Number(url.searchParams.get("offset")) || 0;
  const onlyPinned = url.searchParams.get("pinned") === "true";

  const where = [`"상태" = ?`];
  const binds = ["공개"];
  if (onlyPinned) where.push(`pinned = 1`);
  const sql = `SELECT * FROM ${mod.table} WHERE ${where.join(" AND ")} ORDER BY pinned DESC, "정렬" DESC, "${mod.dateField}" DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  try {
    const r = await env.DB.prepare(sql)
      .bind(...binds)
      .all();
    const rows = r.results || [];
    const records = rows.map((row) => contentRowToShape(row, mod));
    const nextOffset = rows.length === limit ? String(offset + limit) : null;
    return json(
      { ok: true, module: moduleKey, records, offset: nextOffset },
      200,
      { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    );
  } catch (e) {
    tgDebug(
      env,
      `[noblehong/public-content] ${moduleKey} ${(e?.message || "").slice(0, 160)}`,
    );
    return json({ error: "Server error" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러: 레거시 커플매니저 스크레이핑 /api/couple-manager/search
// ─────────────────────────────────────────────────────────────────
async function handleCoupleManagerSearch(request) {
  const url = new URL(request.url);
  let cmgName = url.searchParams.get("cmgName") || "";
  if (!cmgName && request.method === "POST") {
    try {
      const body = await request.json();
      cmgName = body?.cmgName || "";
    } catch {}
  }
  if (!cmgName || cmgName.length > 10)
    return json(
      { found: false, error: "cmgName is required (max 10 chars)" },
      400,
    );

  try {
    const html = await fetchLegacyManager(cmgName);
    return json(parseManagerProfile(html));
  } catch {
    return json({ found: false, error: "Legacy server unavailable" }, 502);
  }
}

async function fetchLegacyManager(cmgName) {
  const postData = `cmgName=${encodeURIComponent(cmgName)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    // HTTP + IP + Host 헤더로 카페24 가상호스트 매칭
    const r = await fetch("http://1.234.1.48/sub02/sub02_06_view.html", {
      method: "POST",
      headers: {
        Host: "www.noblehong.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: postData,
      signal: ctrl.signal,
    });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function parseManagerProfile(html) {
  const imgMatch = html.match(
    /<img\s+src="(\/_xfile\/manager\/[^"]+)"\s+width/,
  );
  // imgMatch[1] = "/_xfile/manager/홍유진.jpg" → Worker manager-photo proxy로 변환
  const photo = imgMatch
    ? `/api/manager-photo/${imgMatch[1].split("/").pop()}`
    : null;

  const nameMatch = html.match(
    /class="txt_name">([^<&]+)(?:&nbsp;)?\s*<span>([^<]*)<\/span>/,
  );
  const name = nameMatch ? nameMatch[1].trim() : null;
  const role = nameMatch ? nameMatch[2].trim() : null;
  if (!name) return { found: false, manager: null };

  const profileBlocks = [];
  const profileRegex = /class="txt_profile">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = profileRegex.exec(html)) !== null)
    profileBlocks.push(m[1].trim());

  const career = [];
  const history = [];
  const education = [];
  profileBlocks.forEach((block) => {
    const text = block
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        if (line.startsWith("[이력사항]") || line.startsWith("<이력사항>"))
          return;
        if (line.startsWith("<경력>") || line.startsWith("[경력]")) return;
        if (line.startsWith(". ") || line.startsWith("· ")) {
          const cleaned = line.replace(/^[.·]\s*/, "");
          if (
            cleaned.includes("논문") ||
            cleaned.includes("박사") ||
            cleaned.includes("석사") ||
            cleaned.includes("학위")
          )
            education.push(cleaned);
          else history.push(cleaned);
        } else if (
          line.length > 2 &&
          !line.startsWith("<") &&
          !line.startsWith("[")
        ) {
          career.push(line);
        }
      });
  });

  return {
    found: true,
    manager: {
      name,
      role: role || "",
      photo,
      career: career.length ? career : null,
      history: history.length ? history : null,
      education: education.length ? education : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// 매니저 사진 R2 lazy caching + 매월 말일 동기화
// /api/manager-photo/{filename} — R2 hit이면 즉시, miss면 카페24 fetch → R2 PUT
// 카페24 서버 파일은 READ-only로만 fetch (변경 X)
// ─────────────────────────────────────────────────────────────────
async function handleManagerPhoto(request, env) {
  const url = new URL(request.url);
  const raw = url.pathname.replace("/api/manager-photo/", "");
  const filename = decodeURIComponent(raw);
  if (!filename || !/^[^/]+\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
    return json({ error: "Invalid filename" }, 400);
  }
  const r2Key = `manager/${filename}`;

  // 1) R2 hit
  if (env.BUCKET) {
    const obj = await env.BUCKET.get(r2Key);
    if (obj) {
      const ct = obj.httpMetadata?.contentType || "image/jpeg";
      return new Response(obj.body, {
        headers: {
          "Content-Type": ct,
          "Cache-Control": "public, max-age=86400",
          "X-R2-Cache": "HIT",
        },
      });
    }
  }

  // 2) Miss → 카페24 fetch (HTTP + crm hostname + Host 헤더 우회 패턴)
  const sourceUrl = `http://crm.noblehong.com/_xfile/manager/${encodeURIComponent(filename)}`;
  let fetchRes;
  try {
    fetchRes = await fetch(sourceUrl, {
      headers: { Host: "www.noblehong.com" },
    });
  } catch (e) {
    return new Response("Upstream fetch failed", { status: 502 });
  }
  if (!fetchRes.ok) {
    return new Response("Not Found", { status: fetchRes.status });
  }

  const ct = fetchRes.headers.get("Content-Type") || "image/jpeg";
  const bytes = await fetchRes.arrayBuffer();

  // 3) R2 PUT (background, fire-and-forget)
  if (env.BUCKET) {
    bgRun(
      env,
      env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: ct } }),
    );
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=86400",
      "X-R2-Cache": "MISS",
    },
  });
}

// R2 listing 기반 재동기화: 매월 말일 cron이 호출
async function syncManagerPhotosR2(env) {
  if (!env.BUCKET) return { synced: 0, failed: 0, total: 0 };
  let synced = 0,
    failed = 0;
  const list = await env.BUCKET.list({ prefix: "manager/" });
  for (const obj of list.objects) {
    const filename = obj.key.replace("manager/", "");
    try {
      const sourceUrl = `http://crm.noblehong.com/_xfile/manager/${encodeURIComponent(filename)}`;
      const r = await fetch(sourceUrl, {
        headers: { Host: "www.noblehong.com" },
      });
      if (r.ok) {
        const ct = r.headers.get("Content-Type") || "image/jpeg";
        const bytes = await r.arrayBuffer();
        await env.BUCKET.put(obj.key, bytes, {
          httpMetadata: { contentType: ct },
        });
        synced++;
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }
  }
  return { synced, failed, total: list.objects.length };
}

// ─────────────────────────────────────────────────────────────────
// 라우터
// ─────────────────────────────────────────────────────────────────
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Health
  if (path === "/" || path === "/api/health")
    return json({ ok: true, service: "noblehong-api", version: "1.0" });

  // Consultation
  if (path === "/api/consultation/submit")
    return handleConsultationSubmit(request, env);
  if (path === "/api/consultation/fall-meeting")
    return handleFallMeeting(request, env);
  if (path === "/api/consultation/quick")
    return handleConsultationQuick(request, env);
  if (path === "/api/consultation/bar")
    return handleConsultationBar(request, env);
  if (path === "/api/lead/meta") return handleMetaLead(request, env);
  if (path === "/api/lead/meta/heartbeat")
    return handleMetaLeadHeartbeat(request, env);

  // Admin auth
  if (path === "/api/admin/login") return handleAdminLogin(request, env);
  if (path === "/api/admin/otp/request") return handleOtpRequest(request, env);
  if (path === "/api/admin/otp/verify") return handleOtpVerify(request, env);
  if (path === "/api/admin/me") return handleAdminMe(request, env);
  if (path === "/api/admin/logout") return handleAdminLogout(request);

  // Admin consultations
  if (path === "/api/admin/consultations/list")
    return handleConsultationsList(request, env);
  if (path === "/api/admin/consultations/update")
    return handleConsultationsUpdate(request, env);
  if (path === "/api/admin/consultations/delete")
    return handleConsultationsDelete(request, env);

  // Admin blacklist
  if (path === "/api/admin/blacklist/list")
    return handleBlacklistList(request, env);
  if (path === "/api/admin/blacklist/add")
    return handleBlacklistAdd(request, env);
  if (path === "/api/admin/blacklist/delete")
    return handleBlacklistDelete(request, env);

  // Admin content
  if (path === "/api/admin/content") return handleAdminContent(request, env);
  if (path === "/api/admin/upload") return handleUpload(request, env);
  if (path === "/api/admin/youtube/sync")
    return handleYoutubeSync(request, env);
  if (path === "/api/admin/analytics/status")
    return handleAnalyticsStatus(request, env);
  if (path === "/api/admin/analytics/summary")
    return handleAnalyticsSummary(request, env);
  if (path === "/api/admin/analytics/sync")
    return handleAnalyticsSync(request, env);

  // Public
  if (path === "/api/content") return handlePublicContent(request, env);
  if (path === "/api/couple-manager/search")
    return handleCoupleManagerSearch(request);
  if (path.startsWith("/api/manager-photo/"))
    return handleManagerPhoto(request, env);

  return json({ error: "Not found", path }, 404);
}

export default {
  async fetch(request, env, ctx) {
    // 핸들러에서 fire-and-forget 작업을 ctx.waitUntil로 예약할 수 있도록 env에 주입
    env.__ctx = ctx;
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    try {
      const response = await route(request, env);
      return mergeHeaders(response, cors);
    } catch (err) {
      return mergeHeaders(json({ error: "Uncaught exception" }, 500), cors);
    }
  },

  // Cron Triggers (UTC):
  //   "0 18 * * *"      매일 KST 03:00 — 홍유진TV + GA4 방문통계 동기화
  //   "0 18 28-31 * *"  28~31일 KST 03:00 — 코드에서 말일 체크 후 매니저 사진 R2 재동기화
  async scheduled(event, env, ctx) {
    const cronExpr = event.cron;

    // 6시간마다 데드맨 스위치 — 아이맥 폴러 하트비트 노후 감지 (00/06/12/18 UTC).
    // 사이트 접수경로 프로브는 아이맥 폴러가 1시간마다 직접 돈다(runHealthCheck 주석 참조).
    // 아래 유튜브/GA4 동기화가 조건 없이 실행되므로 반드시 조기 return으로 격리한다.
    // (18:00 은 "0 18 * * *" 과 겹치지만 CF가 크론별로 event.cron 을 따로 넘기므로
    //  각 크론이 자기 분기만 탄다 — 유튜브가 6시간마다 도는 일은 없음)
    if (cronExpr === "0 */6 * * *") {
      ctx.waitUntil(
        (async () => {
          try {
            // 미배달 알림 재발송 먼저 — 토큰이 복구됐다면 밀린 알림이 여기서 나간다.
            const flushed = await tgOutboxFlush(env);
            if (flushed.sent > 0)
              await sendInfraAlert(
                env,
                `<b>[노블홍/telegram] 📤 미배달 재발송</b>\n──────────────\n` +
                  `- <b>발송</b>  ${flushed.sent}건\n- <b>잔여</b>  ${flushed.left}건`,
                { silent: true },
              );
            await runHealthCheck(env);
          } catch (e) {
            await sendInfraAlert(
              env,
              `[노블홍/healthcheck] 체크 자체 실패 — ${String(e?.message || e).slice(0, 200)}`,
            );
          }
        })(),
      );
      return;
    }

    // 매일 매니저 사진 cron 후보 슬롯이면 말일 여부 체크
    if (cronExpr === "0 18 28-31 * *") {
      ctx.waitUntil(
        (async () => {
          try {
            const kst = new Date(Date.now() + 9 * 3600 * 1000);
            const tomorrow = new Date(
              kst.getFullYear(),
              kst.getMonth(),
              kst.getDate() + 1,
            );
            const isLastDay = tomorrow.getDate() === 1;
            if (!isLastDay) return; // 28/29/30/31 중 말일 아니면 skip
            const r = await syncManagerPhotosR2(env);
            tgDebug(
              env,
              `[노블홍/manager-sync] R2 재동기화 — 갱신 ${r.synced} / 실패 ${r.failed} / 총 ${r.total}`,
            );
          } catch (e) {
            tgDebug(
              env,
              `[노블홍/manager-sync] 실패: ${(e?.message || "").slice(0, 200)}`,
            );
          }
        })(),
      );
      return;
    }

    if (cronExpr === "0 18 * * *") {
      ctx.waitUntil(snapshotFallAudit(env).catch(() => {}));
    }

    // 기존: 매일 홍유진TV 동기화
    ctx.waitUntil(
      (async () => {
        try {
          const r = await syncYoutubeVideos(env);
          tgDebug(
            env,
            `[noblehong/youtube-cron] 동기화 완료 — 신규 ${r.inserted} / 갱신 ${r.updated} / 총 ${r.total}`,
          );
        } catch (e) {
          tgDebug(
            env,
            `[noblehong/youtube-cron] 실패: ${(e?.message || "").slice(0, 200)}`,
          );
        }
        try {
          if (
            env.GA4_PROPERTY_ID &&
            env.GA4_OAUTH_CLIENT_ID &&
            env.GA4_OAUTH_CLIENT_SECRET &&
            env.GA4_OAUTH_REFRESH_TOKEN
          ) {
            const r = await syncGa4Analytics(env, "28d");
            tgDebug(
              env,
              `[noblehong/ga4-cron] 스냅샷 완료 — users ${Math.round(r.totals.totalUsers)} / pages ${r.pages.length} / R2 ${r.rawR2Key ? "ok" : "skip"}`,
            );
          }
        } catch (e) {
          tgDebug(
            env,
            `[noblehong/ga4-cron] 실패: ${(e?.message || "").slice(0, 200)}`,
          );
        }
      })(),
    );
  },
};
