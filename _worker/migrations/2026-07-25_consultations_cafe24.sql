-- 카페24 CRM 전송 결과 기록 컬럼
--
-- 지금까지 카페24 전송은 fire-and-forget 이라 실패해야만 디버그 채널에 흔적이 남고
-- 성공 여부는 아무 데도 안 남았다. "접수가 CRM까지 실제로 들어갔나"를
-- 시간당 리포트로 답하려면 결과를 기록해야 한다.
--
--   NULL          = 미시도 / 진행중
--   'ok'          = 전송 성공
--   'fail:<사유>' = 전송 실패
--
-- ⚠ ALTER TABLE ADD COLUMN 은 재실행하면 "duplicate column name" 으로 실패한다.
--   그래서 IF NOT EXISTS 로만 이뤄진 2026-07-25_meta_leads.sql 과 파일을 분리했다.
--   한 번만 실행할 것.

ALTER TABLE consultations ADD COLUMN cafe24 TEXT;
