---
date: 2026-04-03
---

# 다음 세션: 홈페이지 구현 진행

## 완료된 작업 (이번 세션)

### 와이어프레임 v3 모션 확정 (`wireframe_home_v3_motion.html`)

1. **히어로 섹션**
   - 커플 데이트 AI 이미지 배경 (`couple_date_hero.png`, Qwen-Image-2512 생성)
   - 반지 이미지 (`hero_ring.png`) 크로스페이드 슬라이드쇼 (GSAP, 7초 간격)
   - background-attachment: fixed 패럴랙스
   - 다크 컬러 오버레이 + 골드톤
   - 카피: "당신에게도 그 사람이 있습니다" / "30년간 쉬지 않고, 매일 소중한 인연을 이어온 8,000개의 인연 — 노블홍"
   - eyebrow "Since 1996 · Premium Matchmaking" 금가루 파티클 와이프 효과
   - "그 사람" 시머 그라디언트
   - AI 이미지 사용 반투명 뱃지

2. **GNB**
   - 흰색 배경, 메뉴 17px/600 weight, CTA 버튼 컴팩트

3. **Stats 섹션 — "숫자로 보는 노블홍"**
   - 4개 카운팅 (30년, 8000+, 75%, 3년연속)
   - 수평 바 차트 (도넛 차트에서 교체) — 연령대별 교제율 + 회원 자산 분포
   - Pretendard Variable 숫자 (DM Serif Display 제거)

4. **서비스 섹션 — "격이 다른 매칭"**
   - 호버 확장 카드 (flex 기반, 호버 시 확장)
   - 이미지 배경: card_premium.png, card_career.png, card_remarriage.png
   - 다크 오버레이 65%/85%
   - 타이포 효과: 글자별 stagger reveal + 골드 스위프 라인

5. **CEO 섹션 — 다크 스타일**
   - 다크 배경 (linear-gradient #1e1a14 → #2a2318)
   - 빨간 재킷 프로필 사진 (`ceo_profile2_hd.jpg`, 2x 업스케일)
   - 클리핑 마스크 좌우 조절 (ceo-image-clip)
   - "대한민국 커플매니저 제1호" 아이브로우 스타일 + 금가루 파티클 와이프
   - 미니 스탯 바 (30년, 50,000+, 8,000+, 300회+) 카운팅
   - 방송 출연 스트립 (ceo_broadcast.jpg, 풀폭 280px)
   - 수상 뱃지 3개 (pill 형태)

6. **CTA 섹션 — "당신의 인연, 지금 시작됩니다"**
   - AI 생성 흰 꽃 이미지 배경 (`cta_flowers.png`)
   - 다크 브라운골드 오버레이 85%
   - 이미지 contrast 70% + brightness 85% (플랫 처리)
   - 텍스트 흰색/골드 밝게

7. **미디어 섹션** — 얇은 폰트 처리 (200/400 weight)

8. **전체 모션**
   - GSAP ScrollTrigger 기반 등장 모션
   - expo.out 이징, stagger, 감각적 타이밍
   - 금가루 효과 2곳 (히어로 eyebrow, CEO 제1호)

### 인프라/스킬 구축

- `/gen-image` 스킬 생성 — Qwen-Image-2512 GGUF Q4_K_M via ComfyUI API
- `/gold-dust` 스킬 생성 — 금가루 파티클 와이프 효과 사양서
- `rembg` 설치 — 인물 누끼 자동 배경 제거
- CEO 이미지 스크래핑 (noblehong.com → ceo_profile2.jpg)

## 다음 세션 TODO

1. **Next.js 프로젝트 초기화** — 와이어프레임 기반 실제 구현 시작
2. **모바일 반응형** — 현재 와이어프레임은 PC only, 모바일 대응 필요
3. **서브 페이지 와이어프레임** — 서비스 상세, 상담 신청 폼 등
4. **폼 연동** — 카페24 CRM 또는 자체 폼 엔드포인트
5. **이미지 최적화** — WebP 변환, 사이즈 최적화
6. **Vercel 배포** — 초기 프리뷰 배포

## 생성된 이미지 자산

| 파일                  | 용도              | 생성 방법                 |
| --------------------- | ----------------- | ------------------------- |
| couple_date_hero.png  | 히어로 배경       | Qwen-Image-2512           |
| hero_ring.png         | 히어로 슬라이드 2 | 사용자 제공               |
| card_premium.png      | 명품결혼 카드     | 사용자 제공               |
| card_career.png       | 자녀결혼 카드     | 사용자 제공               |
| card_remarriage.png   | 스페셜재혼 카드   | 사용자 제공               |
| ceo_profile2.jpg      | CEO 원본          | noblehong.com 스크래핑    |
| ceo_profile2_hd.jpg   | CEO 2x 업스케일   | PIL LANCZOS + UnsharpMask |
| ceo_profile2_nobg.png | CEO 누끼          | rembg                     |
| ceo_broadcast.jpg     | 방송 출연 장면    | noblehong.com 스크래핑    |
| cta_flowers.png       | CTA 배경 꽃       | Qwen-Image-2512           |

## 참고 파일

- 원본 와이어프레임 (보존): `wireframe_home.html`
- 모션 확정본: `wireframe_home_v3_motion.html`
- 테스트 목업: test_gold_text_E.html, test_chart_A.html, test_service_B.html, test_ceo_A.html 등
- 기획 문서: PLAN*마이그레이션기획.html, PLAN_02*카피라이트전략.html, PLAN*03*디자인시스템.html
