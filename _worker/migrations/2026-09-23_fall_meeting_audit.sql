-- Fall meeting application diagnostics. IP and visit cookie stay in private D1.
ALTER TABLE consultations ADD COLUMN 접속국가 TEXT;
ALTER TABLE consultations ADD COLUMN 접속지역 TEXT;
ALTER TABLE consultations ADD COLUMN 접속도시 TEXT;
ALTER TABLE consultations ADD COLUMN 방문쿠키 TEXT;

CREATE TABLE IF NOT EXISTS fall_meeting_audit (
  id TEXT PRIMARY KEY,
  consultation_id TEXT,
  visit_id TEXT,
  ip TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  stage TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fall_audit_record_time
  ON fall_meeting_audit(consultation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fall_audit_time
  ON fall_meeting_audit(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_consultations_source_page
  ON consultations("출처", "제출일시" DESC, id DESC);
