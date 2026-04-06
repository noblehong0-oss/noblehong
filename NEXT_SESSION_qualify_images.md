---
date: 2026-04-04
---

# 다음 세션: "이런 분이 오시는 곳입니다" 이미지 + 영상 제작

## 작업 위치

- 와이어프레임: `wireframe_home_v3_motion.html` → "이런 분이 오시는 곳입니다" 섹션
- 이미지 모델 가이드: `F:\2026_imagemake\IMAGE_MODEL_GUIDE.md`

## 확정된 3장면

### 1. 초혼 — "처음 결혼을 준비하는 분"

- **장면**: 서울 거리 골든아워 커플 데이트
- **모델**: FLUX.2 Dev Q4 (광원 소프트 버전)
- **이미지 확보 상태**: `flux2_softlight` 생성 대기 중 (큐 클리어됨, 재생성 필요)
- **레퍼런스 합격작**: `date_final.png`, `v4` (분위기 합격, 손 할루시네이션)

### 2. 재혼 — "새 출발을 준비하는 분"

- **장면**: 한강+남산 보이는 야외 카페 테이블, 30~40대 커플 대화
- **의상**: 남자 정장 (노타이), 여자 원피스/투피스 단정한 룩
- **주의**: 50대로 보이면 안 됨, 젊고 활력 있는 30대~40대 초반
- **모델**: FLUX.2 Dev Q4
- **이미지 확보 상태**: 미생성

### 3. 프리미엄 — "프리미엄 매칭을 원하는 분"

- **장면**: 의사(가운), 변호사(정장), 금융권 종사자가 나란히 서있는 모습
- **모델**: FLUX.2 Dev Q4
- **이미지 확보 상태**: 미생성

## 이미지 생성 후 TODO

1. 3장 이미지 확정 (시드 돌려서 손 정상인 컷 확보)
2. i2v 영상화 테스트 (HunyuanVideo 1.5 vs LTX-2.3 vs Wan 2.2)
3. 와이어프레임 카드에 이미지+영상 적용
4. 호버/스크롤 시 이미지→영상 전환 인터랙션 구현

## 프롬프트 가이드 (확정)

- **모델**: FLUX.2 Dev Q4 (`flux2-dev-Q4_0.gguf`)
- **인코더**: Mistral-Small-3.2-24B Q4_K_M (type: `flux2`)
- **VAE**: `flux2-vae.safetensors`
- **설정**: steps:20, cfg:2.5, sampler:euler, scheduler:normal
- **프롬프트 언어**: 영어
- **필수 키워드**: "Korean", "Seoul", "No text, no signs, no logos"
- **광원 제어**: "soft overcast natural daylight, no direct sunlight, no harsh highlights, gentle even ambient lighting"
- **카메라**: "Canon EOS R5 with RF 85mm f1.2L USM lens, wide open at f1.2"
- **네거티브**: "harsh light, strong shadows, lens flare, overexposed, blown highlights, HDR, anime, cartoon, painting, text, watermark, logo, sign"

## 이번 세션 완료 항목

- [x] 노블매칭 와이어프레임 v1 (`wireframe_noblematching.html`)
- [x] 콘텐츠 매핑표 (`PLAN_04_콘텐츠매핑.html`) — 기존 23페이지 → 신규 5페이지
- [x] HOME 와이어프레임 보강 (가입자격 + 절차 미리보기 + 이벤트)
- [x] 푸터 카피라이트 + POLA 백링크 (HOME, 노블매칭)
- [x] 인덱스 페이지 (`index.html`)
- [x] 이미지 모델 탐색 + 비교 테스트 (Qwen / Z-Image / FLUX.2 / FLUX.1)
- [x] LoRA 확보 (Boreal, KoreanGirl, flymy_realism)
- [x] i2v 모델 확보 (HunyuanVideo 1.5, LTX-2.3)
- [x] 이미지 모델 가이드 기록 (`F:\2026_imagemake\IMAGE_MODEL_GUIDE.md`)
- [x] ComfyUI 대시보드 (`gen_dashboard.html`)

## 보유 모델 요약

| 용도                 | 모델                  | 평가                              |
| -------------------- | --------------------- | --------------------------------- |
| 이미지 (최종 컷)     | FLUX.2 Dev Q4         | 디테일 최강, 광원 제어 필요, 느림 |
| 이미지 (빠른 테스트) | Qwen-Image-2512       | 안정적, 빠름, 한국인 OK           |
| 이미지 (분위기)      | Z-Image Turbo FP16    | 톤 최강, FP16 필수                |
| 영상 i2v             | HunyuanVideo 1.5 Q6_K | 미테스트                          |
| 영상 i2v             | LTX-2.3 Q4_K_M        | 미테스트                          |
| 영상 i2v             | Wan 2.2 14B Q4        | 이전 실패, 재테스트 필요          |

## 참고

- Civitai API 토큰: `.env` 파일 (`CIVITAI_API_TOKEN`)
- 비교 페이지: `compare_models.html`
- 이미지 테스트 폴더: `images/test/`
