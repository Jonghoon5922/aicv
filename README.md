# AICV — AI 활용 능력 이력서

로컬 AI CLI 사용 로그(Claude Code·Codex·Gemini)를 근거로 **증거 기반 AI 활용 능력 이력서**를 만들고,
공개 프로필로 유지합니다. "많이 썼다"(리더보드)도 "시험 쳤다"(자격증)도 아닌,
**실제 작업 로그가 역량을 증명**합니다.

예시 프로필: https://aicv.tokenbill.my/r/jonghoon

## 시작하기 (3분)

**1. MCP 설치**

```bash
git clone https://github.com/Jonghoon5922/aicv
claude mcp add aicv -- node ./aicv/index.js
```

Codex CLI는 `codex mcp add aicv -- node ./aicv/index.js`, Gemini CLI 등 MCP 지원 도구도 같은 방식.

**2. 계정 연결** — [aicv.tokenbill.my](https://aicv.tokenbill.my) 구글 로그인 → **연결 코드 발급** → 새 AI 세션에서:

> "aicv 연결해줘, 코드 K7F3QZ"

끝. 토큰이 자동 저장되고(`~/.aicv/credentials.json`), 프로필 주소도 자동 생성됩니다(기본 **비공개**).

**3. 이력서 만들기** — `/aicv format=career` (또는 "AI 활용 이력서 만들어줘")

초안을 확인하면 포탈에 바로 발행됩니다. 회사·고객사 이름은 익명화되며, 발행 전 반드시 초안을 확인하세요.

**4. 공유** — 대시보드에서 **프로필 공개**를 켜면 `aicv.tokenbill.my/r/<내주소>` 링크로 누구나 볼 수 있습니다.
이력서·링크드인에 이 링크 한 줄이면 됩니다.

## 이후에는 (지속 업데이트)

| 상황 | 하는 일 |
|---|---|
| 평소 | 없음 — AI를 쓸 때마다 프로필 지표(기간·자산·기술 스택)가 **자동 갱신** (6시간 간격) |
| 문장 고치고 싶을 때 | "이력서에서 ○○ 부분 고쳐줘" — 발행본을 가져와 그 부분만 수정·재발행 |
| 크게 갱신하고 싶을 때 | `/aicv` 재실행 — 기존 발행본 위에서 달라진 수치·자산만 갱신 (다듬은 문장은 보존) |

## 출력 양식 4종

`career`(경력기술서 섹션·기본 발행) · `skills`(링크드인/이력서 스킬 목록) ·
`github`(프로필 README) · `full`(상세 리포트). `/aicv format=<양식>`으로 선택.

작성 원칙(가이드에 내장): 활동량 숫자(호출·토큰량) 배제, **만든 것·산출물 수치만**,
구체 사례는 STAR 압축형 + 고객사 익명화, 실제 링크 첨부.

## 수집 범위·프라이버시

| 소스 | 경로 | 수준 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` 외 | 전체 (도구·스킬·확장·사례 후보) |
| Codex CLI | `~/.codex/sessions/` | 토큰·모델 |
| Gemini CLI | `~/.gemini/tmp/` | 토큰·모델 |

- **대화 원문·프롬프트·파일 내용은 어떤 필드에도 담기지 않습니다** (집계값과 이름표만).
- 세션 제목(사례 후보)은 **로컬 전용** — 발행 시 클라이언트·서버 양쪽에서 제거됩니다.
- 프로젝트 경로는 별칭+해시. 실경로 포함 팩은 서버가 거부합니다.
- 프로필은 기본 비공개, 발행할 때마다 공개/비공개 상태를 알려줍니다.
- 이력서에 싣고 싶은 링크는 `~/.aicv/config.json`의 `links`에 등록.

## 문서

- [증거 팩 스키마 v1](docs/SCHEMA.md) — 블록 구조·버전 정책
- [포탈 설계](docs/PORTAL.md)
- [생성 예시](examples/AICV-career.md)

## 포탈 직접 운영하기

```bash
pip install -r server/requirements.txt
uvicorn server.main:app --port 8100
```

또는 Containerfile로 이미지 빌드 (main 푸시 시 ghcr.io 자동 빌드).
환경변수: `SECRET_KEY`(필수), `GOOGLE_CLIENT_ID`·`AUTH_GOOGLE_ONLY`(선택 — tokenbill과 동일한 로그인 방식).
자체 포탈을 쓰려면 MCP 등록 시 `--server https://내포탈` 추가.
