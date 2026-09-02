#!/usr/bin/env node
/**
 * AICV — AI 활용 능력 이력서 MCP 서버
 *
 * 로컬 AI CLI 로그(~/.claude, ~/.codex, ~/.gemini)를 스캔해 "증거 팩"
 * (집계값·이름표만, 원문 없음)을 만들고, 이력서 문장은 호스트 LLM이 쓴다.
 * 실행할 때마다 스냅샷이 ~/.aicv/history 에 쌓여 성장 델타(growth)가 나온다
 * — 한 번 쓰고 버리는 문서가 아니라 지속 업데이트되는 이력서.
 *
 * 도구:
 *   collect_ai_evidence  증거 팩 JSON 생성 (로컬 전용, 네트워크 없음)
 *   save_ai_resume       호스트가 작성한 이력서를 양식별 파일로 저장
 * 프롬프트:
 *   aicv                 수집→작성→저장 전 과정을 안내하는 템플릿
 *
 * 등록 예:
 *   claude mcp add aicv -- node <이 파일 경로>
 */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const readline = require("readline");
const { buildEvidence, SCHEMA_VERSION } = require("./evidence.js");

// ── 포탈 연동 설정 ──────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const os = require("os");
const CRED_PATH = path.join(os.homedir(), ".aicv", "credentials.json");
function loadCredToken() {
  try { return JSON.parse(fs.readFileSync(CRED_PATH, "utf8")).token || ""; } catch { return ""; }
}
function saveCredToken(token) {
  fs.mkdirSync(path.dirname(CRED_PATH), { recursive: true });
  fs.writeFileSync(CRED_PATH, JSON.stringify({ token, saved_at: new Date().toISOString() }), "utf8");
}
// 우선순위: --token > 환경변수 > 연결 코드로 저장된 자격증명
let TOKEN = arg("--token") || process.env.AICV_TOKEN || loadCredToken();
const SERVER = (arg("--server") || process.env.AICV_SERVER || "https://aicv.tokenbill.my").replace(/\/$/, "");

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + urlPath);
    const mod = url.protocol === "http:" ? http : https;
    const data = body ? JSON.stringify(body) : null;
    const req = mod.request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Token": TOKEN,
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); }
        catch { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}

function log(msg) { process.stderr.write("[aicv] " + msg + "\n"); }

// ── 출력 양식 — 실제 채용 시장에서 쓰이는 4종 ──────────────
const FORMATS = {
  full: {
    file: "AICV.md",
    guide: [
      "상세 리포트(전체 이력서). 구성:",
      "- 한 줄 요약 (가장 강한 신호 1~2개)",
      "- 핵심 역량 4~6개 불릿 — 각각 증거 팩 수치 인용, 행동동사 시작",
      "- 역량 프로파일 — rubric 5축 점수 표 (점수 수정 금지, '자체 산출 지표' 명시 — 제출용 문서에는 career 양식을 쓰도록 안내)",
      "- 성장 추이 — growth가 있으면 이전 대비 델타 명시",
      "- 산출물 — git.totals가 있으면 커밋·라인 수 인용",
      "- 활용 스택·도구 환경",
      "- 데이터 출처와 한계 (caveats 요약)",
    ].join("\n"),
  },
  career: {
    file: "AICV-career.md",
    guide: [
      "경력기술서 첨부용 'AI 활용 역량' 섹션 (1페이지 내, 붙여넣기 용도).",
      "- 제목: ## AI 활용 역량",
      "- 불릿 4~6개. 공식: **역량명(굵게)** + 행동동사로 시작하는 서술 + 기술/도구 + 산출물",
      "  예: '**AI 도구 자산화**: 반복 업무를 Claude Code 커스텀 스킬 7종으로 자동화해 실전 운영'",
      "- 채용담당자는 평균 31초 스캔 — **가장 강한 신호 2개를 맨 위에** (직접 만든 것 > 산출물 규모 > 적용 폭)",
      "- 수치 기준: **'만든 것·산출물' 수치만 사용** (스킬 N종, MCP N종, 파일 N개 변환, 프로젝트 N개).",
      "  **활동량 측정치는 금지** — 호출 횟수·셸 실행 횟수·턴 수·토큰량·실패율·병렬 호출 수. 자기 도구가 센 값이라 제3자에게 판단 기준이 없음",
      "- rubric 점수도 절대 인용 금지 (같은 이유)",
      "- 도구 이름 나열 금지 ('ChatGPT 능숙' 류). '어떻게 쓰는가'(자산화·위임·검증)를 서술로",
      "- '### 대표 활용 사례' 섹션: 실제 수행 작업 2~3건을 STAR 압축형(과제 → AI로 한 일 → 결과)으로. 증거 팩의 case_candidates(세션 제목)와 스킬명에서 재구성하되 고객사·사내 시스템 실명은 반드시 익명화('국내 생명보험사' 등) — 공개 전 사용자에게 초안 확인 필수",
      "- 문체는 경력기술서 톤(명사형 종결). '### 참고 링크' 섹션: 증거 팩의 links 배열을 그대로 사용 + 마지막 줄에 '상세 사용 이력(자동 집계): <포탈 프로필 URL>'",
    ].join("\n"),
  },
  skills: {
    file: "AICV-skills.md",
    guide: [
      "이력서 스킬 섹션·링크드인·원티드용 'AI & Data Skills' 항목 목록.",
      "- 각 항목은 한 줄: 스킬명 — 구체 용례 + 수치 (예: 'AI 워크플로 자동화 — 커스텀 스킬 10종 작성, 1,456회 실전 투입')",
      "- 5~8줄, 복사해서 바로 붙일 수 있게. 강한 것부터 정렬",
      "- rubric 점수 인용 금지, '~에 능숙' 같은 모호한 표현 금지",
      "- 도구명은 용례와 함께만 (단독 나열 금지)",
    ].join("\n"),
  },
  github: {
    file: "AICV-github.md",
    guide: [
      "GitHub 프로필 README·노션 포트폴리오용 섹션.",
      "- 제목 + 표 형식의 핵심 지표 (직접 만든 스킬/MCP 수, 커밋, 세션 규모 등 원천 수치)",
      "- shields.io 스타일 배지 마크다운 3~4개 (예: Custom_Skills-10-blue, MCP_Servers-2-blueviolet)",
      "- rubric 점수 배지는 포탈 프로필 링크와 함께일 때만 (근거 페이지 없이 점수만 띄우지 않기)",
      "- 캐주얼하되 수치는 정확히",
    ].join("\n"),
  },
};

// ── 도구 정의 ───────────────────────────────────────────────
const TOOLS = [
  {
    name: "collect_ai_evidence",
    description:
      "로컬 AI CLI 사용 로그(Claude Code·Codex·Gemini)를 스캔해 'AI 활용 능력 증거 팩'(구조화 JSON)을 만듭니다. " +
      "대화 원문·파일 내용은 포함하지 않으며 집계값과 이름표만 담습니다. 네트워크 접근 없음. " +
      "이전 스냅샷 대비 성장 델타(growth)를 포함하며, include_git=true일 때만 git 커밋 수를 보조 지표로 집계합니다. " +
      "이 결과를 바탕으로 호스트(당신)가 이력서 문장을 작성하세요. rubric 점수는 규칙 기반으로 이미 계산되어 있으니 수정하지 말고 인용만 하세요.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "집계 기간(일). 기본 90, 범위 7~365", minimum: 7, maximum: 365 },
        reveal_projects: { type: "boolean", description: "true면 프로젝트 실제 경로 포함(기본 false: 별칭+해시만). 경로에 회사·고객사명이 있을 수 있으니 사용자 동의 후에만." },
        include_git: { type: "boolean", description: "git 커밋 이력 수집 여부(기본 false — 커밋 수는 보조 지표, 원하는 경우만 켜세요. ~/.aicv/config.json의 extra_repos로 레포 수동 등록 가능)" },
      },
    },
  },
  {
    name: "save_ai_resume",
    description:
      "작성 완료된 AI 활용 능력 이력서(markdown)를 양식별 파일로 저장합니다. " +
      "format: full(상세 리포트)|career(경력기술서 섹션)|skills(스킬 목록)|github(프로필 README 섹션). " +
      "기본 저장 경로는 현재 디렉터리의 AICV*.md.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "이력서 전체 본문(markdown)" },
        format: { type: "string", enum: ["full", "career", "skills", "github"], description: "양식(기본 full) — 기본 파일명 결정에 사용" },
        file_path: { type: "string", description: "저장 경로(선택). 지정 시 format 기본 파일명 대신 사용" },
      },
      required: ["markdown"],
    },
  },
  {
    name: "connect_aicv",
    description:
      "연결 코드로 이 기기를 AICV 포탈 계정에 연결합니다. 사용자가 포탈(" +
      "aicv.tokenbill.my) 대시보드에서 발급받은 6자리 코드를 말하면 호출하세요. " +
      "성공하면 토큰이 자동 저장되어 이후 publish_aicv가 바로 동작합니다.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "포탈 대시보드에 표시된 연결 코드 (예: K7F3QZ)" },
      },
      required: ["code"],
    },
  },
  {
    name: "publish_aicv",
    description:
      "증거 팩(자동 재수집)과 선택적으로 완성 이력서를 AICV 포탈에 업로드해 공개 프로필을 갱신합니다. " +
      "업로드 토큰(--token 또는 AICV_TOKEN)이 필요합니다 — 포탈에서 발급. " +
      "프라이버시: 실경로가 포함된 팩(reveal_projects)은 서버가 거부하므로 항상 별칭 팩만 전송됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "집계 기간(일, 기본 90)", minimum: 7, maximum: 365 },
        markdown: { type: "string", description: "함께 올릴 완성 이력서 본문(선택)" },
        format: { type: "string", enum: ["full", "career", "skills", "github"], description: "이력서 양식(기본 full)" },
        skill_groups: {
          type: "array",
          description: "프로필 '직접 만든 자동화 자산' 섹션용 — 직접 만든 스킬·MCP를 비슷한 것끼리 묶고 한 줄 설명을 붙인다. 호스트(당신)가 증거 팩의 custom_skills(authored)·mcp_servers_configured를 보고 작성. 고객사 실명 금지.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "묶음 이름 (예: '프레임워크 전환')" },
              description: { type: "string", description: "한 줄 설명 (예: '레거시 코드를 영역별로 자동 변환')" },
              items: { type: "array", items: { type: "string" }, description: "스킬/서버 이름들" },
              kind: { type: "string", enum: ["skill", "mcp"], description: "mcp면 보라색 표시" },
            },
            required: ["title", "items"],
          },
        },
      },
    },
  },
];

// ── 프롬프트 정의 ───────────────────────────────────────────
const PROMPTS = [
  {
    name: "aicv",
    description: "로컬 AI 사용 이력을 근거로 'AI 활용 능력 이력서'를 작성·갱신합니다.",
    arguments: [
      { name: "format", description: "full|career|skills|github (기본 full)", required: false },
      { name: "days", description: "집계 기간(일, 기본 90)", required: false },
      { name: "language", description: "작성 언어(기본: 한국어)", required: false },
    ],
  },
];

function promptText(format, days, language) {
  const f = FORMATS[format] || FORMATS.full;
  return [
    "AI 활용 능력 이력서를 작성해줘. 절차:",
    "",
    "1. collect_ai_evidence 도구를 호출해 (days=" + (days || 90) + ") 증거 팩을 받아.",
    "2. 증거 팩만을 근거로 " + (language || "한국어") + "로 아래 양식에 맞춰 작성해:",
    f.guide,
    "3. 공통 규칙:",
    "   - 증거 팩에 없는 사실을 지어내지 마. 모든 주장에는 수치 근거를 붙여.",
    "   - 토큰량 자체보다 '어떻게 쓰는가'(확장·위임·검증 습관)를 강조해.",
    "   - highlights의 사실 카드를 우선 활용하고, growth가 있으면 성장 스토리로 연결해.",
    "4. 사용자에게 초안을 보여주고, 확정되면 publish_aicv(format=\"" + (format || "full") + "\", markdown=초안, skill_groups=직접 만든 스킬 묶음)로 포탈에 바로 발행해.",
    "   발행 결과의 프로필 상태(공개/비공개)를 사용자에게 그대로 전달해. 비공개면 아무도 못 보니 안심해도 된다고 알려줘.",
    "   로컬 파일 저장(save_ai_resume)은 사용자가 파일을 원할 때만.",
  ].join("\n");
}

// ── 도구 실행 ───────────────────────────────────────────────
function runCollect(args) {
  const t0 = Date.now();
  const pack = buildEvidence(args || {});
  log("증거 팩 생성 (" + (Date.now() - t0) + "ms, " +
      pack.volume.total_tokens.toLocaleString() + " tok, git 커밋 " +
      (pack.git.totals ? pack.git.totals.commits : 0) + "건)");
  return JSON.stringify(pack);
}

async function runConnect(args) {
  const code = String((args && args.code) || "").trim().toUpperCase();
  if (!code) return "연결 코드를 알려주세요 — 포탈(" + SERVER + ") 대시보드의 '연결 코드 발급'에서 확인할 수 있습니다.";
  try {
    const r = await request("POST", "/api/pair/claim", { code });
    if (r.status !== 200) return "연결 실패 (HTTP " + r.status + (r.json.detail ? " — " + r.json.detail : "") + ")";
    TOKEN = r.json.upload_token;
    saveCredToken(TOKEN);
    return "✅ 연결 완료 — 계정: " + (r.json.handle || "(핸들 미설정)") +
      " · 프로필 " + (r.json.visibility === "public" ? "공개" : "비공개") + " 상태\n" +
      "이제 \"포탈에 올려줘\"라고만 하면 됩니다.";
  } catch (e) { return "연결 실패 (" + e.message + ")"; }
}

async function runPublish(args) {
  if (!TOKEN) return "아직 계정이 연결되지 않았습니다 — 포탈(" + SERVER + ") 대시보드에서 연결 코드를 발급받아 \"aicv 연결해줘, 코드 XXXXXX\"라고 말해주세요.";
  args = args || {};
  // 서버에는 항상 별칭 팩만 (reveal_projects 강제 해제)
  const pack = buildEvidence({ days: args.days, reveal_projects: false });
  delete pack.case_candidates; // 세션 제목은 로컬 전용 — 서버로 보내지 않는다
  if (Array.isArray(args.skill_groups) && args.skill_groups.length) {
    pack.extensions.skill_groups = args.skill_groups.slice(0, 8);
  }
  const results = [];
  let visibility = null, handle = null;
  try {
    const r = await request("POST", "/api/evidence", pack);
    if (r.status === 200) {
      visibility = r.json.visibility;
      handle = r.json.handle;
      results.push("증거 팩 업로드 완료 (" + r.json.date + ")");
    } else {
      results.push("증거 팩 업로드 실패 (HTTP " + r.status + (r.json.detail ? " — " + r.json.detail : "") + ")");
    }
  } catch (e) { results.push("증거 팩 업로드 실패 (" + e.message + ")"); }
  if (args.markdown) {
    try {
      const r = await request("POST", "/api/resume", { format: args.format || "full", markdown: args.markdown });
      results.push(r.status === 200 ? "이력서(" + (args.format || "full") + ") 업로드 완료"
        : "이력서 업로드 실패 (HTTP " + r.status + (r.json.detail ? " — " + r.json.detail : "") + ")");
    } catch (e) { results.push("이력서 업로드 실패 (" + e.message + ")"); }
  }
  // 공개 상태 안내 — 사용자는 이것만 알면 된다
  if (visibility === "public") {
    results.push("🌐 프로필: 공개 — " + SERVER + "/r/" + handle + " (링크를 아는 누구나 볼 수 있음)");
  } else if (visibility === "private") {
    results.push("🔒 프로필: 비공개 — 본인 외 아무도 볼 수 없습니다. 공개하려면 " + SERVER + " 대시보드에서 '프로필 공개'를 켜세요.");
  } else if (visibility === "no_handle") {
    results.push("🔒 프로필: 비공개(핸들 미설정) — " + SERVER + " 대시보드에서 핸들을 정하고 공개 여부를 선택하세요.");
  }
  return results.join("\n");
}

function runSave(args) {
  if (!args || typeof args.markdown !== "string" || !args.markdown.trim()) {
    throw new Error("markdown 본문이 비어 있습니다.");
  }
  const f = FORMATS[args.format] || FORMATS.full;
  const fp = path.resolve(args.file_path || path.join(process.cwd(), f.file));
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, args.markdown, "utf8");
  return "저장 완료: " + fp + " (" + Buffer.byteLength(args.markdown) + " bytes)";
}

// ── MCP (stdio, 개행 구분 JSON-RPC) ────────────────────────
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function replyErr(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "aicv", version: "0.2.0", schema_version: SCHEMA_VERSION },
    });
  }
  if (method && method.startsWith("notifications/")) return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "prompts/list") return reply(id, { prompts: PROMPTS });
  if (method === "prompts/get") {
    const name = params && params.name;
    if (name !== "aicv") return replyErr(id, -32602, "unknown prompt: " + name);
    const a = (params && params.arguments) || {};
    return reply(id, {
      description: PROMPTS[0].description,
      messages: [{ role: "user", content: { type: "text", text: promptText(a.format, a.days, a.language) } }],
    });
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    let text;
    try {
      if (name === "collect_ai_evidence") text = runCollect(args);
      else if (name === "save_ai_resume") text = runSave(args);
      else if (name === "publish_aicv") text = await runPublish(args);
      else if (name === "connect_aicv") text = await runConnect(args);
      else return replyErr(id, -32602, "unknown tool: " + name);
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: "오류: " + e.message }], isError: true });
    }
    return reply(id, { content: [{ type: "text", text }] });
  }
  if (id !== undefined) return replyErr(id, -32601, "method not found: " + method);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) replyErr(msg.id, -32603, e.message); });
});
rl.on("close", () => process.exit(0));
log("AICV MCP 서버 시작 (schema v" + SCHEMA_VERSION + ")");
