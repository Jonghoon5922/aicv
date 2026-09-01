# AICV — AI 활용 능력 이력서 MCP

로컬 AI CLI 사용 로그(Claude Code·Codex·Gemini)를 스캔해 **증거 기반 AI 활용 능력 이력서**를 만듭니다.
"많이 썼다"(리더보드)도 "시험 쳤다"(자격증)도 아닌, **실제 작업 로그가 역량을 증명**합니다.

## 동작 원리

1. `collect_ai_evidence` — 로컬 로그를 스캔해 **증거 팩**(집계값·이름표만, 대화 원문 없음) 생성. 네트워크 접근 없음.
2. 호스트 LLM(Claude Code 등)이 증거 팩을 근거로 이력서 문장을 작성 — 규칙 기반 rubric 점수는 인용만.
3. `save_ai_resume` — 4가지 양식으로 저장:
   - `full` 상세 리포트 · `career` 경력기술서 섹션 · `skills` 링크드인/원티드 스킬 목록 · `github` 프로필 README
4. 실행할 때마다 `~/.aicv/history`에 스냅샷 저장 → 다음 실행에서 **성장 델타(growth)** 자동 산출.
   한 번 쓰고 버리는 문서가 아니라 **지속 업데이트되는 이력서**입니다.

## 설치

```bash
claude mcp add aicv -- node <이 레포 경로>/index.js
```

새 세션에서 `/aicv` 프롬프트 또는 "AI 활용 이력서 만들어줘"라고 하면 됩니다.

## 수집 범위·프라이버시

| 소스 | 경로 | 수준 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` 외 | 전체 (토큰·도구·스킬·확장·워크플로) |
| Codex CLI | `~/.codex/sessions/` | 토큰·모델만 |
| Gemini CLI | `~/.gemini/tmp/` | 토큰·모델만 |
| git | 작업했던 로컬 레포 | 커밋 수·삽입/삭제 라인 (본인 작성 구분) |

- 대화 원문·프롬프트·파일 내용은 **어떤 필드에도 담지 않습니다** (프롬프트는 평균 글자 수 통계만).
- 프로젝트 경로는 기본 별칭+해시. `reveal_projects=true`로 명시 동의 시에만 실경로.
- 계정 이메일은 해시만.

## 문서

- [증거 팩 스키마 v1](docs/SCHEMA.md) — 블록 구조·rubric 산식·버전 정책
- [포탈 설계](docs/PORTAL.md) — 2단계: 공개 프로필 페이지 (`/r/<핸들>`)
- [생성 예시](examples/AICV.md)

## 예시 (rubric 5축, 규칙 기반 0~100)

| 축 | 의미 |
|---|---|
| verification | 실행·확인하며 진행하는 검증 습관 |
| context_design | 프롬프트 충실도·장기 세션 운용 |
| automation | 커스텀 스킬·훅·서브에이전트로 반복을 자산화 |
| tooling_extension | MCP 구성·병렬 도구 호출 |
| cost_efficiency | 모델 선택·출력 효율 |
