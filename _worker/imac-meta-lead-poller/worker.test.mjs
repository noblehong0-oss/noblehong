// 노블홍 Meta 리드 폴러 — 단위 테스트
// 실행: node --test _worker/imac-meta-lead-poller/worker.test.mjs
// 네트워크·아이맥·Meta 계정 없이 순수 로직만 검증한다 (실제 리드 전송 없음).

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildInfraProbes,
  buildPayload,
  computeSinceMs,
  formatHealthCheckFailureMessage,
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
  postLead,
  pruneProcessed,
  pruneRetries,
  runPoll,
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
  assert.match(msg, /- <b>접수<\/b>  신규 없음 · 연락처없음 1 \(폼 2개\)/);
  assert.match(msg, /2026-08-10 12:00 KST/); // UTC+9
});

// 인프라봇 채널 공용 포맷 — 굵은 헤더 + 구분선 + `- <b>라벨</b>  값`
test("리포트 — 지정 알림 스타일(헤더·구분선·하이픈 라벨)을 지킨다", () => {
  const msg = formatReport({
    checkedAtMs: Date.parse("2026-08-10T03:00:00Z"),
    formCount: 2,
    delivered: 0,
    duplicates: 0,
    skipped: 0,
    status: "ok",
  });
  const lines = msg.split("\n");
  assert.equal(lines[0], "<b>[HEALTH] 노블홍 시스템체크</b> 🟢 정상");
  assert.equal(lines[1], "──────────────");
  for (const line of lines.slice(2)) {
    assert.match(line, /^- <b>[^<]+<\/b> {2}/);
  }
});

test("리포트 — 폼 이름의 꺾쇠는 이스케이프된다(HTML 파싱 깨짐 방지)", () => {
  const msg = formatReport({
    checkedAtMs: Date.parse("2026-08-10T03:00:00Z"),
    formCount: 1,
    delivered: 0,
    duplicates: 0,
    skipped: 0,
    infra: [{ name: "폼 등록", ok: false, info: "미등록 <신규폼> & 1개" }],
    status: "warn",
  });
  assert.match(msg, /미등록 &lt;신규폼&gt; &amp; 1개/);
  assert.equal(msg.includes("<신규폼>"), false);
});

test("실패 알림도 같은 스타일로 나간다", () => {
  const msg = formatHealthCheckFailureMessage(
    new Error("token expired"),
    Date.parse("2026-08-10T03:00:00Z"),
  );
  assert.match(msg, /^<b>\[HEALTH\] 노블홍 시스템체크<\/b> 🔴 실패\n──────────────\n/);
  assert.match(msg, /- <b>사유<\/b>  token expired/);
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
  assert.match(msg, /- <b>접수<\/b>  신규 2건 · 중복차단 1 \(폼 2개\)/);
  assert.match(msg, /- <b>CRM 전송\(24h\)<\/b>  성공 3\/3/);
  assert.match(msg, /- <b>사이트<\/b>  2\/2/);
  assert.match(msg, /- <b>인프라<\/b>  워커 API ✓ · R2 자산 ✗/);
  assert.match(msg, /✗ R2 자산: 404/);
  assert.match(
    msg,
    /- <b>아이맥<\/b>  디스크 64% 사용 · 메모리 여유 41% · 절전 off/,
  );
  assert.match(msg, /- <b>체크시각<\/b>  2026-08-10 12:00 KST/);
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
  assert.match(msg, /- <b>CRM 전송\(24h\)<\/b>  성공 3\/5 · 실패 2/);
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

// ─────────────────────────────────────────────────────────────────
// 접수 정지 회귀 방어 — 2026-09-04 실제 사고
//   미얀마 번호(+959795908242) 리드 1건이 워커에서 400(Invalid fields)을 받자
//   폴링 루프 전체가 예외로 중단됐다. 상태 저장까지 못 가서 워터마크가 멈췄고,
//   그래서 그 리드는 조회창을 벗어나지도 못해 매시간 같은 지점에서 다시 죽었다.
//   = 리드 1건이 이후 모든 접수를 영구히 막는 구조. 아래 테스트가 이 회귀를 잡는다.
// ─────────────────────────────────────────────────────────────────

function leadOf(id, createdTime, phone) {
  return {
    id,
    created_time: createdTime,
    platform: "ig",
    ad_name: "테스트광고",
    field_data: [
      { name: "full_name", values: ["홍길동"] },
      { name: "phone_number", values: [phone] },
    ],
  };
}

// 워커 응답을 리드별로 지정해 폴링 한 번을 통째로 돌린다.
async function runPollWith({ leads, workerReply, statePath }) {
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    const reply = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (target.includes("graph.facebook.com")) return reply(200, { data: leads });
    if (target.includes("/api/lead/meta/heartbeat")) return reply(200, { ok: true });
    if (target.includes("/api/lead/meta")) {
      const payload = JSON.parse(init.body);
      posted.push(payload.leadId);
      return workerReply(payload.leadId, reply);
    }
    if (target.includes("api.telegram.org")) return reply(200, { ok: true });
    return reply(200, {});
  };

  const env = {
    META_SYSTEM_USER_TOKEN: "t",
    META_LEAD_FORM_IDS: "1304445771796402",
    META_LEAD_CUTOVER_AT: "2026-09-01T00:00:00Z",
    LEAD_WEBHOOK_URL: "https://example.test/api/lead/meta",
    LEAD_HEARTBEAT_URL: "https://example.test/api/lead/meta/heartbeat",
    LEAD_WEBHOOK_SECRET: "s",
    HEALTH_TELEGRAM_BOT_TOKEN: "b",
    HEALTH_TELEGRAM_CHAT_ID: "c",
    META_LEAD_STATE_FILE: statePath,
    META_LEAD_SKIP_SYSTEM_CHECK: "1",
  };
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  let result = null;
  let error = null;
  try {
    result = await runPoll({ fetchImpl });
  } catch (caught) {
    error = caught;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const raw = await readFile(statePath, "utf8").catch(() => "null");
  return { posted, result, error, state: JSON.parse(raw) };
}

test("접수 정지 회귀 — 400 리드 1건이 뒤 리드를 막지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nh-poll-"));
  const statePath = join(dir, "state.json");
  try {
    const { posted, result, error, state } = await runPollWith({
      statePath,
      leads: [
        leadOf("A1", "2026-09-04T01:00:00+0000", "+821012345678"),
        leadOf("B2", "2026-09-04T02:00:00+0000", "+959795908242"),
        leadOf("C3", "2026-09-04T03:00:00+0000", "+821098765432"),
      ],
      workerReply: (leadId, reply) =>
        leadId === "B2"
          ? reply(400, { error: "Invalid fields", fields: ["연락처"] })
          : reply(200, { ok: true, id: `rec${leadId}` }),
    });
    assert.equal(error, null, "형식 거절 1건으로 폴링 전체가 죽으면 안 된다");
    // 거절된 B2 뒤의 C3 까지 반드시 전달돼야 한다 (head-of-line blocking 방지)
    assert.deepEqual(posted, ["A1", "B2", "C3"]);
    assert.equal(result.delivered, 2);
    assert.equal(result.rejected, 1);
    // 세 건 모두 처리완료로 남아 다음 폴링에서 같은 400 을 반복하지 않는다
    assert.deepEqual(Object.keys(state.processed).sort(), ["A1", "B2", "C3"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("접수 정지 회귀 — 5xx 는 재시도하고 한도를 넘으면 격리 후 재개한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nh-poll-"));
  const statePath = join(dir, "state.json");
  try {
    const options = {
      statePath,
      leads: [
        leadOf("X1", "2026-09-04T01:00:00+0000", "+821012345678"),
        leadOf("Y2", "2026-09-04T02:00:00+0000", "+821011112222"),
      ],
      workerReply: (leadId, reply) =>
        leadId === "X1"
          ? reply(500, { error: "boom" })
          : reply(200, { ok: true, id: "recY2" }),
    };
    // 1·2회차: 재시도 구간이라 멈춘다. 멈춰도 재시도 횟수는 반드시 저장돼야 한다.
    for (const expected of [1, 2]) {
      const { error, state } = await runPollWith(options);
      assert.ok(error, "일시 장애는 그대로 알려야 한다");
      assert.equal(
        state.retries.X1,
        expected,
        "재시도 횟수가 저장되지 않으면 자동 복구가 시작되지 않는다",
      );
      assert.equal(state.processed.Y2, undefined, "뒤 리드는 아직 전달되면 안 된다");
    }
    // 3회차: 한도에 도달해 X1 을 격리하고 Y2 를 전달하여 큐가 스스로 풀린다
    const { error, result, state } = await runPollWith(options);
    assert.equal(error, null, "한도에 도달한 뒤에는 스스로 복구돼야 한다");
    assert.equal(result.quarantined, 1);
    assert.equal(result.delivered, 1);
    assert.ok(state.processed.Y2, "격리한 뒤에는 뒤 리드가 전달돼야 한다");
    assert.equal(state.retries.X1, undefined, "격리한 리드의 재시도 기록은 정리한다");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("접수 정지 회귀 — 시크릿 오류(401)는 격리하지 않고 멈춘다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nh-poll-"));
  const statePath = join(dir, "state.json");
  try {
    const options = {
      statePath,
      leads: [leadOf("Z1", "2026-09-04T01:00:00+0000", "+821012345678")],
      workerReply: (_leadId, reply) => reply(401, { error: "Unauthorized" }),
    };
    for (let i = 0; i < 4; i += 1) {
      const { error, state } = await runPollWith(options);
      assert.ok(error, "시크릿 불일치는 사람이 볼 때까지 알려야 한다");
      // 전 리드 공통 장애라 재시도로 소진시키면 멀쩡한 리드까지 유실된다
      assert.equal(state.retries.Z1, undefined);
      assert.equal(
        state.processed.Z1,
        undefined,
        "전달하지 못한 리드를 처리완료로 지우면 유실이다",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("접수 정지 회귀 — 중단하면 워터마크를 미전달 리드 앞에 묶는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nh-poll-"));
  const statePath = join(dir, "state.json");
  try {
    const { state } = await runPollWith({
      statePath,
      leads: [
        leadOf("P1", "2026-09-04T01:00:00+0000", "+821012345678"),
        leadOf("Q2", "2026-09-04T02:00:00+0000", "+821011112222"),
      ],
      workerReply: (leadId, reply) =>
        leadId === "Q2"
          ? reply(500, { error: "boom" })
          : reply(200, { ok: true, id: "recP1" }),
    });
    // 워터마크가 Q2 를 넘어가면 다음 조회 구간에서 빠져 영구 유실된다
    assert.ok(
      Date.parse(state.highWatermarkAt) < Date.parse("2026-09-04T02:00:00Z"),
      `워터마크가 미전달 리드를 넘었다: ${state.highWatermarkAt}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("전달 실패 분류 — 400/415 만 재시도가 무의미한 형식 거절이다", async () => {
  const call = async (status, body) => {
    try {
      await postLead({
        webhookUrl: "https://example.test/api/lead/meta",
        webhookSecret: "s",
        payload: { leadId: "L1" },
        fetchImpl: async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      });
      return null;
    } catch (error) {
      return error;
    }
  };
  const invalid = await call(400, { error: "Invalid fields", fields: ["연락처"] });
  assert.equal(invalid.permanent, true);
  assert.equal(invalid.fatal, false);
  assert.match(invalid.reason, /연락처/);

  assert.equal((await call(415, { error: "json required" })).permanent, true);
  // 아래 셋은 리드 내용과 무관하다 — 재시도로 소진시키면 멀쩡한 리드가 유실된다
  for (const status of [401, 403, 429]) {
    const error = await call(status, { error: "nope" });
    assert.equal(error.permanent, false, `${status} 를 형식 거절로 보면 안 된다`);
    assert.equal(error.fatal, true);
  }
  const boom = await call(500, { error: "boom" });
  assert.equal(boom.permanent, false);
  assert.equal(boom.fatal, false);
});

test("처리가 끝난 리드의 재시도 기록은 정리한다", () => {
  const kept = pruneRetries({ A: 2, B: 1 }, { B: "2026-09-04T00:00:00Z" });
  assert.deepEqual(kept, { A: 2 });
});
