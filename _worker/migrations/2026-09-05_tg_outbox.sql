-- 텔레그램 미배달 알림 큐
--
-- 봇 토큰이 죽으면 접수는 D1·카페24까지 정상 처리되는데 알림만 조용히 사라졌다.
-- 실패한 알림을 여기 적재해 두고 크론(6시간)이 재발송한다 —
-- 토큰을 갈아끼우면 밀린 알림이 그때 자동으로 배달된다.
CREATE TABLE IF NOT EXISTS tg_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,              -- 접수 / 디버그 / 인프라 — 재발송 때 토큰을 복원하는 키
  chat_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  tries      INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_outbox_created ON tg_outbox(created_at);
