# 노블홍 — 아이맥 Meta 리드 폴러

Meta 잠재고객 광고(리드폼) 접수를 **Make.com 웹훅 대신 아이맥에서 1시간마다 폴링**해
워커 `/api/lead/meta` 로 전달한다. bas·자수성가·폴라애드와 같은 패턴.

## 왜 폴링인가

- Make 시나리오가 끊기면 Meta 접수가 통째로 멈춘다. 실측상 노블홍은 **최근 30일 접수 69건 중
  69건이 Meta** — 자체 폼은 사실상 0이라 Make가 단일 장애점이었다.
- Meta는 한 번 놓친 리드를 재발사하지 않는다. 폴링은 48시간 겹침 조회로 스스로 복구한다.
- Graph가 `platform`(ig/fb)을 직접 준다. Make 경로에서 유실되던 플랫폼 분류가 자동 복구된다.

## 구성

| 위치 | 내용 |
| --- | --- |
| 로컬(이 폴더) | 원본 소스 + 배포 스크립트 |
| 아이맥 `/Users/pola/noblehong-meta-lead-poller/` | `worker.mjs`, `.env`, `state.json`, `logs/` |
| 아이맥 LaunchAgent | `com.noblehong.meta-lead-poller` · `StartInterval` 3600초 |
| 워커 | `/api/lead/meta` (리드 수신) · `/api/lead/meta/heartbeat` (생존 신고) |
| 인프라봇 | `@bas263thBot` → 채널 `-1004487628453` |

## 중복 방지 (핵심)

폴러는 누락 복구를 위해 **48시간 겹침 조회**를 한다. 즉 같은 리드를 여러 번 가져온다.
워커의 `meta_leads` 테이블이 `leadId` 를 유니크로 잡아 두 번째부터는
`{ ok: true, duplicate: true }` 만 돌려주고 D1·텔레그램·카페24 전부 스킵한다.

> `consultations.id` 는 `rec`+14자 포맷이고 어드민 수정/삭제가 그 정규식으로 검증하므로,
> 다른 프로젝트처럼 `id` 자리에 `meta-<leadId>` 를 박지 않고 별도 테이블을 썼다.

## 헬스체크 — 아이맥이 주역, 워커는 데드맨 스위치

**아이맥 폴러 (1시간)** — 리드 폴링과 시스템 헬스체크를 **같은 실행에서** 하고
**인프라봇에 한 메시지로** 보고한다. 총 비용 실측 **0.4초 / 수백 바이트** — "작동여부만" 보며
본문은 받지 않는다(HEAD 또는 즉시 취소).

```
[HEALTH] 노블홍 시스템체크 · 🟢 정상
접수: 신규 2건 · 중복차단 1 (폼 2개)
CRM 전송(24h): 성공 3/3
사이트: 6/6
인프라: 워커 API ✓ · D1 읽기 ✓ · R2 자산 ✓
아이맥: 디스크 64% 사용 · 메모리 여유 41% · 절전 off · 폴러 noblehong exit 0
체크: 2026-07-25 14:24 KST
```

| 구분 | 보는 것 | 접수 직결 |
| --- | --- | --- |
| 접수 | Meta 조회·전달·멱등차단·스킵 건수 | ✔ |
| CRM 전송 | **실제 전송 성공/실패 건수(최근 24h)**. 합성 프로브 아님 | ✔ |
| 사이트 | 폼 3종(빈 payload → 400 드라이런) + 홈·`inquiry-bars.js`·`/privacy` | ✔ |
| 인프라 | 워커 `/api/health` · D1 읽기 1행 · R2 자산 HEAD | 워커·D1만 |
| 아이맥 | 디스크·메모리·절전설정·launchd 폴러 상태 | 디스크만 |

- 사이트 프로브는 원래 워커 크론(6시간)이 하던 일인데 2026-07-25에 여기로 옮겼다 —
  아이맥은 진짜 외부 시점이라 CF→Vercel→CF 자기호출보다 실제 고객 경로에 가깝고, 주기도 6배 촘촘하다.
- **카페24는 찌르지 않는다.** 알고 싶은 건 "서버가 켜져 있나"가 아니라 "데이터가 실제로 들어갔나"라,
  워커가 전송 결과를 `consultations.cafe24` 에 남기고 하트비트 응답으로 24시간 집계를 돌려준다.
- 판정: 접수 직결 항목이 깨지면 🔴, 부가 항목만 깨지면 ⚠️.
  fetch 자체 실패는 아이맥 회선 문제일 수 있어 ⚠️까지만(오보 방지).
- 보고 시점: **상태가 바뀐 순간** · 신규/중복/스킵이 있을 때 · 마지막 보고 후 6시간 경과.
  매시간 도배하지 않는다. 매 실행마다 받으려면 `META_LEAD_HEALTH_ALWAYS=1`,
  전체를 끄려면 `META_LEAD_SKIP_SYSTEM_CHECK=1`.
- 조회 실패(토큰 만료·폼 삭제·네트워크)는 즉시 🔴.
- `node worker.mjs --selfcheck` 로 **전송·알림 없이** 리포트만 화면에 찍어볼 수 있다.

**워커 크론 (6시간)** — 아이맥이 못 하는 것 하나만 본다: **자기 자신의 죽음**.
아이맥이 꺼지면 위 체크도 알림도 같이 멈추는데, 그 침묵은 "정상"과 구분되지 않는다.
하트비트가 3시간 넘게 안 찍히면 🔴 접수 정지로 판정한다.
(6시간 주기 → 아이맥 사망 감지는 최대 약 9시간. 더 빨리 알고 싶으면 크론을 `0 * * * *` 로)

즉 **사이트·접수 장애는 1시간 안에**, **아이맥 사망은 최대 9시간 안에** 잡힌다.

## 셋업

```bash
cp .env.example .env.imac.local     # 값 채우기 (git 제외됨)
node deploy.mjs                     # 드라이런 — 준비상태 점검
```

`.env.imac.local` 필수 값:

- `META_SYSTEM_USER_TOKEN` — 프로젝트 `.env` 와 동일. 시스템사용자 `pola`(앱 POLA-REPORT),
  무기한, `leads_retrieval` 보유. 접근 가능한 페이지는 `노블홍-noblehong` 1개
- `META_LEAD_FORM_IDS` — `1304445771796402`(V2, 현재 유입 전량) + `1658915391822063`(구버전)
- `META_LEAD_CUTOVER_AT` — **Make 시나리오를 끈 시각(ISO)**. 이 시각 이전은 절대 다시 안 긁는다
- `LEAD_WEBHOOK_SECRET` — 프로젝트 `.env` 의 `META_LEAD_SECRET` 과 동일값

## 전환 순서

```bash
# 1) D1 마이그레이션 — 순서 무관, 둘 다 Make 현흐름과 하위호환
npx wrangler d1 execute noblehong-db --file=../migrations/2026-07-25_meta_leads.sql --remote
npx wrangler d1 execute noblehong-db --file=../migrations/2026-07-25_consultations_cafe24.sql --remote
#   ⚠ 두 번째는 ALTER TABLE 이라 한 번만. 재실행하면 duplicate column 으로 실패한다.

# 2) 워커 배포 — Make 평면키와 하위호환이라 Make를 켠 채로 먼저 올려도 안전
cd .. && npx wrangler deploy

# 3) 권한 점검 (조회만, 전송·알림 없음)
META_LEAD_DRY_RUN=1 node worker.mjs
node worker.mjs --inspect          # 폼 질문 key 확인
node worker.mjs --selfcheck        # 시스템 헬스체크 리포트만 화면 출력

# 4) 설치 (폴링은 아직 시작 안 함)
node deploy.mjs --run
ssh imac '/usr/local/bin/node --env-file=~/noblehong-meta-lead-poller/.env \
  ~/noblehong-meta-lead-poller/worker.mjs --selfcheck'   # 아이맥에서 디스크/절전/launchd 값 확인

# 5) Make 시나리오 OFF → 그 시각을 META_LEAD_CUTOVER_AT 에 기록 → 재배포 + 기동
node deploy.mjs --run --start
```

## 운영

```bash
ssh imac 'tail -20 /Users/pola/noblehong-meta-lead-poller/logs/worker.log'
ssh imac 'cat /Users/pola/noblehong-meta-lead-poller/state.json'
ssh imac 'launchctl kickstart -k gui/501/com.noblehong.meta-lead-poller'   # 즉시 1회 실행
ssh imac 'launchctl bootout gui/501 ~/Library/LaunchAgents/com.noblehong.meta-lead-poller.plist'  # 중지
```

## 테스트

```bash
node --test worker.test.mjs   # 네트워크·아이맥 없이 순수 로직 14종
```

## 되돌리기

폴러를 `bootout` 하고 Make 시나리오를 다시 켜면 된다. 워커는 두 경로를 모두 받으므로
코드 롤백 없이 전환/복귀가 가능하다.
