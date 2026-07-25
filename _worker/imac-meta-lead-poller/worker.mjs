#!/usr/bin/env node
// 노블홍 — 아이맥 Meta 리드 폴러
//
// Meta 입력양식 리드를 시스템사용자 토큰으로 1시간마다 조회 → 워커 /api/lead/meta 로 전달.
// Make.com 웹훅을 대체한다(Make가 끊기면 접수가 통째로 멈추는 단일 장애점이었음).
//
// 필드 매핑은 워커가 담당하므로 원본 field_data 를 그대로 넘긴다
// — 폼 질문이 바뀌어도 아이맥 재배포 없이 워커만 고치면 된다.
// leadId 는 워커에서 멱등키(meta_leads 테이블)로 쓰여, 상태파일이 날아가거나
// 48시간 겹침조회로 같은 리드를 다시 집어와도 중복 접수가 나지 않는다.
//
// 실행:
//   node worker.mjs                       폴링 1회 (launchd가 1시간마다 호출)
//   node worker.mjs --inspect             폼 질문/필드키 덤프 (전송 안 함)
//   META_LEAD_DRY_RUN=1 node worker.mjs   조회만, 전송·알림 안 함

import { createHmac } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TAG = "[noblehong/imac-meta-lead-poller]";
const DEFAULT_GRAPH_VERSION = "v22.0";
// 누락 복구용 겹침 조회. 워커 멱등키가 중복을 흡수하므로 넉넉하게 잡는다.
const DEFAULT_LOOKBACK_HOURS = 48;
const DEFAULT_OVERLAP_HOURS = 48;
const DEFAULT_MAX_PAGES = 10;
// 조용한 정기 생존신고 간격. 이 시간이 지나면 신규 리드가 없어도 인프라봇에 한 줄 남긴다.
const DEFAULT_HEALTH_QUIET_HOURS = 6;
// 미등록 활성폼 확인 간격. Graph 왕복 2번(~1.9초)이라 매시간은 낭비 — 새 폼은 사람이 만든다.
const DEFAULT_FORM_CHECK_HOURS = 6;
const DEFAULT_STATE_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "state.json",
);
const LOCK_STALE_MS = 10 * 60 * 1000;

function envRequired(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} 환경변수가 필요합니다.`);
  return value;
}

function envNumber(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}은 0보다 큰 숫자여야 합니다.`);
  }
  return value;
}

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(
    String(process.env[name] || "")
      .trim()
      .toLowerCase(),
  );
}

export function parseFormIds(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(",")
        .map((value) => value.trim()),
    ),
  ]
    .filter(Boolean)
    .filter((value) => /^\d+$/.test(value));
}

// 전화번호 없는 리드는 워커가 400 으로 거절한다.
// 매시간 재시도해서 실패 알림만 쌓이는 걸 막으려고 폴러 단에서 걸러 처리완료로 마킹한다.
//
// ⚠ 워커 META_FIELD_RULES 의 phone 규칙과 반드시 같은 범위를 유지할 것.
//   여기가 더 좁으면 워커는 읽을 수 있는 리드를 폴러가 먼저 스킵해버리고,
//   스킵은 processed 에 처리완료로 남아 영구 유실이 된다(조회창 48시간이라 재수집 불가).
//   worker.test.mjs 의 "폴러/워커 전화 인식 범위 동일" 테스트가 이 동기화를 강제한다.
export function hasPhone(fieldData) {
  return (fieldData || []).some((item) => {
    const n = String(item?.name || "")
      .trim()
      .toLowerCase();
    return (
      n === "phone_number" ||
      n.includes("phone") ||
      n.includes("mobile") ||
      n.includes("cell") ||
      n.includes("연락처") ||
      n.includes("전화") ||
      n.includes("휴대") ||
      n.includes("핸드폰")
    );
  });
}

// 원본 field_data 를 그대로 전달(매핑은 워커). 광고 메타데이터만 최상위로 정리.
export function buildPayload(lead) {
  const fieldData = Array.isArray(lead?.field_data) ? lead.field_data : [];
  return {
    leadId: String(lead?.id || "").trim(),
    createdTime: String(lead?.created_time || "").trim(),
    // Graph 가 ig/fb 를 직접 준다 — Make 경로에서 유실되던 플랫폼 분류가 여기서 복구된다
    platform: String(lead?.platform || "").trim(),
    adName: String(lead?.ad_name || "").trim(),
    campaignName: String(lead?.campaign_name || "").trim(),
    fieldData: fieldData.map((field) => ({
      name: String(field?.name || ""),
      values: Array.isArray(field?.values)
        ? field.values.map((value) => String(value || ""))
        : [],
    })),
  };
}

export function computeSinceMs({
  nowMs,
  cutoverMs,
  highWatermarkMs,
  lookbackMs,
  overlapMs,
}) {
  const recoveryFloor = highWatermarkMs
    ? highWatermarkMs - overlapMs
    : nowMs - lookbackMs;
  // cutover 이전(=Make가 이미 처리한 구간)은 절대 다시 긁지 않는다
  return Math.max(cutoverMs, recoveryFloor);
}

export function sanitizePagingUrl(raw) {
  const url = new URL(raw);
  url.searchParams.delete("access_token");
  return url.toString();
}

function parseRequiredTime(name, raw) {
  const value = Date.parse(String(raw || ""));
  if (!Number.isFinite(value)) {
    throw new Error(`${name}은 ISO 날짜 형식이어야 합니다.`);
  }
  return value;
}

function appSecretProof(token, secret) {
  if (!secret) return "";
  return createHmac("sha256", secret).update(token).digest("hex");
}

async function fetchFormLeads({
  formId,
  token,
  appSecret,
  graphVersion,
  sinceMs,
  maxPages,
  fetchImpl = fetch,
}) {
  const fields = [
    "id",
    "created_time",
    "platform",
    "ad_name",
    "campaign_name",
    "form_id",
    "ad_id",
    "field_data",
  ].join(",");
  const filtering = JSON.stringify([
    {
      field: "time_created",
      operator: "GREATER_THAN_OR_EQUAL",
      value: Math.floor(sinceMs / 1000),
    },
  ]);
  const initial = new URL(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(formId)}/leads`,
  );
  initial.searchParams.set("fields", fields);
  initial.searchParams.set("filtering", filtering);
  initial.searchParams.set("limit", "100");
  const proof = appSecretProof(token, appSecret);
  if (proof) initial.searchParams.set("appsecret_proof", proof);

  const leads = [];
  let next = initial.toString();
  let pages = 0;
  while (next && pages < maxPages) {
    pages += 1;
    const response = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok || data?.error) {
      const message = String(
        data?.error?.message || `HTTP ${response.status}`,
      ).slice(0, 240);
      throw new Error(`form=${formId} Meta 조회 실패: ${message}`);
    }
    leads.push(...(Array.isArray(data?.data) ? data.data : []));
    next = data?.paging?.next ? sanitizePagingUrl(data.paging.next) : "";
  }
  if (next) throw new Error(`form=${formId} Meta 페이징 상한(${maxPages}) 초과`);
  return leads;
}

function emptyState(cutoverAt) {
  return {
    version: 1,
    cutoverAt,
    highWatermarkAt: cutoverAt,
    lastSuccessfulPollAt: "",
    lastHealthPingAt: "",
    siteStatus: "",
    siteSince: "",
    formsCheck: null,
    lastFormCheckAt: "",
    processed: {},
  };
}

async function readState(path, cutoverAt) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.processed !== "object"
    ) {
      return emptyState(cutoverAt);
    }
    return { ...emptyState(cutoverAt), ...parsed, cutoverAt };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState(cutoverAt);
    throw error;
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export function pruneProcessed(processed, floorMs) {
  const next = {};
  for (const [leadId, createdTime] of Object.entries(processed || {})) {
    const createdMs = Date.parse(String(createdTime || ""));
    if (!Number.isFinite(createdMs) || createdMs >= floorMs)
      next[leadId] = createdTime;
  }
  return next;
}

// 겹치는 실행 방지. launchd가 이전 실행이 끝나기 전에 또 띄워도 조회가 두 번 나가지 않는다.
async function acquireLock(path) {
  const tryOpen = () => open(path, "wx", 0o600);
  try {
    return await tryOpen();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(path, { force: true });
        return await tryOpen();
      }
    } catch (statError) {
      if (statError?.code !== "ENOENT") throw statError;
      return await tryOpen();
    }
    return null;
  }
}

// 워커 /api/lead/meta 로 개별 전달. X-Meta-Secret 헤더 = 워커 env.META_LEAD_SECRET 와 일치.
async function postLead({
  webhookUrl,
  webhookSecret,
  payload,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: {
      "X-Meta-Secret": webhookSecret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    throw new Error(
      `lead=${payload.leadId} 워커 전달 실패: ${String(
        data?.error || `HTTP ${response.status}`,
      ).slice(0, 200)}`,
    );
  }
  return data; // { ok, id } 또는 { ok, duplicate: true }
}

// 워커에 생존 신고. 아이맥이 꺼지면 폴러는 스스로 알릴 수 없으므로,
// 워커 크론이 이 시각의 노후를 보고 대신 "접수 정지"를 감지한다.
async function postHeartbeat({ url, secret, stats, fetchImpl = fetch }) {
  if (!url) return { skipped: true };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "X-Meta-Secret": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(stats),
    });
    // 응답에 카페24 전송 실적(최근 24h)이 실려온다 — 시간당 리포트에 그대로 싣는다
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, cafe24: data?.cafe24 };
  } catch (error) {
    // 하트비트 실패로 폴링 자체를 실패 처리하지 않는다 — 리드 전달이 우선
    return { ok: false, error: String(error?.message || error).slice(0, 120) };
  }
}

// ─────────────────────────────────────────────────────────────────
// 사이트 접수경로 프로브 — 폴링과 같은 1시간 주기로 아이맥에서 직접 찌른다.
//
// 워커 크론(6시간)이 아니라 여기서 도는 이유: 아이맥은 진짜 외부 시점이라
// CF→Vercel→CF 자기호출보다 실제 고객 경로에 가깝고, 주기도 6배 촘촘하다.
// (아이맥 자신의 죽음만은 감지 못 하므로, 그건 워커 크론이 하트비트 침묵으로 잡는다)
//
// 빈 payload {} 를 보내 400(Invalid fields)을 기대한다 — 워커 실행순서상
// saveConsultation 도달 전에 잘리므로 D1·카페24·리드알림·레이트리밋 어디에도 안 남는 드라이런.
// ─────────────────────────────────────────────────────────────────
const HEALTH_SITE = "https://noblehong.com";
const SITE_PROBES = [
  { name: "폼 간편(quick)", method: "POST", path: "/api/consultation/quick", expect: 400 },
  { name: "폼 하단바(bar)", method: "POST", path: "/api/consultation/bar", expect: 400 },
  { name: "폼 풀폼(submit)", method: "POST", path: "/api/consultation/submit", expect: 400 },
  { name: "홈", method: "GET", path: "/", expect: 200 },
  { name: "폼 스크립트", method: "GET", path: "/assets/js/inquiry-bars.js", expect: 200 },
  { name: "cleanUrls(/privacy)", method: "GET", path: "/privacy", expect: 200 },
];

async function probeOne(probe, fetchImpl) {
  const init = { method: probe.method, redirect: "manual" };
  if (probe.method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = "{}";
  }
  try {
    const res = await fetchImpl(HEALTH_SITE + probe.path, init);
    return { ...probe, got: res.status, ok: res.status === probe.expect, reachable: true };
  } catch (error) {
    // fetch 자체가 터진 것 = 아이맥 네트워크 문제일 수 있다.
    // 사이트 장애로 단정하면 오보가 되므로 따로 분류한다.
    return {
      ...probe,
      got: "ERR:" + String(error?.message || error).slice(0, 60),
      ok: false,
      reachable: false,
    };
  }
}

// fail(HTTP 불일치=확실한 장애) / degraded(판정보류) / ok — 워커 헬스체크와 동일한 3단 판정
export function judgeSite(results) {
  const failed = results.filter((r) => r.reachable && !r.ok);
  const unreachable = results.filter((r) => !r.reachable);
  const status = failed.length ? "fail" : unreachable.length ? "degraded" : "ok";
  return { status, failed, unreachable, total: results.length };
}

export async function probeSite({ fetchImpl = fetch } = {}) {
  return judgeSite(
    await Promise.all(SITE_PROBES.map((probe) => probeOne(probe, fetchImpl))),
  );
}

// ─────────────────────────────────────────────────────────────────
// 인프라 프로브 — "작동여부만" 본다.
// 본문은 받지 않거나(HEAD) 즉시 취소해서 바이트를 안 끌어온다.
// 실측(2026-07-25): 워커 53B/0.2s · D1 1행 260B/0.7s · 카페24 0B/0.05s · R2 0B/0.3s
// ─────────────────────────────────────────────────────────────────
// 카페24는 합성 프로브로 찌르지 않는다 — 알고 싶은 건 "서버가 켜져 있나"가 아니라
// "접수 데이터가 실제로 들어갔나"다. 그건 워커가 전송 결과를 기록해두고
// 하트비트 응답으로 최근 24시간 집계를 돌려준다(runPoll 의 crm 라인).
const DEFAULT_WORKER_BASE = "https://noblehong-api.noblehong0.workers.dev";

export function buildInfraProbes(env = process.env) {
  const worker = String(env.WORKER_BASE_URL || DEFAULT_WORKER_BASE).replace(
    /\/+$/,
    "",
  );
  const probes = [
    { name: "워커 API", url: `${worker}/api/health`, expect: 200, critical: true },
    {
      // 접수 저장소가 D1이라 읽기가 죽으면 쓰기도 의심해야 한다. 1행만 조회.
      name: "D1 읽기",
      url: `${worker}/api/content?module=press&limit=1`,
      expect: 200,
      critical: true,
    },
  ];
  const r2 = String(env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  const r2Key = String(env.R2_PROBE_KEY || "media/stats/stats_v1.mp4");
  if (r2) {
    // 자산은 접수에 직결되지 않으므로 실패해도 경고까지만
    probes.push({
      name: "R2 자산",
      url: `${r2}/${r2Key}`,
      method: "HEAD",
      expect: 200,
      critical: false,
    });
  }
  return probes;
}

// ─────────────────────────────────────────────────────────────────
// 미등록 활성폼 감지 — 조용한 전량 유실을 막는 유일한 수단.
//
// 조회 대상은 META_LEAD_FORM_IDS 정적 목록이다. 새 리드폼을 만들고 여기 추가를 잊으면
// 그 폼 리드는 전량 유실되는데, 폴러는 멀쩡히 살아있으니 리포트엔 "신규 없음"만 찍힌다.
// 정지보다 위험하다 — 정지는 최소한 실패 알림이라도 뜬다.
//
// 발견해도 조회 대상에 자동 추가하지 않는다. 모르는 폼을 말없이 접수하는 게 더 위험하다.
// 알림만 내고 사람이 META_LEAD_FORM_IDS 에 넣게 한다.
// ─────────────────────────────────────────────────────────────────
// 기록이 없으면(첫 실행·상태파일 초기화) 즉시 확인한다 — 모르는 채로 넘어가지 않는다
export function isFormCheckDue({ lastCheckAt, nowMs, intervalMs }) {
  const last = Date.parse(String(lastCheckAt || ""));
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= intervalMs;
}

export function judgeForms(configuredIds, activeForms) {
  const known = new Set(configuredIds.map(String));
  const missing = (activeForms || []).filter((f) => !known.has(String(f.id)));
  // 이미 리드가 쌓인 폼이 빠져 있으면 유실이 확정된 것 → 접수 직결로 올린다
  const withLeads = missing.filter((f) => Number(f.leadsCount) > 0);
  return {
    name: "폼 등록",
    ok: missing.length === 0,
    critical: withLeads.length > 0,
    info: missing.length
      ? `미등록 활성폼 ${missing.length}개: ` +
        missing
          .map((f) => `${f.name || "?"}(${f.id}, 리드 ${f.leadsCount ?? "?"})`)
          .join(" · ")
      : `등록 ${known.size}개 = 활성 ${activeForms.length}개`,
    missing,
  };
}

// 페이지 목록 → 페이지별 리드폼. leadgen_forms 목록 조회는 페이지 토큰이 필요하다
// (시스템유저 토큰으로는 #190 "must be called with a Page Access Token").
export async function fetchActiveForms({
  token,
  graphVersion,
  appSecret,
  fetchImpl = fetch,
}) {
  const proofQS = () => {
    const proof = appSecretProof(token, appSecret);
    return proof ? `&appsecret_proof=${proof}` : "";
  };
  const accRes = await fetchImpl(
    `https://graph.facebook.com/${graphVersion}/me/accounts?fields=id,name,access_token&limit=100${proofQS()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const acc = await accRes.json();
  if (acc?.error)
    throw new Error(String(acc.error.message || "페이지 조회 실패").slice(0, 160));

  const forms = [];
  for (const page of acc?.data || []) {
    // 페이지 토큰은 로그·알림 어디에도 남기지 않는다
    const pageToken = String(page?.access_token || "");
    if (!pageToken) continue;
    const url =
      `https://graph.facebook.com/${graphVersion}/${page.id}/leadgen_forms` +
      `?fields=id,name,status,leads_count&limit=100&access_token=${encodeURIComponent(pageToken)}`;
    const res = await fetchImpl(url);
    const data = await res.json();
    if (data?.error) continue; // 페이지 하나 실패로 전체를 죽이지 않는다
    for (const f of data?.data || []) {
      if (String(f?.status).toUpperCase() !== "ACTIVE") continue;
      forms.push({
        id: String(f.id),
        name: String(f.name || ""),
        leadsCount: Number(f.leads_count) || 0,
        page: String(page.name || page.id),
      });
    }
  }
  return forms;
}

export async function probeInfra({ fetchImpl = fetch, env = process.env } = {}) {
  return Promise.all(
    buildInfraProbes(env).map(async (p) => {
      try {
        const res = await fetchImpl(p.url, {
          method: p.method || "GET",
          headers: p.headers,
          redirect: "manual",
        });
        // 본문은 안 읽고 즉시 버린다 — 소켓만 정리하고 바이트는 끌어오지 않는다
        if (res.body) await res.body.cancel().catch(() => {});
        return {
          name: p.name,
          ok: p.anyResponse ? true : res.status === p.expect,
          got: String(res.status),
          critical: p.critical,
        };
      } catch (error) {
        return {
          name: p.name,
          ok: false,
          got: "ERR:" + String(error?.message || error).slice(0, 50),
          critical: p.critical,
        };
      }
    }),
  );
}

// ─────────────────────────────────────────────────────────────────
// 아이맥 자체 상태 — 폴러가 도는 바닥이 멀쩡한지.
// 전부 로컬 명령 한 줄씩이라 비용은 사실상 0.
// 디스크가 차거나 절전으로 잠들면 폴러가 멈추므로 사후가 아니라 예측 지표다.
// ─────────────────────────────────────────────────────────────────
export function parseDiskUsedPercent(dfOutput) {
  // df -k / 의 2번째 줄에서 "62%" 형태를 집는다
  const line = String(dfOutput || "").split(/\r?\n/)[1] || "";
  const m = line.match(/(\d{1,3})%/);
  return m ? Number(m[1]) : null;
}

export function parsePmsetSleep(pmsetOutput) {
  // "sleep  0 (imposed by ...)" → 0 이면 잠들지 않음
  const m = String(pmsetOutput || "").match(/^\s*sleep\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

export function parseLaunchctlLabels(listOutput, labels) {
  // launchctl list 출력: "PID\tStatus\tLabel" (PID 가 '-' 면 대기중, 정상)
  const rows = new Map();
  for (const line of String(listOutput || "").split(/\r?\n/)) {
    const cols = line.split(/\t+/);
    if (cols.length >= 3) rows.set(cols[2].trim(), cols[1].trim());
  }
  return labels.map((label) => ({
    label,
    loaded: rows.has(label),
    // 마지막 종료코드. 0 아니면 최근 실행이 실패했다는 뜻
    lastExit: rows.has(label) ? rows.get(label) : null,
  }));
}

export function judgeSystem(sys) {
  const checks = [];
  if (sys.diskUsedPercent != null) {
    checks.push({
      name: "디스크",
      // 가득 차면 상태파일·로그 쓰기가 실패해 폴러가 죽는다 → 접수 직결
      ok: sys.diskUsedPercent < 90,
      info: `${sys.diskUsedPercent}% 사용`,
      critical: true,
    });
  }
  if (sys.memFreePercent != null) {
    checks.push({
      name: "메모리",
      ok: sys.memFreePercent >= 5,
      info: `여유 ${sys.memFreePercent}%`,
      critical: false,
    });
  }
  if (sys.sleep != null) {
    checks.push({
      name: "절전",
      // 잠들면 launchd 주기 실행이 멈춘다 (깨어날 때 1회만 몰아서 실행)
      ok: sys.sleep === 0,
      info: sys.sleep === 0 ? "off" : `${sys.sleep}분 후 sleep`,
      critical: false,
    });
  }
  for (const w of sys.watched || []) {
    checks.push({
      name: `폴러 ${w.label.replace(/^com\./, "").replace(/\.meta-lead-poller$/, "")}`,
      ok: w.loaded && (w.lastExit === "-" || w.lastExit === "0"),
      info: w.loaded ? `exit ${w.lastExit}` : "미등록",
      critical: false,
    });
  }
  return checks;
}

async function collectSystem() {
  const { execFile } = await import("node:child_process");
  const os = await import("node:os");
  const run = (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000 }, (err, stdout) =>
        resolve(err ? "" : String(stdout)),
      );
    });
  const watchLabels = String(
    process.env.SYSTEM_WATCH_LABELS ||
      "com.noblehong.meta-lead-poller,com.polarad.meta-lead-poller,com.kefalab.meta-lead-poller",
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const [df, pmset, list] = await Promise.all([
    run("df", ["-k", "/"]),
    run("pmset", ["-g", "custom"]),
    run("launchctl", ["list"]),
  ]);
  return {
    diskUsedPercent: parseDiskUsedPercent(df),
    memFreePercent: Math.round((os.freemem() / os.totalmem()) * 100),
    uptimeDays: Math.floor(os.uptime() / 86400),
    sleep: parsePmsetSleep(pmset),
    watched: parseLaunchctlLabels(list, watchLabels),
  };
}

function formatKst(ms) {
  const shifted = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} KST`;
}

// 접수 + 사이트 + 인프라 + 아이맥을 한 메시지로 인프라봇에 보고한다.
// 전체 판정: 접수 직결(critical) 항목이 깨지면 🔴, 부가 항목만 깨지면 ⚠️.
export function overallStatus({ site, infra, system }) {
  const critical = [
    // 사이트는 HTTP 불일치만 확실한 장애로 본다.
    // fetch 자체 실패는 아이맥 네트워크 문제일 수 있어 경고까지만(오보 방지).
    ...(site ? site.failed.map(() => true) : []),
    ...(infra || []).filter((c) => !c.ok && c.critical).map(() => true),
    ...(system || []).filter((c) => !c.ok && c.critical).map(() => true),
  ];
  if (critical.length) return "fail";
  const warn =
    (site ? site.unreachable.length : 0) +
    (infra || []).filter((c) => !c.ok).length +
    (system || []).filter((c) => !c.ok).length;
  return warn ? "warn" : "ok";
}

const STATUS_HEAD = {
  ok: "🟢 정상",
  warn: "⚠️ 경고",
  fail: "🔴 장애",
};

export function formatReport({
  checkedAtMs,
  formCount,
  delivered,
  duplicates,
  skipped,
  site,
  infra,
  system,
  cafe24,
  status,
}) {
  const lines = [`[HEALTH] 노블홍 시스템체크 · ${STATUS_HEAD[status] || status}`];

  // 1) 접수
  const acc = [
    delivered > 0 ? `신규 ${delivered}건` : "신규 없음",
    duplicates > 0 ? `중복차단 ${duplicates}` : "",
    skipped > 0 ? `연락처없음 ${skipped}` : "",
  ].filter(Boolean);
  lines.push(`접수: ${acc.join(" · ")} (폼 ${formCount}개)`);

  // 2) 카페24 — 도달성이 아니라 "실제로 들어갔나"
  if (cafe24) {
    const pending = Math.max(0, cafe24.total - cafe24.ok - cafe24.fail);
    lines.push(
      `CRM 전송(${cafe24.hours}h): 성공 ${cafe24.ok}/${cafe24.total}` +
        (cafe24.fail ? ` · 실패 ${cafe24.fail}` : "") +
        (pending ? ` · 미기록 ${pending}` : ""),
    );
  }

  // 3) 사이트
  if (site) {
    const bad = site.failed.length + site.unreachable.length;
    lines.push(`사이트: ${site.total - bad}/${site.total}`);
    for (const r of [...site.failed, ...site.unreachable]) {
      lines.push(`  ✗ ${r.name}: 기대 ${r.expect} → ${r.got}`);
    }
  }

  // 4) 인프라
  if (infra?.length) {
    lines.push(
      `인프라: ${infra.map((c) => `${c.name} ${c.ok ? "✓" : "✗"}`).join(" · ")}`,
    );
    for (const c of infra.filter((x) => !x.ok)) {
      lines.push(`  ✗ ${c.name}: ${c.got ?? c.info ?? ""}`);
    }
  }

  // 5) 아이맥
  if (system?.length) {
    lines.push(
      `아이맥: ${system.map((c) => `${c.name} ${c.info}${c.ok ? "" : " ✗"}`).join(" · ")}`,
    );
  }

  lines.push(`체크: ${formatKst(checkedAtMs)}`);
  return lines.join("\n");
}

export function formatHealthCheckFailureMessage(error, checkedAtMs) {
  const reason = String(error?.message || error || "unknown").slice(0, 240);
  return [
    "[HEALTH] 노블홍 Meta 접수체크",
    "🔴 실패 · 리드 수신이 멈췄을 수 있음",
    `사유: ${reason}`,
    `체크 시각: ${formatKst(checkedAtMs)}`,
  ].join("\n");
}

// 매 실행마다 보내면 하루 24통이라 채널이 무의미해진다.
// 신규/중복/스킵이 있었거나, 마지막 보고 후 quietHours 가 지났을 때만 보낸다.
export function shouldPingHealth({
  delivered,
  duplicates,
  skipped,
  lastHealthPingAtMs,
  nowMs,
  quietMs,
  always,
  statusChanged,
}) {
  if (always) return true;
  // 상태가 바뀐 순간은 무조건 보고 — 장애 발생도 복구도 놓치면 안 된다
  if (statusChanged) return true;
  if (delivered > 0 || duplicates > 0 || skipped > 0) return true;
  if (!Number.isFinite(lastHealthPingAtMs) || !lastHealthPingAtMs) return true;
  return nowMs - lastHealthPingAtMs >= quietMs;
}

export async function sendHealthCheck({
  botToken,
  chatId,
  message,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const description = String(
      data?.description || `HTTP ${response.status}`,
    ).slice(0, 160);
    throw new Error(`Telegram 헬스체크 전송 실패: ${description}`);
  }
}

export async function runPoll({ fetchImpl = fetch } = {}) {
  const dryRun = envFlag("META_LEAD_DRY_RUN");
  const token = envRequired("META_SYSTEM_USER_TOKEN");
  const formIds = parseFormIds(envRequired("META_LEAD_FORM_IDS"));
  if (formIds.length === 0)
    throw new Error("META_LEAD_FORM_IDS에 유효한 폼 ID가 없습니다.");
  const cutoverAt = envRequired("META_LEAD_CUTOVER_AT");
  const cutoverMs = parseRequiredTime("META_LEAD_CUTOVER_AT", cutoverAt);
  const webhookUrl = dryRun
    ? String(process.env.LEAD_WEBHOOK_URL || "").trim()
    : envRequired("LEAD_WEBHOOK_URL");
  const webhookSecret = dryRun ? "" : envRequired("LEAD_WEBHOOK_SECRET");
  const heartbeatUrl = dryRun
    ? ""
    : String(process.env.LEAD_HEARTBEAT_URL || "").trim();
  const healthBotToken = dryRun ? "" : envRequired("HEALTH_TELEGRAM_BOT_TOKEN");
  const healthChatId = dryRun ? "" : envRequired("HEALTH_TELEGRAM_CHAT_ID");
  const graphVersion = String(
    process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
  ).trim();
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  const lookbackMs =
    envNumber("META_LEAD_LOOKBACK_HOURS", DEFAULT_LOOKBACK_HOURS) * 3600000;
  const overlapMs =
    envNumber("META_LEAD_OVERLAP_HOURS", DEFAULT_OVERLAP_HOURS) * 3600000;
  const maxPages = envNumber("META_LEAD_MAX_PAGES", DEFAULT_MAX_PAGES);
  const quietMs =
    envNumber("META_LEAD_HEALTH_QUIET_HOURS", DEFAULT_HEALTH_QUIET_HOURS) *
    3600000;
  const healthAlways = envFlag("META_LEAD_HEALTH_ALWAYS");
  const statePath = resolve(
    process.env.META_LEAD_STATE_FILE || DEFAULT_STATE_FILE,
  );
  const lockPath = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  const lock = await acquireLock(lockPath);
  if (!lock) {
    console.log(`${TAG} skip reason=already-running`);
    return { fetched: 0, delivered: 0, duplicates: 0, skipped: true };
  }

  try {
    const state = await readState(statePath, cutoverAt);
    const highWatermarkMs = Date.parse(state.highWatermarkAt || "");
    const nowMs = Date.now();
    const sinceMs = computeSinceMs({
      nowMs,
      cutoverMs,
      highWatermarkMs: Number.isFinite(highWatermarkMs) ? highWatermarkMs : 0,
      lookbackMs,
      overlapMs,
    });
    const allLeads = [];
    for (const formId of formIds) {
      const leads = await fetchFormLeads({
        formId,
        token,
        appSecret,
        graphVersion,
        sinceMs,
        maxPages,
        fetchImpl,
      });
      allLeads.push(...leads);
    }

    // 폼 두 개가 같은 리드를 줄 일은 없지만, 페이징 경계 중복은 여기서 접는다
    const byId = new Map();
    for (const lead of allLeads) {
      const leadId = String(lead?.id || "").trim();
      const createdMs = Date.parse(String(lead?.created_time || ""));
      if (leadId && Number.isFinite(createdMs) && createdMs >= sinceMs)
        byId.set(leadId, lead);
    }
    const leads = [...byId.values()].sort(
      (left, right) =>
        Date.parse(left.created_time) - Date.parse(right.created_time),
    );

    let delivered = 0;
    let duplicates = 0;
    let skipped = 0;
    let newestMs = Math.max(
      cutoverMs,
      Number.isFinite(highWatermarkMs) ? highWatermarkMs : 0,
    );
    const processed = { ...state.processed };
    for (const lead of leads) {
      const payload = buildPayload(lead);
      const createdMs = Date.parse(payload.createdTime);
      newestMs = Math.max(newestMs, Number.isFinite(createdMs) ? createdMs : 0);
      if (processed[payload.leadId]) continue;
      if (!hasPhone(payload.fieldData)) {
        console.log(`${TAG} skip reason=no-phone lead=${payload.leadId}`);
        skipped += 1;
        processed[payload.leadId] =
          payload.createdTime || new Date().toISOString();
        continue;
      }
      if (dryRun) continue;
      const result = await postLead({
        webhookUrl,
        webhookSecret,
        payload,
        fetchImpl,
      });
      if (result?.duplicate) duplicates += 1;
      else delivered += 1;
      processed[payload.leadId] =
        payload.createdTime || new Date().toISOString();
    }

    // 시스템 헬스체크 — 리드 전달이 끝난 뒤에 돈다.
    // 여기서 터져도 리드 전달은 이미 끝났고, 폴링 자체를 실패시키지 않는다.
    // 전부 "작동여부만" 보는 수준(본문 미수신 · 로컬 명령 3개)이라 1초 남짓.
    let site = null;
    let infra = null;
    let system = null;
    let siteStatus = state.siteStatus || "";
    let siteSince = state.siteSince || "";
    // 폼 등록 판정은 6시간마다만 갱신하고 그 사이엔 직전 결과를 그대로 들고 간다
    let formsCheck = state.formsCheck || null;
    let lastFormCheckAt = state.lastFormCheckAt || "";
    if (!dryRun && !envFlag("META_LEAD_SKIP_SYSTEM_CHECK")) {
      const guard = async (label, fn) => {
        try {
          return await fn();
        } catch (error) {
          console.error(
            `${TAG} ${label}-error ${String(error?.message || error).slice(0, 200)}`,
          );
          return null;
        }
      };
      // 폼 목록 조회는 Meta Graph 왕복 2번이라 실측 ~1.9초 — 다른 체크 전부(0.4초)보다 비싸다.
      // 새 폼은 사람이 만드는 거라 시간 단위 감지가 필요 없어 기본 6시간 간격으로만 돌리고,
      // 사이 시간대엔 직전 결과를 재사용한다(안 그러면 판정이 깜빡여 복구 오보가 난다).
      const dueFormCheck = isFormCheckDue({
        lastCheckAt: state.lastFormCheckAt,
        nowMs,
        intervalMs:
          envNumber("META_LEAD_FORM_CHECK_HOURS", DEFAULT_FORM_CHECK_HOURS) *
          3600000,
      });

      const [siteR, infraR, systemR, formsR] = await Promise.all([
        guard("site-probe", () => probeSite({ fetchImpl })),
        guard("infra-probe", () => probeInfra({ fetchImpl })),
        guard("system-check", async () => judgeSystem(await collectSystem())),
        dueFormCheck
          ? guard("forms-check", async () =>
              judgeForms(
                formIds,
                await fetchActiveForms({
                  token,
                  graphVersion,
                  appSecret,
                  fetchImpl,
                }),
              ),
            )
          : Promise.resolve(null),
      ]);
      site = siteR;
      system = systemR;
      if (formsR) {
        formsCheck = formsR;
        lastFormCheckAt = new Date(nowMs).toISOString();
      }
      // 폼 등록 상태를 인프라 항목에 얹는다 — 별도 줄로 흩뜨리지 않고 한 리포트에 유지
      infra = formsCheck ? [...(infraR || []), formsCheck] : infraR;
    }

    let lastHealthPingAt = state.lastHealthPingAt || "";
    if (!dryRun) {
      const heartbeat = await postHeartbeat({
        url: heartbeatUrl,
        secret: webhookSecret,
        stats: {
          forms: formIds.length,
          fetched: leads.length,
          delivered,
          duplicates,
          skipped,
          site: site ? site.status : "",
        },
        fetchImpl,
      });

      const status = overallStatus({ site, infra, system });
      const statusChanged = Boolean(site || infra || system) && status !== siteStatus;
      const ping = shouldPingHealth({
        delivered,
        duplicates,
        skipped,
        lastHealthPingAtMs: Date.parse(lastHealthPingAt || ""),
        nowMs,
        quietMs,
        always: healthAlways,
        statusChanged,
      });
      if (ping) {
        await sendHealthCheck({
          botToken: healthBotToken,
          chatId: healthChatId,
          message: formatReport({
            checkedAtMs: nowMs,
            formCount: formIds.length,
            delivered,
            duplicates,
            skipped,
            site,
            infra,
            system,
            cafe24: heartbeat?.cafe24,
            status,
          }),
          fetchImpl,
        });
        lastHealthPingAt = new Date(nowMs).toISOString();
      }
      if (statusChanged) {
        siteSince = new Date(nowMs).toISOString();
        siteStatus = status;
      }

      // 상태 저장은 전달·알림이 끝난 뒤에. 중간에 죽으면 다음 실행이 같은 구간을 다시 훑고,
      // 중복은 워커 멱등키가 흡수한다.
      const retentionFloor = Math.max(
        cutoverMs,
        nowMs - Math.max(lookbackMs, overlapMs) * 2,
      );
      await writeState(statePath, {
        version: 1,
        cutoverAt,
        highWatermarkAt: new Date(Math.max(newestMs, nowMs)).toISOString(),
        lastSuccessfulPollAt: new Date(nowMs).toISOString(),
        lastHealthPingAt,
        siteStatus,
        siteSince,
        formsCheck,
        lastFormCheckAt,
        processed: pruneProcessed(processed, retentionFloor),
      });
    }

    console.log(
      `${TAG} ok dryRun=${dryRun} forms=${formIds.length} fetched=${leads.length} delivered=${delivered} duplicates=${duplicates} skipped=${skipped} site=${site ? site.status : "-"} since=${new Date(sinceMs).toISOString()}`,
    );
    return {
      fetched: leads.length,
      delivered,
      duplicates,
      skipped,
      site: site ? site.status : "",
    };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

// 폼 질문/필드키 + 최근 리드 field_data 이름 덤프 — 워커 매핑 검증용(전송 안 함).
export async function runInspect({ fetchImpl = fetch } = {}) {
  const token = envRequired("META_SYSTEM_USER_TOKEN");
  const formIds = parseFormIds(envRequired("META_LEAD_FORM_IDS"));
  const graphVersion = String(
    process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
  ).trim();
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  const proofFor = (url) => {
    const proof = appSecretProof(token, appSecret);
    if (proof) url.searchParams.set("appsecret_proof", proof);
  };
  for (const formId of formIds) {
    const formUrl = new URL(
      `https://graph.facebook.com/${graphVersion}/${formId}`,
    );
    formUrl.searchParams.set(
      "fields",
      "id,name,status,questions{key,label,type}",
    );
    proofFor(formUrl);
    const formRes = await fetchImpl(formUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const form = await formRes.json();
    console.log(`\n=== FORM ${formId} ===`);
    console.log(`name: ${form?.name || "?"} · status: ${form?.status || "?"}`);
    for (const q of form?.questions || []) {
      console.log(`  질문 key="${q.key}" label="${q.label}" type=${q.type}`);
    }
    const leadsUrl = new URL(
      `https://graph.facebook.com/${graphVersion}/${formId}/leads`,
    );
    leadsUrl.searchParams.set("fields", "id,created_time,platform,field_data");
    leadsUrl.searchParams.set("limit", "3");
    proofFor(leadsUrl);
    const leadsRes = await fetchImpl(leadsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const leadsData = await leadsRes.json();
    for (const lead of leadsData?.data || []) {
      const names = (lead.field_data || []).map((f) => f.name).join(" | ");
      console.log(
        `  리드 ${lead.id} platform=${lead.platform} field_data names: ${names}`,
      );
    }
    if (form?.error || leadsData?.error) {
      console.log(
        `  ERROR: ${JSON.stringify(form?.error || leadsData?.error).slice(0, 240)}`,
      );
    }
  }
}

// 시스템 헬스체크만 돌려 리포트를 화면에 찍는다 — Meta 조회도, 전송도, 알림도 없다.
// 배포 직후 "체크가 제대로 도나"를 텔레그램 오염 없이 확인하는 용도.
export async function runSelfCheck({ fetchImpl = fetch } = {}) {
  const t0 = Date.now();
  const formIds = parseFormIds(process.env.META_LEAD_FORM_IDS);
  const graphVersion = String(
    process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
  ).trim();
  const [site, infraBase, system, forms] = await Promise.all([
    probeSite({ fetchImpl }),
    probeInfra({ fetchImpl }),
    collectSystem().then(judgeSystem),
    // 토큰이 없으면(권한 점검 전) 폼 확인은 건너뛴다
    process.env.META_SYSTEM_USER_TOKEN
      ? fetchActiveForms({
          token: process.env.META_SYSTEM_USER_TOKEN,
          graphVersion,
          appSecret: String(process.env.META_APP_SECRET || "").trim(),
          fetchImpl,
        })
          .then((active) => judgeForms(formIds, active))
          .catch((e) => ({
            name: "폼 등록",
            ok: false,
            critical: false,
            info: `확인 실패: ${String(e?.message || e).slice(0, 80)}`,
          }))
      : Promise.resolve(null),
  ]);
  const infra = forms ? [...infraBase, forms] : infraBase;
  const status = overallStatus({ site, infra, system });
  console.log(
    formatReport({
      checkedAtMs: Date.now(),
      formCount: formIds.length,
      delivered: 0,
      duplicates: 0,
      skipped: 0,
      site,
      infra,
      system,
      cafe24: null, // 하트비트 왕복이 없으므로 CRM 집계는 생략
      status,
    }),
  );
  console.log(`\n(전송·알림 없음 · 소요 ${Date.now() - t0}ms)`);
  return { status, ms: Date.now() - t0 };
}

async function main() {
  try {
    if (process.argv.includes("--inspect")) {
      await runInspect();
      return;
    }
    if (process.argv.includes("--selfcheck")) {
      await runSelfCheck();
      return;
    }
    await runPoll();
  } catch (error) {
    console.error(
      `${TAG} error ${String(error?.message || error).slice(0, 500)}`,
    );
    // 실패는 조용히 넘기면 안 된다 — 토큰 만료·폼 삭제가 곧 접수 정지다
    if (!envFlag("META_LEAD_DRY_RUN") && !process.argv.includes("--inspect")) {
      const botToken = String(
        process.env.HEALTH_TELEGRAM_BOT_TOKEN || "",
      ).trim();
      const chatId = String(process.env.HEALTH_TELEGRAM_CHAT_ID || "").trim();
      if (botToken && chatId) {
        try {
          await sendHealthCheck({
            botToken,
            chatId,
            message: formatHealthCheckFailureMessage(error, Date.now()),
          });
        } catch (healthError) {
          console.error(
            `${TAG} health-error ${String(
              healthError?.message || healthError,
            ).slice(0, 300)}`,
          );
        }
      }
    }
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
