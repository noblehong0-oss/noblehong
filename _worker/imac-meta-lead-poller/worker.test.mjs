// 노블홍 Meta 리드 폴러 — 단위 테스트
// 실행: node --test _worker/imac-meta-lead-poller/worker.test.mjs
// 네트워크·아이맥·Meta 계정 없이 순수 로직만 검증한다 (실제 리드 전송 없음).

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInfraProbes,
  buildPayload,
  computeSinceMs,
  formatReport,
  hasPhone,
  isFormCheckDue,
  judgeForms,
  judgeSite,
  judgeSystem,
  overallStatus,
  parseDiskUsedPercent,
  parseFormIds,
  parseLaunchctlLabels,
  parsePmsetSleep,
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

test("폴러/워커 전화 인식 범위 동일 — 어긋나면 리드가 영구 유실된다", () => {
  // 폴러가 워커보다 좁으면: 워커는 읽을 수 있는 리드를 폴러가 먼저 스킵하고,
  // 스킵은 processed 에 처리완료로 남아 다시 안 가져온다(조회창 48시간).
  // 폴러가 넓으면: 워커가 400 → 매시간 재시도 실패 알림.
  // 어느 쪽이든 사고이므로 두 판정이 항상 같아야 한다.
  const names = [
    "phone_number",
    "전화번호",
    "연락처",
    "휴대폰번호",
    "핸드폰번호",
    "휴대전화",
    "mobile",
    "Mobile Number",
    "cellphone",
    "phone",
    "성별",
    "혼인여부",
    "출생년도",
    "지역_(시군까지만입력)",
    "full_name",
    "이름",
    "직업",
  ];
  for (const name of names) {
    const poller = hasPhone([{ name, values: ["01012345678"] }]);
    const worker =
      mapMetaFieldData([{ name, values: ["01012345678"] }]).phone !== "";
    assert.equal(
      poller,
      worker,
      `"${name}" — 폴러=${poller} 워커=${worker} (범위 불일치)`,
    );
  }
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

test("리포트 — 신규 없음/스킵도 그대로 드러난다", () => {
  const msg = formatReport({
    checkedAtMs: Date.parse("2026-08-10T03:00:00Z"),
    formCount: 2,
    delivered: 0,
    duplicates: 0,
    skipped: 1,
    status: "ok",
  });
  assert.match(msg, /접수: 신규 없음 · 연락처없음 1 \(폼 2개\)/);
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

// ── 인프라 프로브 ─────────────────────────────────────────────────
test("인프라 프로브 — 카페24 합성 프로브는 만들지 않는다", () => {
  // 알고 싶은 건 "서버가 켜져 있나"가 아니라 "데이터가 실제로 들어갔나".
  // 후자는 워커가 전송결과를 기록해뒀다가 하트비트 응답으로 준다.
  const probes = buildInfraProbes({ R2_PUBLIC_URL: "https://r2.example" });
  assert.deepEqual(
    probes.map((p) => p.name),
    ["워커 API", "D1 읽기", "R2 자산"],
  );
  assert.equal(
    probes.filter((p) => p.critical).length,
    2, // 워커·D1은 접수 직결, R2 자산은 아님
  );
});

test("인프라 프로브 — R2 미설정이면 해당 프로브를 뺀다", () => {
  const probes = buildInfraProbes({});
  assert.deepEqual(
    probes.map((p) => p.name),
    ["워커 API", "D1 읽기"],
  );
});

// ── 미등록 활성폼 감지 ────────────────────────────────────────────
const F = (id, name, leadsCount) => ({ id, name, leadsCount, page: "노블홍" });

test("폼 확인 주기 — Graph 왕복 2번(~1.9s)이라 6시간마다만 돈다", () => {
  const nowMs = Date.parse("2026-08-10T12:00:00Z");
  const intervalMs = 6 * 3600000;
  // 기록 없음(첫 실행·상태파일 초기화) → 즉시 확인
  assert.equal(isFormCheckDue({ lastCheckAt: "", nowMs, intervalMs }), true);
  assert.equal(
    isFormCheckDue({ lastCheckAt: "깨진값", nowMs, intervalMs }),
    true,
  );
  // 1시간 전에 확인함 → 건너뜀 (직전 결과 재사용)
  assert.equal(
    isFormCheckDue({
      lastCheckAt: "2026-08-10T11:00:00.000Z",
      nowMs,
      intervalMs,
    }),
    false,
  );
  // 6시간 경과 → 재확인
  assert.equal(
    isFormCheckDue({
      lastCheckAt: "2026-08-10T06:00:00.000Z",
      nowMs,
      intervalMs,
    }),
    true,
  );
});

test("폼 등록 — 활성폼이 전부 등록돼 있으면 ok", () => {
  const j = judgeForms(
    ["1304445771796402", "1658915391822063"],
    [F("1304445771796402", "V2", 120), F("1658915391822063", "V1", 7)],
  );
  assert.equal(j.ok, true);
  assert.equal(j.critical, false);
  assert.match(j.info, /등록 2개 = 활성 2개/);
});

test("폼 등록 — 미등록 활성폼에 리드가 있으면 접수 직결(critical)", () => {
  // 조용한 전량 유실이 이미 진행 중인 상태
  const j = judgeForms(
    ["1304445771796402"],
    [F("1304445771796402", "V2", 120), F("9999", "신규 접수양식", 5)],
  );
  assert.equal(j.ok, false);
  assert.equal(j.critical, true);
  assert.match(j.info, /미등록 활성폼 1개: 신규 접수양식\(9999, 리드 5\)/);
});

test("폼 등록 — 아직 리드 0건이면 경고까지만", () => {
  // 방금 만든 폼일 수 있다. 유실이 확정된 건 아니라 🔴까지 올리지 않는다
  const j = judgeForms(
    ["1304445771796402"],
    [F("1304445771796402", "V2", 120), F("9999", "신규 접수양식", 0)],
  );
  assert.equal(j.ok, false);
  assert.equal(j.critical, false);
});

test("폼 등록 — 등록됐지만 비활성인 폼은 문제 삼지 않는다", () => {
  // fetchActiveForms 가 ACTIVE 만 넘기므로 목록에 없는 게 정상
  const j = judgeForms(["1304445771796402", "1658915391822063"], [
    F("1304445771796402", "V2", 120),
  ]);
  assert.equal(j.ok, true);
});

// ── 아이맥 시스템 파서 ────────────────────────────────────────────
test("df 출력에서 디스크 사용률을 뽑는다", () => {
  const df = `Filesystem 1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s5   971350180 601234567 350115613    64%    /`;
  assert.equal(parseDiskUsedPercent(df), 64);
  assert.equal(parseDiskUsedPercent(""), null);
});

test("pmset 출력에서 sleep 값을 뽑는다", () => {
  assert.equal(parsePmsetSleep(" standbydelayhigh 86400\n sleep  0\n hibernatemode 3"), 0);
  assert.equal(parsePmsetSleep(" sleep  30 (imposed by 501)"), 30);
  assert.equal(parsePmsetSleep("아무것도 없음"), null);
});

test("launchctl 출력에서 감시대상 라벨 상태를 뽑는다", () => {
  const out = [
    "PID\tStatus\tLabel",
    "-\t0\tcom.noblehong.meta-lead-poller",
    "-\t1\tcom.polarad.meta-lead-poller",
  ].join("\n");
  const rows = parseLaunchctlLabels(out, [
    "com.noblehong.meta-lead-poller",
    "com.polarad.meta-lead-poller",
    "com.kefalab.meta-lead-poller",
  ]);
  assert.deepEqual(rows[0], {
    label: "com.noblehong.meta-lead-poller",
    loaded: true,
    lastExit: "0",
  });
  assert.equal(rows[1].lastExit, "1"); // 최근 실행 실패
  assert.equal(rows[2].loaded, false); // 미등록
});

test("시스템 판정 — 디스크만 접수 직결(critical)", () => {
  const checks = judgeSystem({
    diskUsedPercent: 95,
    memFreePercent: 40,
    sleep: 0,
    watched: [],
  });
  const disk = checks.find((c) => c.name === "디스크");
  assert.equal(disk.ok, false);
  assert.equal(disk.critical, true);
  assert.equal(
    checks.filter((c) => c.critical).length,
    1,
  );
});

test("시스템 판정 — 절전 켜짐/폴러 미등록은 경고까지만", () => {
  const checks = judgeSystem({
    diskUsedPercent: 50,
    memFreePercent: 40,
    sleep: 30,
    watched: [{ label: "com.polarad.meta-lead-poller", loaded: false, lastExit: null }],
  });
  const sleep = checks.find((c) => c.name === "절전");
  assert.equal(sleep.ok, false);
  assert.equal(sleep.critical, false);
  const poller = checks.find((c) => c.name.startsWith("폴러"));
  assert.equal(poller.ok, false);
  assert.equal(poller.critical, false);
});

// ── 통합 판정 / 리포트 ────────────────────────────────────────────
const OK_SITE = judgeSite([P("홈", 200, 200), P("폼 간편(quick)", 400, 400)]);

test("통합 판정 — 전부 정상이면 ok", () => {
  assert.equal(
    overallStatus({
      site: OK_SITE,
      infra: [{ name: "워커 API", ok: true, critical: true }],
      system: [{ name: "디스크", ok: true, critical: true }],
    }),
    "ok",
  );
});

test("통합 판정 — 접수 직결 항목이 깨지면 fail", () => {
  assert.equal(
    overallStatus({
      site: judgeSite([P("폼 간편(quick)", 400, 404)]),
      infra: [],
      system: [],
    }),
    "fail",
  );
  assert.equal(
    overallStatus({
      site: OK_SITE,
      infra: [{ name: "D1 읽기", ok: false, critical: true }],
      system: [],
    }),
    "fail",
  );
});

test("통합 판정 — 부가 항목만 깨지면 warn (R2·절전 등)", () => {
  assert.equal(
    overallStatus({
      site: OK_SITE,
      infra: [{ name: "R2 자산", ok: false, critical: false }],
      system: [],
    }),
    "warn",
  );
});

test("통합 판정 — fetch 자체 실패는 warn (아이맥 회선 문제일 수 있음)", () => {
  assert.equal(
    overallStatus({
      site: judgeSite([P("홈", 200, "ERR:timeout", false)]),
      infra: [],
      system: [],
    }),
    "warn",
  );
});

test("리포트 — 접수·CRM·사이트·인프라·아이맥이 한 메시지에 담긴다", () => {
  const msg = formatReport({
    checkedAtMs: Date.parse("2026-08-10T03:00:00Z"),
    formCount: 2,
    delivered: 2,
    duplicates: 1,
    skipped: 0,
    site: OK_SITE,
    infra: [
      { name: "워커 API", ok: true, got: "200", critical: true },
      { name: "R2 자산", ok: false, got: "404", critical: false },
    ],
    system: judgeSystem({
      diskUsedPercent: 64,
      memFreePercent: 41,
      sleep: 0,
      watched: [],
    }),
    cafe24: { hours: 24, total: 3, ok: 3, fail: 0 },
    status: "warn",
  });
  assert.match(msg, /⚠️ 경고/);
  assert.match(msg, /접수: 신규 2건 · 중복차단 1 \(폼 2개\)/);
  assert.match(msg, /CRM 전송\(24h\): 성공 3\/3/);
  assert.match(msg, /사이트: 2\/2/);
  assert.match(msg, /인프라: 워커 API ✓ · R2 자산 ✗/);
  assert.match(msg, /✗ R2 자산: 404/);
  assert.match(msg, /아이맥: 디스크 64% 사용 · 메모리 여유 41% · 절전 off/);
  assert.match(msg, /체크: 2026-08-10 12:00 KST/);
});

test("리포트 — CRM 전송 실패가 숫자로 드러난다", () => {
  const msg = formatReport({
    checkedAtMs: Date.parse("2026-08-10T03:00:00Z"),
    formCount: 2,
    delivered: 0,
    duplicates: 0,
    skipped: 0,
    cafe24: { hours: 24, total: 5, ok: 3, fail: 2 },
    status: "ok",
  });
  assert.match(msg, /CRM 전송\(24h\): 성공 3\/5 · 실패 2/);
});

test("상태가 바뀌면 조용모드여도 무조건 보고한다", () => {
  const nowMs = Date.parse("2026-08-10T12:00:00Z");
  assert.equal(
    shouldPingHealth({
      delivered: 0,
      duplicates: 0,
      skipped: 0,
      lastHealthPingAtMs: nowMs - 60000,
      nowMs,
      quietMs: 6 * 3600000,
      always: false,
      statusChanged: true,
    }),
    true,
  );
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
