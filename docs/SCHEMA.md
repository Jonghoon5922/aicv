# 증거 팩(Evidence Pack) 스키마 v1

`collect_ai_evidence` 도구가 반환하는 JSON. 구현: [evidence.js](../evidence.js)

## 원칙

1. **원문 반출 금지** — 대화·프롬프트·파일 내용은 어떤 필드에도 넣지 않는다. 집계값과 이름표(도구명·스킬명·확장자)만.
2. **프로젝트 경로는 기본 별칭** — `alias` + `path_hash`(sha256 12자). `reveal_projects=true`일 때만 실제 경로 포함.
3. **점수는 결정적** — `rubric`은 규칙 기반(`rule-based-v1`)으로 MCP가 계산. LLM은 인용만 하고 수정하지 않는다.
4. **정직한 한계 고지** — `caveats`에 미감지 소스·유실 가능성·추정치 여부를 자동 기재.

## 최상위 블록

| 블록 | 내용 | 이력서에서의 역할 |
|---|---|---|
| `window` `sources` `redaction` `subject` | 기간, 감지된 CLI(파일 수·클라이언트 버전), 비식별 정책, 계정 해시 | 신뢰성 각주 |
| `volume` | 토큰(입/출력)·세션·턴 수, 소스별 분해 | 규모 |
| `cadence` | 활동일수, consistency(활동일/기간), 최장 연속일, 주별 토큰 | 꾸준함 |
| `models` `model_diversity` | 모델별 토큰·비중·최초/최종 사용, frontier_share | 최신 모델 추종도 |
| `tools` | 도구별 호출 top20, 카테고리(read/edit/shell/search/web/delegation/mcp), edit:read 비, MCP 서버별 호출 | 작업 스타일 |
| `extensions` | 커스텀 스킬(authored 판정)·커맨드·에이전트·훅·구성된 MCP·서브에이전트/워크플로 실행 | "쓰는 사람" vs "확장하는 사람" |
| `workflow` | 권한 모드, effort 분포, 도구 실패율, 평균 프롬프트 길이, 세션당 턴, 병렬 도구 호출, 위임 라인 | 숙련도·검증 습관 |
| `stack` | 언어(확장자→라벨), 파일 read/edit/create 수, 도메인(backend/frontend/infra/data/docs) | 기술 스택 |
| `projects` | 프로젝트별 세션·토큰·활동일·주력 언어·브랜치 (별칭 처리) | 경력 항목 |
| `git` | 프로젝트별 커밋 수(본인 작성 구분)·파일·삽입/삭제 라인, include_git=false로 비활성 | 산출물 근거 |
| `growth` | 이전 스냅샷(~/.aicv/history) 대비 토큰·활동일·스킬·rubric 델타 | 지속 갱신·성장 스토리 |
| `rubric` | 5축 0~100: automation / context_design / tooling_extension / verification / cost_efficiency | 요약 지표 |
| `highlights` | 문장화 직전의 사실 카드 `{kind, fact, evidence[]}` | 호스트 LLM 입력 |
| `caveats` | 자동 생성된 한계 고지 문자열 배열 | 정직성 |

## 소스별 수집 범위

| 소스 | 경로 | 수집 수준 |
|---|---|---|
| claude-code | `~/.claude/projects/**/*.jsonl` + `~/.claude.json` + `~/.claude/settings.json` | 전체 (토큰·도구·스킬·확장·워크플로) |
| codex | `~/.codex/sessions/**/*.jsonl` | 토큰·모델만 |
| gemini | `~/.gemini/tmp/**/*.json(l)` | 토큰·모델만 |

## rubric 산식 (rule-based-v1)

로그 스케일 `lg(n, cap) = log10(1+n)/log10(1+cap)` (0~1 클램프) 기반 가중합.

- **automation**: 직접 작성 스킬 ×35 + 커맨드·에이전트·훅 ×20 + 서브에이전트·워크플로 실행 ×25 + 위임 라인 ×20
- **context_design**: 평균 프롬프트 길이 ×35 + 세션당 턴 ×30 + read 호출량 ×35
- **tooling_extension**: MCP 구성 ×35 + MCP 실호출 ×40 + 병렬 도구 호출 ×25
- **verification**: 셸 실행량 ×45 + 실패 회복 경험 ×30 + 낮은 실패율 ×25
- **cost_efficiency**: 출력/입력 비 ×40 + 모델 다양성 ×30 + frontier_share ×30

산식 변경 시 `method` 문자열을 반드시 올린다(예: `rule-based-v2`) — 이력서 간 점수 비교 가능성 유지.

## 버전 정책

- 필드 추가 = 마이너(스키마 버전 유지). 필드 의미 변경·삭제 = `schema_version` 증가.
- 이 JSON이 그대로 향후 포탈(공개 프로필 페이지) 업로드 페이로드가 된다.
