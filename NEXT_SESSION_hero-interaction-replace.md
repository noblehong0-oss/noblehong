# 다음 세션: 히어로 인터랙션 대체 구현

## 결정 사항

- **카라꽃 3D 블룸 → 폐기**: ComfyUI Wan 2.2 i2v 14B Q4로 3라운드 테스트했으나 품질 미달
  - R1: 구도 파괴(줌인), 저해상도
  - R2: 모션 거의 없음, 배경 변색
  - R3: 형태 변질, 픽셀화 심각
- **기획 문서 업데이트 필요**: PLAN\_마이그레이션기획.html 섹션 A "히어로 — 카라꽃 블룸" → 대체 인터랙션으로 교체

## 대체 인터랙션 후보 (확정 필요)

1. **골든 오로라 + 빛 굴절** — GLSL 셰이더, 패럴랙스 레이어 (난이도 중, 고급스러움 최상)
2. **타이포그래피 + 골드 파티클** — SVG + GSAP, 브랜드 문구 리빌 (난이도 쉬움, 고급스러움 상)
3. **리퀴드 골드** — 셰이더 플루이드 시뮬레이션 (난이도 중상, 고급스러움 최상)
4. **스크롤 연동 영상** — 기존 골든아워 커플 MP4 활용 (난이도 쉬움, 고급스러움 상)

## 다음 세션 TODO

1. 사용자와 대체 인터랙션 확정
2. PLAN\_마이그레이션기획.html 히어로 섹션 업데이트
3. 선택된 인터랙션 프로토타입 구현 (HTML + GSAP + Three.js/셰이더)
4. 와이어프레임 반영

## 환경 정보

- ComfyUI: F:\ComfyUI_FLUX (v0.18.1, 업데이트 완료, GGUF 노드 설치됨)
- Wan 2.2 모델: F:\clipmake\ComfyUI\unet\ (extra_model_paths.yaml 연결 완료)
- CLIP Vision: clip_vision_h.safetensors (1.2GB, 다운로드 완료)
- 테스트 이미지: calla*test*_.png, calla*bud*_.png, calla*open*\*.png (프로젝트 루트)
- 테스트 영상: calla_bloom_r1~r3.webp (프로젝트 루트)
- proto_calla_bloom.html — Three.js 프로토타입 (실패, 삭제 가능)

## 참고: ComfyUI 셋업 상태

- RTX 4060 Ti 16GB + RAM 128GB
- FLUX Schnell: 이미지 생성 OK (고품질 카라꽃 이미지는 성공)
- Wan 2.2 14B Q4: 영상 생성 가능하나 품질 부족
- Wan 2.2 5B 풀모델 미설치 (필요시 다운로드)
