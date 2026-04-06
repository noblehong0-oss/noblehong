---
date: 2026-04-05
---

# Next Session: Qualify Section Image Generation (Retry)

## Status

ComfyUI + FLUX.2 Dev Q4 이미지 생성 세션. interrupt 후 모델 로딩 꼬여서 속도 저하 발생.
**다음 세션에서 ComfyUI 재시작 후 새로 생성 필요.**

## Confirmed 3 Scenes

### 1. First Marriage - "처음 결혼을 준비하는 분"

- Scene: Seoul Garosugil golden hour couple walking
- Feedback: 환경광 통합 필요 (인물이 배경에서 붕 뜨는 느낌)
- v1 PASS (qualify_first_marriage_s3953992199.png) but needs v2 with environment integration
- v2 generation failed (ComfyUI stuck)

### 2. Remarriage - "새 출발을 준비하는 분"

- Scene: Rooftop cafe couple, Namsan+Han River background
- Feedback: 남자 V넥 → 일반 와이셔츠 칼라 버튼업으로 변경
- v1 PASS (qualify_remarriage_s865732769.png)
- v2 generated (qualify*remarriage_v2_00001*.png) but unchecked

### 3. Premium - "프리미엄 매칭을 원하는 분"

- Scene: 여의사 + 남변호사 + 남금융인, 30대 초반
- Feedback: 환경광 통합 필요 + 나이 더 젊게 (30대 초반)
- v2 PASS (qualify_premium_v2_s2879570100.png) - composition OK
- v5 generation failed (ComfyUI stuck)

## Key Feedback (All Scenes)

- **인물이 배경 대비 너무 선명해서 붕 뜨는 느낌** → 환경광 통합, 통일 컬러 그레이딩 필요
- Prompt fix: "photojournalistic style", single light source, negative에 "studio lighting, composite, cutout" 추가

## TODO (Next Session)

1. **ComfyUI 완전 재시작** (콘솔 Ctrl+C → 재실행)
2. 3장면 재생성 (gen_flux2_v2.py 사용 — 프롬프트 이미 반영됨)
3. 리뷰 → 합격 시 Google Vids i2v 테스트
4. 와이어프레임 카드 적용

## Google Vids i2v Plan

- 이미지 합격 후 Google Vids (Veo 3.1)로 8초 영상 생성
- 프롬프트 준비 완료 (아래 참고)

### Vids Prompts (Draft)

1. First Marriage: "The couple walks naturally hand in hand, woman laughs and looks at the man, golden light flickers through leaves, gentle breeze moves her skirt"
2. Remarriage: "The couple has a warm intimate conversation, man gestures gently while speaking, coffee steam rises from cups, soft wind moves her hair"
3. Premium: "Subtle natural movement, the female doctor adjusts her stethoscope, the men shift weight casually, soft light changes from windows"

## Scripts

- `gen_flux2_qualify.py` — 원본 3장면 (v1)
- `gen_flux2_v2.py` — 피드백 반영 3장면 (v2/v5) ← 이것 사용
- `gen_i2v.py` — Wan 2.2 i2v (이전 세션)

## Model Guide

- `F:\2026_imagemake\IMAGE_MODEL_GUIDE.md`

## ComfyUI Setup

- Path: F:\ComfyUI_FLUX
- Model: flux2-dev-Q4_0.gguf (18GB) + Mistral-Small-3.2-24B Q4_K_M (13GB)
- RTX 4060 Ti 16GB → CPU offload 필수, 정상 속도 장당 ~15분
- **중요: interrupt 후 재시작 없이 재큐잉하면 속도 저하 발생**

## Existing Images (keep for comparison)

- qualify_first_marriage_s3953992199.png — v1 PASS
- qualify_remarriage_s865732769.png — v1 PASS
- qualify_premium_v2_s2879570100.png — v2 PASS (composition)
- qualify*remarriage_v2_00001*.png — v2 unchecked
