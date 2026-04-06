# 세션 핸드오프: qualify 섹션 이미지/영상 적용

## 완료 작업

1. **금장 곡선 기하학 배경 SVG** — qualify 섹션 다크 배경(#1a1714) + 골드 곡선 라인
2. **이미지 3장 생성** (FLUX Schnell, 1024x640)
   - `qualify_couple_thumb.jpg` — 커플 손잡고 걷는 뒷모습 (골든아워)
   - `qualify_cafe_thumb.jpg` — 40대 커플 카페 대화
   - `qualify_premium_thumb.jpg` — 전문직 비즈니스맨 고층 오피스
3. **영상 3개 생성** (Wan 2.2 I2V 14B GGUF + LightX2V LoRA, 640x384, 49프레임@16fps ≈ 3초)
   - `qualify_couple_clip.mp4`, `qualify_cafe_clip.mp4`, `qualify_premium_clip.mp4`
4. **HTML/CSS/JS 적용** — 카드에 미디어 영역 추가, ScrollTrigger로 화면 60% 도달 시 썸네일→비디오 자동재생

## 미확인 사항

- 사용자가 브라우저에서 실제 확인 전 세션 종료
- 이미지/영상 퀄리티 피드백 미수령
- 반응형(모바일) 레이아웃 미적용

## 수정된 파일

- `wireframe_home_v3_motion.html` — qualify 섹션 CSS + HTML + JS 변경

## 생성된 파일

- `qualify_couple_thumb.jpg`, `qualify_cafe_thumb.jpg`, `qualify_premium_thumb.jpg`
- `qualify_couple_clip.mp4`, `qualify_cafe_clip.mp4`, `qualify_premium_clip.mp4`
- `gen_i2v.py` — I2V 생성 스크립트 (재생성 시 재사용 가능)

## ComfyUI 모델 참고

- 이미지: `flux1-schnell.safetensors` (F:\ComfyUI_FLUX\models\diffusion_models)
- I2V: `wan2.2_i2v_high/low_noise_14B_Q4_K_S.gguf` (F:\clipmake\ComfyUI\unet/) — UnetLoaderGGUF 노드 사용
- LoRA: `lightx2v_I2V_14B_480p_cfg_step_distill_rank32_bf16.safetensors` (F:\clipmake\ComfyUI\loras/)
- CLIP: `umt5_xxl_fp8_e4m3fn_scaled.safetensors`, VAE: `wan_2.1_vae.safetensors`

## 다음 세션 TODO

- [ ] 브라우저에서 qualify 섹션 실물 확인 → 이미지/영상 퀄리티 검수
- [ ] 필요 시 이미지 재생성 (프롬프트 조정)
- [ ] 모바일 반응형 적용 (qualify-grid 1열 전환)
