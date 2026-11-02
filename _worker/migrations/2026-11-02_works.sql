-- 업무관리: 폴라애드가 진행한 작업과 결과를 날짜별로 남기고 노블홍이 의견을 단다 (2026-11-02)
-- 목록은 한 달 단위(work_date 범위)로만 읽고, 의견은 업무별(work_id)로 읽는다.
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  work_date TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  result TEXT,
  body TEXT,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_works_date ON works (work_date, created_at);

CREATE TABLE IF NOT EXISTS work_comments (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_comments_work ON work_comments (work_id, created_at);
