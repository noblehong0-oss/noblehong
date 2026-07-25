// 노블홍 Meta 리드 폴러 — 단위 테스트
// 실행: node --test _worker/imac-meta-lead-poller/worker.test.mjs
// 네트워크·아이맥·Meta 계정 없이 순수 로직만 검증한다 (실제 리드 전송 없음).

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPayload,
  computeSinceMs,
  formatHealthCheckMessage,
  formatSiteAlert,
  hasPhone,
  judgeSite,
  parseFormIds,
  pruneProcessed,
  sanitizePagingUrl,
  shouldPingHealth,
} from "./worker.mjs";
import { mapMetaFieldData } from "../src/index.js";

// 2026-07-25 Graph 실측 — 두 폼의 질문 name 이 서로 다르다
const FORM_V2_FIELDS = [
  { name: "성별", values: ["남성"] },
  { name: "혼인여부", values: ["초혼"] },
  { name: "출생년도", values: ["1985"] },
  { name: "지역_(시군까지만입력)", values: ["서울 강남구"] },
  { name: "full_name", values: ["홍길동"] },
  { name: "phone_number", values: ["+821012345678"] },
];
const FORM_V1_FIELDS = [
  { name: "이름", values: ["김철수"] },
  { name: "전화번호", values: ["01098765432"] },
  { name: "성별", values: ["여성"] },
  { name: "혼인여부", values: ["재혼"] },
  { name: "지역", values: ["경기 성남시"] },
  { name: "출생년도", values: ["1979"] },
  { name: "지역_(시군까지만입력)", values: ["경기 성남시"] },
];

test("폼 ID 파싱 — 공백/중복/비숫자 제거", () => {
  assert.deepEqual(parseFormIds(" 123, 456 ,123, abc,"), ["123", "456"]);
  assert.deepEqual(parseFormIds(""), []);
});

test("since 는 cutover 이전으로 절대 내려가지 않는다", () => {
  const cutoverMs = Date.parse("2026-08-01T00:00:00Z");
  // 워터마크가 없을 때도 Make가 처리한 구간을 다시 긁으면 중복 접수가 난다
  const since = computeSinceMs({
    nowMs: Date.parse("2026-08-01T06:00:00Z"),
    cutoverMs,
    highWatermarkMs: 0,
    lookbackMs: 48 * 3600000,
    overlapMs: 48 * 3600000,
  });
  assert.equal(since, cutoverMs);
});

test("since 는 워터마크에서 겹침시간만큼 되감아 누락을 복구한다", () => {
  const cutoverMs = Date.parse("2026-08-01T00:00:00Z");
  const highWatermarkMs = Date.parse("2026-08-10T00:00:00Z");
  const since = computeSinceMs({
    nowMs: Date.parse("2026-08-10T01:00:00Z"),
    cutoverMs,
    highWatermarkMs,
    lookbackMs: 48 * 3600000,
    overlapMs: 48 * 3600000,
  });
  assert.equal(since, Date.parse("2026-08-08T00:00:00Z"));
});

test("페이징 URL 에서 access_token 을 제거한다", () => {
  const cleaned = sanitizePagingUrl(
    "https://graph.facebook.com/v22.0/1/leads?access_token=SECRET&after=abc",
  );
  assert.ok(!cleaned.includes("SECRET"));
  assert.ok(cleaned.includes("after=abc"));
});

test("연락처 필드 인식 — 두 폼 모두", () => {
  assert.equal(hasPhone(FORM_V2_FIELDS), true); // phone_number
  assert.equal(hasPhone(FORM_V1_FIELDS), true); // 전화번호
  assert.equal(hasPhone([{ name: "성별", values: ["남성"] }]), false);
});

test("payload 는 원본 field_data 와 platform 을 그대로 넘긴다", () => {
  const payload = buildPayload({
    id: "1319349266615099",
    created_time: "2026-07-25T00:36:36+0000",
    platform: "ig",
    ad_name: "260515_이미지2",
    field_data: FORM_V2_FIELDS,
  });
  assert.equal(payload.leadId, "1319349266615099");
  assert.equal(payload.platform, "ig");
  assert.equal(payload.adName, "260515_이미지2");
  assert.equal(payload.fieldData.length, 6);
  assert.deepEqual(payload.fieldData[4], {
    name: "full_name",
    values: ["홍길동"],
  });
});

test("오래된 processed 기록만 정리한다", () => {
  const floor = Date.parse("2026-08-05T00:00:00Z");
  const kept = pruneProcessed(
    {
      old: "2026-08-01T00:00:00Z",
      fresh: "2026-08-09T00:00:00Z",
      broken: "not-a-date",
    },
    floor,
  );
  assert.deepEqual(Object.keys(kept).sort(), ["broken", "fresh"]);
});

test("조용모드 — 변화 없으면 quiet 시간 전까지 안 보낸다", () => {
  const nowMs = Date.parse("2026-08-10T12:00:00Z");
  const quietMs = 6 * 3600000;
  const base = { delivered: 0, duplicates: 0, skipped: 0, nowMs, quietMs };
  // 1시간 전에 이미 보고함 → 스킵
  assert.equal(
    shouldPingHealth({
      ...base,
      lastHealthPingAtMs: nowMs - 3600000,
      always: false,
    }),
    false,
  );
  // 7시간 전 → 정기 생존신고
  assert.equal(
    shouldPingHealth({
      ...base,
      lastHealthPingAtMs: nowMs - 7 * 3600000,
      always: false,
    }),
    true,
  );
  // 신규 리드가 있으면 무조건 보고
  assert.equal(
    shouldPingHealth({
      ...base,
      delivered: 1,
      lastHealthPingAtMs: nowMs - 60000,
      always: false,
    }),
    true,
  );
  // ALWAYS=1 이면 항상 보고
  assert.equal(
    shouldPingHealth({
      ...base,
      lastHealthPingAtMs: nowMs - 60000,
      always: true,
    }),
    true,
  );
});

test("헬스 메시지에 신규 건수와 멱등 차단 건수가 드러난다", () => {
  const msg = formatHealthCheckMessage({
    checkedAtMs: Date.parse("2026-08-10T03:00:00Z"),
    formCount: 2,
    delivered: 2,
    duplicates: 3,
    skipped: 1,
  });
  assert.match(msg, /신규 2건 접수/);
  assert.match(msg, /서버 중복\(멱등 차단\): 3건/);
  assert.match(msg, /연락처 없음 스킵: 1건/);
  assert.match(msg, /2026-08-10 12:00 KST/); // UTC+9
});

// ── 사이트 접수경로 프로브 (워커 크론 → 아이맥으로 이관) ──────────
const P = (name, expect, got, reachable = true) => ({
  name,
  expect,
  got,
  ok: reachable && got === expect,
  reachable,
});

test("사이트 판정 — 전 항목 기대대로면 ok", () => {
  const j = judgeSite([P("홈", 200, 200), P("폼 간편(quick)", 400, 400)]);
  assert.equal(j.status, "ok");
  assert.equal(j.total, 2);
});

test("사이트 판정 — HTTP 불일치는 fail (7/14 클로버 사고 유형)", () => {
  // repo 루트가 _deploy 를 덮으면 /api/* 가 404 로 떨어진다
  const j = judgeSite([P("홈", 200, 200), P("폼 간편(quick)", 400, 404)]);
  assert.equal(j.status, "fail");
  assert.equal(j.failed.length, 1);
});

test("사이트 판정 — fetch 자체 실패는 degraded (오보 방지)", () => {
  // 아이맥 네트워크 문제일 수 있어 사이트 장애로 단정하지 않는다
  const j = judgeSite([P("홈", 200, "ERR:timeout", false)]);
  assert.equal(j.status, "degraded");
  assert.equal(j.unreachable.length, 1);
});

test("사이트 판정 — fail 이 degraded 보다 우선", () => {
  const j = judgeSite([
    P("홈", 200, 404),
    P("폼 간편(quick)", 400, "ERR:timeout", false),
  ]);
  assert.equal(j.status, "fail");
});

test("사이트 알림 — 장애 시 실패항목과 복구안내가 들어간다", () => {
  const msg = formatSiteAlert(
    judgeSite([P("홈", 200, 200), P("폼 간편(quick)", 400, 404)]),
    Date.parse("2026-08-10T03:00:00Z"),
    "",
  );
  assert.match(msg, /🔴 접수 장애 감지/);
  assert.match(msg, /폼 간편\(quick\): 기대 400 → 실제 404/);
  assert.match(msg, /정상 항목: 1\/2/);
  assert.match(msg, /vercel --prod 재배포/);
});

test("사이트 알림 — 복구 시 직전 이상 시작시각을 붙인다", () => {
  const msg = formatSiteAlert(
    judgeSite([P("홈", 200, 200)]),
    Date.parse("2026-08-10T03:00:00Z"),
    "2026-08-09T21:00:00.000Z",
    "fail",
  );
  assert.match(msg, /🟢 정상 복구/);
  assert.match(msg, /직전 이상 시작: 2026-08-09T21:00:00\.000Z/);
});

test("사이트 알림 — 첫 실행은 '복구'가 아니라 '감시 시작'", () => {
  const msg = formatSiteAlert(
    judgeSite([P("홈", 200, 200)]),
    Date.parse("2026-08-10T03:00:00Z"),
    "",
    "",
  );
  assert.match(msg, /🟢 접수경로 감시 시작/);
  assert.doesNotMatch(msg, /복구/);
});

test("정기 보고에 사이트 상태 한 줄이 들어간다", () => {
  const msg = formatHealthCheckMessage({
    checkedAtMs: Date.parse("2026-08-10T03:00:00Z"),
    formCount: 2,
    delivered: 0,
    duplicates: 0,
    skipped: 0,
    site: judgeSite([P("홈", 200, 200), P("폼 간편(quick)", 400, 404)]),
  });
  assert.match(msg, /사이트 접수경로: 🔴 장애 \(1\/2\)/);
});

// ── 워커 매핑 (실제 폼 질문 이름 기준) ────────────────────────────
test("워커 매핑 — V2 폼(full_name/phone_number)", () => {
  const g = mapMetaFieldData(FORM_V2_FIELDS);
  assert.equal(g.name, "홍길동");
  assert.equal(g.phone, "+821012345678");
  assert.equal(g.gender, "남성");
  assert.equal(g.marriage, "초혼");
  assert.equal(g.birthYear, "1985");
  assert.equal(g.region, "서울 강남구");
  assert.deepEqual(g.extras, []);
});

test("워커 매핑 — V1 폼(이름/전화번호, 지역 필드 2개)", () => {
  const g = mapMetaFieldData(FORM_V1_FIELDS);
  assert.equal(g.name, "김철수");
  assert.equal(g.phone, "01098765432");
  assert.equal(g.gender, "여성");
  assert.equal(g.marriage, "재혼");
  assert.equal(g.birthYear, "1979");
  // '지역_(시군까지만입력)' 이 우선순위상 먼저 잡히고, 남은 '지역' 은 extras 로 보존
  assert.equal(g.region, "경기 성남시");
  assert.deepEqual(g.extras, ["지역=경기 성남시"]);
});

test("워커 매핑 — 새 질문이 추가돼도 유실 없이 extras 로 보존", () => {
  const g = mapMetaFieldData([
    ...FORM_V2_FIELDS,
    { name: "직업", values: ["회사원"] },
    { name: "연소득", values: ["5000"] },
  ]);
  assert.equal(g.name, "홍길동");
  assert.deepEqual(g.extras, ["직업=회사원", "연소득=5000"]);
});

test("워커 매핑 — 빈 값은 채택하지 않고 부분일치로 폴백한다", () => {
  const g = mapMetaFieldData([
    { name: "full_name", values: [""] },
    { name: "고객성함", values: ["박영희"] },
    { name: "휴대폰번호", values: ["01011112222"] },
  ]);
  assert.equal(g.name, "박영희");
  assert.equal(g.phone, "01011112222");
});

test("워커 매핑 — field_data 가 없어도 안전하게 빈 값", () => {
  const g = mapMetaFieldData(undefined);
  assert.equal(g.name, "");
  assert.equal(g.phone, "");
  assert.deepEqual(g.extras, []);
});
