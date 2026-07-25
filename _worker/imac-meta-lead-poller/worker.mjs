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
export function hasPhone(fieldData) {
  return (fieldData || []).some((item) => {
    const n = String(item?.name || "")
      .trim()
      .toLowerCase();
    return (
      n === "phone_number" ||
      n.includes("phone") ||
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
    return { ok: response.ok, status: response.status };
  } catch (error) {
    // 하트비트 실패로 폴링 자체를 실패 처리하지 않는다 — 리드 전달이 우선
    return { ok: false, error: String(error?.message || error).slice(0, 120) };
  }
}

function formatKst(ms) {
  const shifted = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)} KST`;
}

export function formatHealthCheckMessage({
  checkedAtMs,
  formCount,
  delivered,
  duplicates,
  skipped,
}) {
  const status =
    delivered > 0 ? `정상 · 신규 ${delivered}건 접수` : "정상 · 신규 없음";
  return [
    "[HEALTH] 노블홍 Meta 접수체크",
    status,
    duplicates > 0 ? `서버 중복(멱등 차단): ${duplicates}건` : "",
    skipped > 0 ? `연락처 없음 스킵: ${skipped}건` : "",
    `조회 폼: ${formCount}개`,
    `체크 시각: ${formatKst(checkedAtMs)}`,
  ]
    .filter(Boolean)
    .join("\n");
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
}) {
  if (always) return true;
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

    let lastHealthPingAt = state.lastHealthPingAt || "";
    if (!dryRun) {
      await postHeartbeat({
        url: heartbeatUrl,
        secret: webhookSecret,
        stats: {
          forms: formIds.length,
          fetched: leads.length,
          delivered,
          duplicates,
          skipped,
        },
        fetchImpl,
      });

      const ping = shouldPingHealth({
        delivered,
        duplicates,
        skipped,
        lastHealthPingAtMs: Date.parse(lastHealthPingAt || ""),
        nowMs,
        quietMs,
        always: healthAlways,
      });
      if (ping) {
        await sendHealthCheck({
          botToken: healthBotToken,
          chatId: healthChatId,
          message: formatHealthCheckMessage({
            checkedAtMs: nowMs,
            formCount: formIds.length,
            delivered,
            duplicates,
            skipped,
          }),
          fetchImpl,
        });
        lastHealthPingAt = new Date(nowMs).toISOString();
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
        processed: pruneProcessed(processed, retentionFloor),
      });
    }

    console.log(
      `${TAG} ok dryRun=${dryRun} forms=${formIds.length} fetched=${leads.length} delivered=${delivered} duplicates=${duplicates} skipped=${skipped} since=${new Date(sinceMs).toISOString()}`,
    );
    return { fetched: leads.length, delivered, duplicates, skipped };
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

async function main() {
  try {
    if (process.argv.includes("--inspect")) {
      await runInspect();
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
