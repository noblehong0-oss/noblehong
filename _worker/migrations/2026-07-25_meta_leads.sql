-- Meta Lead Ads 폴러 전환 — 멱등키 + 폴러 하트비트
--
-- 폴러는 누락 복구를 위해 48시간 겹침 조회를 한다. 즉 같은 리드를 여러 번 가져온다.
-- 중복 방지 게이트가 없으면 중복 접수 + 중복 텔레그램 + 카페24 중복 INSERT가 확정적으로 난다.
--
-- consultations.id 는 'rec'+14자 포맷이고 어드민 update/delete 가 /^rec[a-zA-Z0-9]{14}$/ 로
-- 검증하므로(worker src/index.js), 다른 프로젝트처럼 id 자리에 'meta-<leadId>'를 박으면
-- 어드민에서 해당 리드를 수정·삭제할 수 없게 된다. 그래서 별도 테이블에 leadId 를 유니크로 잡는다.

CREATE TABLE IF NOT EXISTS meta_leads (
  lead_id         TEXT PRIMARY KEY,   -- Meta Graph lead id (멱등키)
  consultation_id TEXT,               -- 저장 성공 시 consultations.id 연결
  created_time    TEXT,               -- Meta 기준 리드 생성시각
  claimed_at      TEXT NOT NULL       -- 워커가 선점한 시각 (ISO 8601)
);

CREATE INDEX IF NOT EXISTS idx_meta_leads_claimed
  ON meta_leads(claimed_at DESC);

-- health_state — 2026-07-15 헬스체크 때 원격 D1에만 즉석으로 만들어져 리포에 정의가 없었다.
-- DB를 다시 만들면 헬스체크가 조용히 죽으므로 여기서 정본으로 남긴다.
-- id='site'        : 접수 경로 프로브 결과
-- id='meta_poller' : 아이맥 폴러 하트비트 (checked_at 노후 = 접수 정지 신호)
CREATE TABLE IF NOT EXISTS health_state (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  detail     TEXT,
  since      TEXT,
  checked_at TEXT
);
