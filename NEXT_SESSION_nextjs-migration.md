# 다음 세션: Next.js 전환 + CRM/API 구축

## 완료된 작업 (이번 세션)

### 매칭라운지 (wireframe_matchinglounge.html) — 완성

- 히어로 + 매칭전략연구소 + 미팅성공가이드 + 러브칼럼 + 노블레스파티6종 + 스페셜맞선
- 콘텐츠 피드 (블로그+인스타 혼합, Airtable+R2 설계)
- 유튜브 영상 갤러리: 147개 실제 videoId, 4x5=20개 기본 + 전체보기 확장
- Shorts: 18개 실제 ID, 좌우 슬라이드 방식, 세로비율
- 모달 재생 (일반영상 16:9, Shorts 9:16)
- 제목 미표시 (썸네일에 포함)

### 상담문의 (wireframe_contact.html) — 완성

- 히어로 (1800-8194 대형) + 상담방법 3가지 카드 (전화/온라인/방문)
- 온라인 상담 폼: 성별/혼인상태/출생년도/이름/이메일/휴대폰 + 약관동의 2개
- IP 수집: 클라이언트(ipify) + 서버(x-forwarded-for) 이중 수집
- 접수 원칙: 무조건 접수 먼저 저장, 차단 없음 (광고 유입 고객 손실 방지)
- 인앱브라우저 대응: 하단 전화바, target="\_blank" 자동 전환, 팝업/리다이렉트 없음
- userAgent + referrer 수집 (광고 유입 경로 추적)
- 오시는 길: 구글맵 + 상세정보
- CRM 엔드포인트: 시뮬레이션만 (Next.js 전환 시 실제 연결)

### GNB 전 페이지 상호 연결 완료

- 노블홍(홈) ↔ 노블매칭 ↔ 맞춤컨설팅 ↔ 매칭라운지 ↔ 상담문의
- 노블홍 소개 별도 페이지 불필요 (홈+노블매칭에 분산 반영됨)

## 다음 세션 TODO

### Next.js 전환

- [ ] 와이어프레임 5개 → Next.js App Router 페이지로 변환
- [ ] 공통 컴포넌트 추출: GNB, Footer, CTA Section
- [ ] CSS → Tailwind + CSS Modules
- [ ] GSAP 애니메이션 → Framer Motion 또는 GSAP React 래퍼

### CRM / API 구축

- [ ] POST /api/consultation — 상담 접수 엔드포인트
  - Airtable 저장 (IP + 타임스탬프 + userAgent + referrer 포함)
  - 텔레그램 알림: [노블홍/상담접수] IP + 이름 + 연락처 + 접수시각
  - 관리자 이메일 발송 (Gmail OAuth2)
  - 접수 무조건 저장, IP 차단 없음
  - 관리자 대시보드에서 동일IP 중복접수 플래그 (사후 필터링)
- [ ] 콘텐츠 피드 API — Airtable + R2 이미지 연동

### 러브칼럼 이미지

- [ ] 6개 칼럼 각각 AI 이미지 생성 (기존 이미지 사용 안 함)

### Vercel 배포

- [ ] 카페24 도메인 네임서버 → Vercel 변경
- [ ] SSL 자동 발급

## 와이어프레임 파일 목록

- wireframe_home_v3_motion.html (홈)
- wireframe_noblematching.html (노블매칭)
- wireframe_consulting.html (맞춤컨설팅)
- wireframe_matchinglounge.html (매칭라운지)
- wireframe_contact.html (상담문의)

## 참고

- 유튜브 데이터: data_youtube.json (147 videos + 18 shorts)
- 기획서: PLAN*04*콘텐츠매핑.html, PLAN*02*카피라이트전략.html
- 트러블슈팅: 가짜 videoId 절대 금지 (feedback_no_fake_data.md)
