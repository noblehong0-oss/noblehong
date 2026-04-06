---
date: 2026-04-05
---

# Next Session: 홈페이지 에셋 적용 & 마무리

## 완료 항목

### 이미지 생성

- [x] FLUX.2 Dev Q4 — 3장면 (초혼/재혼/프리미엄) 피부톤 개선 프롬프트
- [x] Qwen-Image-2512 — 동일 3장면 1920x1088
- [x] PuLID-FLUX 세팅 완료 (얼굴 유지 생성)
- [x] LoRA 5종 설치 (female_body, body_flux_fix, body_enhancer, realistic_enhancer, realistic_female_flux)
- [x] ComfyUI 워크플로우 JSON 3종 (qwen_bodyprofile, flux_lora_bodyprofile, pulid_bodyprofile)

### 영상 생성 (Google Vids Veo 3.1)

- [x] 히어로 (히어로1.mp4)
- [x] 초혼/재혼/전문가 (초혼.mp4, 재혼.mp4, 전문가.mp4)
- [x] 버진로드 (버진로드.mp4)
- [x] CEO 인사 (인사.mp4)
- [x] CTA 웨딩 (cta.mp4)

### 와이어프레임 적용 (wireframe_home_v3_motion.html)

- [x] 히어로: hero1.png → 2초 후 히어로1.mp4 전환
- [x] 숫자로 보는 노블홍: 버진로드.png → 3초 정지 후 영상 전환
- [x] 이런 분이 오시는 곳 3카드: 초혼/재혼/전문가 이미지+영상 (3초 정지 후 전환)
- [x] CEO 프로필: 인사.png → 3초 정지 후 인사.mp4 전환
- [x] CTA: cta.png → 3초 정지 후 cta.mp4 전환
- [x] AI생성 배지 (카드 내부만, 섹션 배경 제외)
- [x] PC: 3초 정지 후 영상 재생 / 모바일: 스크롤 진입 시 바로 재생

### PuLID-FLUX 환경

- [x] ComfyUI-PuLID-Flux 노드 설치
- [x] pulid_flux_v0.9.1.safetensors
- [x] EVA02_CLIP_L_336_psz14_s6B.pt
- [x] AntelopeV2 (5개 onnx)
- [x] insightface 0.2.1 + ONNX 래퍼 (face_analysis_onnx.py)
- [x] ReActor 포크 (edwios/comfyui-reactor) 클론 완료
- [ ] insightface 0.7.3 빌드 실패 (VS Build Tools C++ 워크로드 필요)

## 미완료 / 다음 세션 TODO

1. **상담부터 성혼까지 4단계 이미지 생성** — 무료상담/가입인증/맞춤매칭/만남성혼
2. **상담부터 성혼까지 4단계 영상 생성** — 프롬프트 준비 완료
3. **insightface 정식 설치** — VS Build Tools에서 "C++를 사용한 데스크톱 개발" 워크로드 설치 필요
4. **와이어프레임 steps 섹션에 4단계 이미지/영상 적용**
5. **CEO 이미지 비율 조정** — contain으로 변경됨, 실제 보이는지 확인 필요
6. **모바일 반응형 확인**

## 에셋 경로

- 이미지/영상: `F:\pola_homepage\36.noblehong\images\qualify\`
- 와이어프레임: `wireframe_home_v3_motion.html`
- ComfyUI 워크플로우: `workflow_qwen_bodyprofile.json`, `workflow_flux_lora_bodyprofile.json`
- PuLID ONNX 래퍼: `F:\ComfyUI_FLUX\custom_nodes\ComfyUI-PuLID-Flux\face_analysis_onnx.py`

## ComfyUI 설정

- Path: F:\ComfyUI_FLUX
- FLUX.2: flux2-dev-Q4_0.gguf + Mistral-Small-3.2-24B Q4_K_M
- Qwen: qwen-image-2512-Q4_K_M.gguf + Qwen2.5-VL-7B Q4_K_M
- PuLID: pulid_flux_v0.9.1.safetensors + EVA02_CLIP + AntelopeV2
- LoRA: female_body, body_flux_fix, body_enhancer, realistic_enhancer, realistic_female_flux
- RTX 4060 Ti 16GB, CPU offload
