"use strict";
/**
 * AI 활용 능력 이력서 — 증거 팩(evidence pack) 수집기 v1
 *
 * 로컬 AI CLI 로그를 스캔해 "집계값과 이름표"만 담은 구조화 JSON을 만든다.
 * 원칙: 대화 원문·프롬프트 텍스트·파일 내용은 어떤 필드에도 넣지 않는다.
 *       (프롬프트는 '평균 글자 수' 같은 통계로만 반영)
 *
 * 이 팩을 호스트 LLM(Claude Code 등)에게 돌려주고, 이력서 문장은 호스트가 쓴다.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SCHEMA_VERSION = 1;
const HISTORY_DIR = path.join(os.homedir(), ".aicv", "history");

// ── 공통 유틸 ───────────────────────────────────────────────
function* walkFiles(dir, ext) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, ext);
    else if (e.isFile() && e.name.endsWith(ext)) yield p;
  }
}
const day = (ts) => (ts || "").slice(0, 10);
const sha = (s) => "sha256:" + crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const topN = (obj, n, keyName, valName) =>
  Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({ [keyName]: k, [valName]: v }));

// ISO 주차 (2026-W35)
function isoWeek(dayStr) {
  const d = new Date(dayStr + "T00:00:00Z");
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + "-W" + String(wk).padStart(2, "0");
}

// ── 도구 분류 ───────────────────────────────────────────────
const TOOL_CATEGORY = {
  Read: "read", NotebookRead: "read",
  Edit: "edit", Write: "edit", NotebookEdit: "edit",
  Bash: "shell", PowerShell: "shell",
  Grep: "search", Glob: "search",
  WebFetch: "web", WebSearch: "web",
  Agent: "delegation", Task: "delegation", Workflow: "delegation", Skill: "delegation",
};
function toolCategory(name) {
  if (name.startsWith("mcp__")) return "mcp";
  return TOOL_CATEGORY[name] || "other";
}

// ── 언어·도메인 매핑 ────────────────────────────────────────
const LANG = {
  ".java": "Java", ".kt": "Kotlin", ".py": "Python", ".js": "JavaScript", ".ts": "TypeScript",
  ".tsx": "TypeScript", ".jsx": "JavaScript", ".go": "Go", ".rs": "Rust", ".rb": "Ruby",
  ".php": "PHP", ".cs": "C#", ".c": "C", ".cpp": "C++", ".swift": "Swift", ".sql": "SQL",
  ".sh": "Shell", ".ps1": "PowerShell", ".html": "HTML", ".css": "CSS", ".scss": "CSS",
  ".vue": "Vue", ".md": "Markdown", ".yaml": "YAML", ".yml": "YAML", ".xml": "XML",
  ".gradle": "Gradle", ".tf": "Terraform",
};
const DOMAIN = {
  Java: "backend", Kotlin: "backend", Python: "backend", Go: "backend", Rust: "backend",
  Ruby: "backend", PHP: "backend", "C#": "backend", SQL: "data",
  JavaScript: "frontend", TypeScript: "frontend", HTML: "frontend", CSS: "frontend", Vue: "frontend",
  Shell: "infra", PowerShell: "infra", Terraform: "infra", Gradle: "infra", YAML: "infra",
  Markdown: "docs",
};
// 최신·고성능 모델 판정(휴리스틱) — frontier_share 계산용
const FRONTIER = /(opus|gpt-5|o3|o4|-pro|sonnet-5|fable)/i;

// ── Claude Code 로그 스캔 ───────────────────────────────────
function scanClaudeCode(cutoff, acc) {
  const base = path.join(os.homedir(), ".claude", "projects");
  const seen = new Set();
  let files = 0;
  for (const file of walkFiles(base, ".jsonl")) {
    files++;
    // 프로젝트 키 = 로그 폴더명 (Claude Code가 프로젝트 루트 경로를 인코딩해 만든 디렉터리)
    const projectKey = path.basename(path.dirname(file));
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const d = day(e.timestamp);
      if (d && d < cutoff) continue;

      if (e.version) acc.clientVersions.add(e.version);
      if (e.permissionMode) acc.permissionModes[e.permissionMode] = (acc.permissionModes[e.permissionMode] || 0) + 1;
      if (e.effort) acc.efforts[e.effort] = (acc.efforts[e.effort] || 0) + 1;
      if (e.attributionSkill) acc.skillCalls[e.attributionSkill] = (acc.skillCalls[e.attributionSkill] || 0) + 1;
      if (e.isSidechain) acc.sidechainLines++;
      if (e.agentId) acc.agentIds.add(e.agentId);

      const proj = acc.projects[projectKey] || (acc.projects[projectKey] = {
        key: projectKey, cwd: null, sessions: new Set(), days: new Set(),
        tokens: 0, branches: new Set(), langs: {},
      });
      if (e.cwd && !proj.cwd) proj.cwd = e.cwd;
      if (e.gitBranch) proj.branches.add(e.gitBranch);
      if (e.sessionId) { acc.sessions.add(e.sessionId); proj.sessions.add(e.sessionId); }

      // 사용자 프롬프트 길이 (텍스트는 저장하지 않고 글자 수만)
      if (e.type === "user" && e.message && typeof e.message.content === "string" && !e.isMeta) {
        const t = e.message.content;
        if (!t.startsWith("<")) { acc.userMsgs++; acc.userChars += t.length; }
      }

      // 도구 실행 결과 → 실패율(검증 습관 지표)
      if (e.toolUseResult !== undefined) {
        acc.toolResults++;
        const s = JSON.stringify(e.toolUseResult).slice(0, 400);
        if (/"is_error"\s*:\s*true|Exit code [1-9]/i.test(s)) acc.toolFailures++;
      }

      if (e.type !== "assistant" || !e.message) continue;

      // 도구 호출 — 병렬 호출은 같은 message.id로 여러 라인에 나뉘어 기록되므로 id 기준으로 묶는다
      const blocks = Array.isArray(e.message.content) ? e.message.content : [];
      const callsThisTurn = blocks.filter((b) => b.type === "tool_use");
      if (callsThisTurn.length && e.message.id) {
        const n = (acc.callsPerMsg.get(e.message.id) || 0) + callsThisTurn.length;
        acc.callsPerMsg.set(e.message.id, n);
        if (n === 2) acc.parallelTurns++; // 2개째가 관찰된 시점에 1회로 집계
      }
      for (const b of callsThisTurn) {
        const name = String(b.name || "unknown").slice(0, 80);
        acc.toolCalls[name] = (acc.toolCalls[name] || 0) + 1;
        acc.toolTotal++;
        const cat = toolCategory(name);
        acc.toolCats[cat] = (acc.toolCats[cat] || 0) + 1;
        if (name.startsWith("mcp__")) {
          const server = name.split("__")[1] || "unknown";
          acc.mcpServerCalls[server] = (acc.mcpServerCalls[server] || 0) + 1;
        }
        const p = (b.input && (b.input.file_path || b.input.path || b.input.notebook_path)) || "";
        if (p) {
          const m = String(p).match(/(\.[A-Za-z0-9]{1,10})$/);
          const ext = m ? m[1].toLowerCase() : null;
          if (ext && LANG[ext]) {
            acc.exts[ext] = (acc.exts[ext] || 0) + 1;
            proj.langs[ext] = (proj.langs[ext] || 0) + 1;
          }
          if (name === "Read") acc.fileTouches.read++;
          else if (name === "Edit" || name === "NotebookEdit") acc.fileTouches.edited++;
          else if (name === "Write") acc.fileTouches.created++;
        }
      }

      // 토큰
      const u = e.message.usage;
      if (!u || !e.timestamp) continue;
      const model = String(e.message.model || "claude").slice(0, 128);
      if (model.includes("synthetic")) continue;
      const dedup = (e.message.id || "") + ":" + (e.requestId || e.uuid || "");
      if (dedup !== ":" && seen.has(dedup)) continue;
      seen.add(dedup);
      const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const outTok = u.output_tokens || 0;
      acc.assistantTurns++;
      proj.tokens += inTok + outTok;
      proj.days.add(d);
      addUsage(acc, "claude-code", d, model, inTok, outTok);
    }
  }
  return files;
}

// ── Codex / Gemini (토큰·모델만 — 도구 수준 로그가 없음) ────
function scanCodex(cutoff, acc) {
  const base = path.join(os.homedir(), ".codex", "sessions");
  let files = 0;
  for (const file of walkFiles(base, ".jsonl")) {
    files++;
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    let model = "codex", prev = null;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const p = e.payload || e;
      if (p && p.type === "turn_context" && p.model) model = String(p.model).slice(0, 128);
      const info = p && p.info;
      const usage = (info && (info.last_token_usage || info.total_token_usage)) ||
                    (p && p.type === "token_count" && p.usage) || null;
      if (!usage) continue;
      const d = day(e.timestamp || e.ts);
      if (!d || d < cutoff) continue;
      let inTok = (usage.input_tokens || 0) + (usage.cached_input_tokens || 0);
      let outTok = usage.output_tokens || 0;
      if (info && info.total_token_usage && !info.last_token_usage) {
        const t = info.total_token_usage;
        const cur = { i: (t.input_tokens || 0) + (t.cached_input_tokens || 0), o: t.output_tokens || 0 };
        inTok = Math.max(0, cur.i - (prev ? prev.i : 0));
        outTok = Math.max(0, cur.o - (prev ? prev.o : 0));
        prev = cur;
      }
      if (inTok || outTok) addUsage(acc, "codex", d, model, inTok, outTok);
    }
  }
  return files;
}
function scanGemini(cutoff, acc) {
  const base = path.join(os.homedir(), ".gemini", "tmp");
  let files = 0;
  const num = (t, keys) => { for (const k of keys) { const v = t[k]; if (typeof v === "number" && v > 0) return Math.floor(v); } return 0; };
  const handle = (msg, fallbackDay, fallbackModel) => {
    if (!msg || msg.type !== "gemini" || !msg.tokens) return;
    const t = msg.tokens;
    const input = num(t, ["input", "prompt", "input_tokens", "prompt_tokens"]);
    const output = num(t, ["output", "candidates", "output_tokens", "candidates_tokens"]) +
                   num(t, ["thoughts", "reasoning"]) + num(t, ["tool", "tool_tokens"]);
    if (!input && !output) return;
    const d = day(msg.timestamp) || fallbackDay;
    if (!d || d < cutoff) return;
    addUsage(acc, "gemini", d, String(msg.model || fallbackModel || "gemini").slice(0, 128), input, output);
  };
  for (const ext of [".json", ".jsonl"]) {
    for (const file of walkFiles(base, ext)) {
      files++;
      let content; try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
      let fallbackDay = "";
      try { fallbackDay = fs.statSync(file).mtime.toISOString().slice(0, 10); } catch {}
      if (ext === ".json") {
        let rec; try { rec = JSON.parse(content); } catch { continue; }
        const d = day(rec.startTime || rec.lastUpdated) || fallbackDay;
        if (Array.isArray(rec.messages)) rec.messages.forEach((m) => handle(m, d, rec.model));
        else handle(rec, d, rec.model);
      } else {
        for (const line of content.split("\n")) {
          if (!line.includes('"tokens"')) continue;
          try { handle(JSON.parse(line), fallbackDay); } catch {}
        }
      }
    }
  }
  return files;
}

function addUsage(acc, source, d, model, inTok, outTok) {
  if (!d) return;
  acc.tokens.input += inTok;
  acc.tokens.output += outTok;
  const s = acc.bySource[source] || (acc.bySource[source] = { tokens: 0, days: new Set() });
  s.tokens += inTok + outTok;
  s.days.add(d);
  const m = acc.models[model] || (acc.models[model] = { tokens: 0, first: d, last: d });
  m.tokens += inTok + outTok;
  if (d < m.first) m.first = d;
  if (d > m.last) m.last = d;
  acc.byDay[d] = (acc.byDay[d] || 0) + inTok + outTok;
}

// ── 확장 신호 (~/.claude 설정) ──────────────────────────────
function scanExtensions(acc) {
  const home = os.homedir();
  const out = {
    custom_skills: [], custom_commands: [], custom_agents: [], hooks: [],
    mcp_servers_configured: [], plugins: [],
    subagent_runs: acc.agentIds.size,
    workflow_runs: acc.toolCalls.Workflow || 0,
  };
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")); } catch {}

  // 스킬: 사용 이력(skillUsage) + 로그의 attributionSkill 합산
  const usage = cfg.skillUsage || {};
  const skillCounts = {};
  for (const [id, v] of Object.entries(usage)) skillCounts[id] = (v && v.usageCount) || 0;
  for (const [id, n] of Object.entries(acc.skillCalls)) skillCounts[id] = Math.max(skillCounts[id] || 0, n);
  // authored 판정(휴리스틱): 마켓/번들 스킬 접두사가 아니면 직접 작성한 것으로 본다
  const BUNDLED = /^(anthropic-skills[:@]|claude-)/;
  for (const [id, n] of Object.entries(skillCounts)) {
    out.custom_skills.push({ name: id, invocations: n, authored: !BUNDLED.test(id) });
  }
  out.custom_skills.sort((a, b) => b.invocations - a.invocations);

  for (const [name, v] of Object.entries(cfg.pluginUsage || {})) {
    out.plugins.push({ name, invocations: (v && v.usageCount) || 0 });
  }
  for (const name of Object.keys(cfg.mcpServers || {})) {
    out.mcp_servers_configured.push({ name, scope: "user" });
  }

  // 디렉터리 기반 확장물
  const listDir = (rel, ext) => {
    try {
      return fs.readdirSync(path.join(home, ".claude", rel))
        .filter((f) => f.endsWith(ext)).map((f) => f.replace(ext, ""));
    } catch { return []; }
  };
  out.custom_commands = listDir("commands", ".md").map((name) => ({ name }));
  out.custom_agents = listDir("agents", ".md").map((name) => ({ name }));

  // 훅
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    for (const event of Object.keys(s.hooks || {})) out.hooks.push({ event });
  } catch {}
  return out;
}

// ── 계정 식별 (해시만) ──────────────────────────────────────
function accounts() {
  const home = os.homedir();
  const list = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    const em = j.oauthAccount && j.oauthAccount.emailAddress;
    if (em) list.push({ source: "claude-code", email_hash: sha(em.toLowerCase()) });
  } catch {}
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "google_accounts.json"), "utf8"));
    const em = j.active || (Array.isArray(j.accounts) && j.accounts[0]);
    if (em) list.push({ source: "gemini", email_hash: sha(String(em).toLowerCase()) });
  } catch {}
  return list;
}

// ── Git 커밋 이력 (v1.1) — AI 작업의 실제 산출물 근거 ──────
function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return null; }
}
function scanGit(projList, projByHash, cutoff) {
  const repos = [];
  let email = null;
  try {
    email = execFileSync("git", ["config", "--global", "user.email"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {}
  for (const p of projList) {
    const cwd = projByHash[p.path_hash];
    if (!cwd || !fs.existsSync(path.join(cwd, ".git"))) continue;
    const count = git(cwd, ["rev-list", "--count", "--since=" + cutoff, "HEAD"]);
    if (count === null) continue;
    const commits = parseInt(count, 10) || 0;
    let mine = 0, insertions = 0, deletions = 0, filesChanged = 0;
    if (commits && email) {
      const c = git(cwd, ["rev-list", "--count", "--since=" + cutoff, "--author=" + email, "HEAD"]);
      mine = parseInt(c, 10) || 0;
    }
    if (commits) {
      // --shortstat 합산 (파일·삽입·삭제)
      const stat = git(cwd, ["log", "--since=" + cutoff, "--shortstat", "--pretty=%x00"]);
      if (stat) {
        for (const m of stat.matchAll(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/g)) {
          filesChanged += +m[1] || 0; insertions += +m[2] || 0; deletions += +m[3] || 0;
        }
      }
    }
    repos.push({
      alias: p.alias, commits_in_window: commits, authored_by_subject: mine,
      files_changed: filesChanged, insertions, deletions,
    });
  }
  repos.sort((a, b) => b.commits_in_window - a.commits_in_window);
  return {
    enabled: true,
    author_matched: !!email,
    repos,
    totals: {
      commits: repos.reduce((s, r) => s + r.commits_in_window, 0),
      authored_by_subject: repos.reduce((s, r) => s + r.authored_by_subject, 0),
      insertions: repos.reduce((s, r) => s + r.insertions, 0),
      deletions: repos.reduce((s, r) => s + r.deletions, 0),
      repos: repos.length,
    },
  };
}

// ── 스냅샷 이력 — "지속 업데이트되는 이력서"의 성장 델타 ────
function loadPreviousSnapshot(today) {
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort();
    // 오늘 것은 제외하고 가장 최근 스냅샷
    const prev = files.filter((f) => f.slice(0, 10) < today).pop();
    if (!prev) return null;
    return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, prev), "utf8"));
  } catch { return null; }
}
function saveSnapshot(pack) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const fp = path.join(HISTORY_DIR, pack.window.to + ".json");
    // 이력용 요약만 저장 (팩 전체가 아니라 비교에 쓰는 필드만)
    fs.writeFileSync(fp, JSON.stringify({
      date: pack.window.to, window_days: pack.window.days,
      total_tokens: pack.volume.total_tokens, sessions: pack.volume.sessions,
      active_days: pack.cadence.active_days,
      rubric: Object.fromEntries(Object.entries(pack.rubric)
        .filter(([k]) => k !== "method").map(([k, v]) => [k, v.score])),
      authored_skills: pack.extensions.custom_skills.filter((s) => s.authored).length,
      git_commits: pack.git.totals ? pack.git.totals.commits : 0,
    }), "utf8");
  } catch {}
}
function buildGrowth(pack, prev) {
  if (!prev) return null;
  const d = (a, b) => (typeof a === "number" && typeof b === "number") ? a - b : null;
  const rubricDelta = {};
  for (const [k, v] of Object.entries(pack.rubric)) {
    if (k === "method") continue;
    rubricDelta[k] = d(v.score, prev.rubric && prev.rubric[k]);
  }
  return {
    compared_to: prev.date,
    note: "이전 스냅샷과 동일한 window_days(" + prev.window_days + "→" + pack.window.days + ") 기준 비교 여부를 확인하세요.",
    total_tokens_delta: d(pack.volume.total_tokens, prev.total_tokens),
    active_days_delta: d(pack.cadence.active_days, prev.active_days),
    authored_skills_delta: d(pack.extensions.custom_skills.filter((s) => s.authored).length, prev.authored_skills),
    rubric_delta: rubricDelta,
  };
}

// ── 루브릭 (규칙 기반·결정적) ───────────────────────────────
// 각 축 0~100. LLM이 점수를 지어내지 않도록 MCP가 계산한다.
function scoreRubric(pack) {
  const ex = pack.extensions, wf = pack.workflow, tl = pack.tools;
  const lg = (n, cap) => clamp(Math.log10(1 + Math.max(0, n)) / Math.log10(1 + cap), 0, 1); // 로그 스케일 0~1

  // 자동화: 직접 만든 확장물 + 위임 실행
  const authoredSkills = ex.custom_skills.filter((s) => s.authored).length;
  const automation =
    35 * lg(authoredSkills, 10) +
    20 * lg(ex.custom_commands.length + ex.custom_agents.length + ex.hooks.length, 10) +
    25 * lg(ex.subagent_runs + ex.workflow_runs, 30) +
    20 * lg(wf.delegation_lines, 2000);

  // 컨텍스트 설계: 프롬프트 충실도 + 긴 세션 운용 + 읽기 기반 작업
  const context_design =
    35 * clamp(wf.avg_user_prompt_chars / 400, 0, 1) +
    30 * clamp(wf.avg_turns_per_session / 300, 0, 1) +
    35 * lg(tl.by_category.read || 0, 2000);

  // 도구 확장: MCP 구성·실사용 + 병렬 도구 호출
  const tooling_extension =
    35 * lg(ex.mcp_servers_configured.length, 5) +
    40 * lg((tl.mcp_servers_used || []).reduce((s, m) => s + m.calls, 0), 300) +
    25 * lg(wf.parallel_tool_turns, 500);

  // 검증 습관: 셸 실행량(테스트·확인) + 낮은 실패 방치율은 직접 측정이 어려워
  // "실패를 겪고도 계속 진행한 규모"(회복 경험)로 근사
  const verification =
    45 * lg(tl.by_category.shell || 0, 5000) +
    30 * lg(wf.error_recovery.failed_tool_results, 300) +
    25 * clamp(1 - wf.error_recovery.failure_rate * 4, 0, 1);

  // 비용 효율: 캐시 친화(입력 대비 산출), 프런티어 모델을 쓰되 저비용 모델 병용
  const inTok = pack.volume.input_tokens || 1;
  const cost_efficiency =
    40 * clamp((pack.volume.output_tokens / inTok) * 20, 0, 1) +
    30 * clamp(pack.model_diversity.distinct / 4, 0, 1) +
    30 * pack.model_diversity.frontier_share;

  const scores = { automation, context_design, tooling_extension, verification, cost_efficiency };
  const out = {};
  for (const [k, v] of Object.entries(scores)) out[k] = { score: Math.round(clamp(v, 0, 100)) };
  out.method = "rule-based-v1";
  return out;
}

// ── 하이라이트 (문장화 직전의 사실 카드) ────────────────────
function buildHighlights(pack) {
  const h = [];
  const ex = pack.extensions;
  const authored = ex.custom_skills.filter((s) => s.authored);
  if (authored.length >= 2) {
    const calls = authored.reduce((s, x) => s + x.invocations, 0);
    h.push({ kind: "custom_skill_author",
      fact: "업무 전용 커스텀 스킬 " + authored.length + "종을 직접 작성해 총 " + calls + "회 활용",
      evidence: ["extensions.custom_skills"] });
  }
  if (ex.mcp_servers_configured.length) {
    h.push({ kind: "mcp_user",
      fact: "MCP 서버 " + ex.mcp_servers_configured.length + "개를 직접 구성해 사용",
      evidence: ["extensions.mcp_servers_configured"] });
  }
  if (ex.subagent_runs >= 5) {
    h.push({ kind: "delegation",
      fact: "서브에이전트 " + ex.subagent_runs + "회 실행 — 작업 분해·위임 경험",
      evidence: ["extensions.subagent_runs"] });
  }
  if (pack.cadence.longest_streak_days >= 5) {
    h.push({ kind: "consistency",
      fact: "최장 " + pack.cadence.longest_streak_days + "일 연속 사용, 기간 중 " +
        pack.cadence.active_days + "일 활동",
      evidence: ["cadence"] });
  }
  if (pack.git.enabled && pack.git.totals.commits > 0) {
    const g = pack.git.totals;
    h.push({ kind: "shipped_output",
      fact: "기간 중 작업 레포 " + g.repos + "곳에서 커밋 " + g.commits + "건" +
        (g.authored_by_subject ? " (본인 작성 " + g.authored_by_subject + "건)" : "") +
        " — +" + g.insertions.toLocaleString() + "/-" + g.deletions.toLocaleString() + " 라인",
      evidence: ["git.totals"] });
  }
  const multi = pack.volume.by_source.length;
  if (multi >= 2) {
    h.push({ kind: "multi_tool",
      fact: multi + "개 AI CLI(" + pack.volume.by_source.map((s) => s.source).join("·") + ") 병용",
      evidence: ["volume.by_source"] });
  }
  if (pack.stack.languages.length >= 3) {
    h.push({ kind: "stack",
      fact: "주력 스택: " + pack.stack.languages.slice(0, 5).map((l) => l.label)
        .filter((v, i, a) => a.indexOf(v) === i).join(", "),
      evidence: ["stack.languages"] });
  }
  return h;
}

// ── 메인 ────────────────────────────────────────────────────
function buildEvidence(opts) {
  opts = opts || {};
  const days = clamp(parseInt(opts.days, 10) || 90, 7, 365);
  const redactProjects = opts.reveal_projects ? "reveal" : "alias";
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);

  const acc = {
    tokens: { input: 0, output: 0 }, bySource: {}, models: {}, byDay: {},
    sessions: new Set(), assistantTurns: 0, userMsgs: 0, userChars: 0,
    toolCalls: {}, toolTotal: 0, toolCats: {}, mcpServerCalls: {},
    toolResults: 0, toolFailures: 0, parallelTurns: 0,
    exts: {}, fileTouches: { read: 0, edited: 0, created: 0 },
    projects: {}, clientVersions: new Set(), permissionModes: {}, efforts: {},
    skillCalls: {}, sidechainLines: 0, agentIds: new Set(), callsPerMsg: new Map(),
  };

  const ccFiles = scanClaudeCode(cutoff, acc);
  const cxFiles = scanCodex(cutoff, acc);
  const gmFiles = scanGemini(cutoff, acc);

  // cadence
  const activeDays = Object.keys(acc.byDay).sort();
  const weekly = {};
  for (const [d, t] of Object.entries(acc.byDay)) {
    const wk = isoWeek(d);
    const w = weekly[wk] || (weekly[wk] = { week: wk, tokens: 0, active_days: 0 });
    w.tokens += t; w.active_days++;
  }
  let streak = 0, best = 0, prevDay = null;
  for (const d of activeDays) {
    const cur = new Date(d + "T00:00:00Z").getTime();
    streak = prevDay && cur - prevDay === 86400000 ? streak + 1 : 1;
    best = Math.max(best, streak);
    prevDay = cur;
  }
  const busiest = Object.entries(acc.byDay).sort((a, b) => b[1] - a[1])[0];

  // models
  const totalTokens = acc.tokens.input + acc.tokens.output;
  const models = Object.entries(acc.models)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([model, m]) => ({
      model, tokens: m.tokens, share: totalTokens ? round(m.tokens / totalTokens) : 0,
      first_seen: m.first, last_seen: m.last,
    }));
  const frontierTokens = models.filter((m) => FRONTIER.test(m.model)).reduce((s, m) => s + m.tokens, 0);

  // stack
  const languages = Object.entries(acc.exts)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, touches]) => ({ ext, touches, label: LANG[ext] || ext }));
  const domainScore = {};
  for (const l of languages) {
    const dom = DOMAIN[l.label];
    if (dom) domainScore[dom] = (domainScore[dom] || 0) + l.touches;
  }

  // projects
  const projByHash = {};
  const projList = Object.values(acc.projects)
    .filter((p) => p.tokens > 0 || p.sessions.size > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((p, i) => {
      projByHash[sha(p.cwd || p.key)] = p.cwd;
      const o = {
        alias: "project-" + (i < 26 ? String.fromCharCode(65 + i) : String(i + 1)),
        path_hash: sha(p.cwd || p.key),
        sessions: p.sessions.size, tokens: p.tokens, active_days: p.days.size,
        primary_languages: Object.entries(p.langs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e),
        git: { branches_seen: [...p.branches].filter((b) => b !== "HEAD").slice(0, 5) },
      };
      if (redactProjects === "reveal") o.path = p.cwd;
      return o;
    });

  const extensions = scanExtensions(acc);
  const failureRate = acc.toolResults ? round(acc.toolFailures / acc.toolResults) : 0;

  const pack = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    window: { from: cutoff, to: now.toISOString().slice(0, 10), days },
    redaction: { projects: redactProjects, accounts: "hash", raw_text: "never" },
    subject: { accounts: accounts() },

    sources: [
      { id: "claude-code", detected: ccFiles > 0, log_files: ccFiles,
        client_versions: [...acc.clientVersions].sort() },
      { id: "codex", detected: cxFiles > 0, log_files: cxFiles },
      { id: "gemini", detected: gmFiles > 0, log_files: gmFiles },
    ],

    volume: {
      total_tokens: totalTokens, input_tokens: acc.tokens.input, output_tokens: acc.tokens.output,
      sessions: acc.sessions.size, assistant_turns: acc.assistantTurns, user_turns: acc.userMsgs,
      by_source: Object.entries(acc.bySource).map(([source, s]) => ({
        source, tokens: s.tokens, active_days: s.days.size,
      })),
    },

    cadence: {
      active_days: activeDays.length, span_days: days,
      consistency: round(activeDays.length / days),
      longest_streak_days: best,
      busiest_day: busiest ? { day: busiest[0], tokens: busiest[1] } : null,
      weekly_tokens: Object.values(weekly).sort((a, b) => a.week.localeCompare(b.week)),
    },

    models: models.slice(0, 15),
    model_diversity: {
      distinct: models.length,
      frontier_share: totalTokens ? round(frontierTokens / totalTokens) : 0,
    },

    tools: {
      total_calls: acc.toolTotal,
      by_name: topN(acc.toolCalls, 20, "name", "calls").map((t) => ({
        name: t.name, calls: t.calls,
        share: acc.toolTotal ? round(t.calls / acc.toolTotal) : 0,
      })),
      by_category: acc.toolCats,
      edit_to_read_ratio: acc.toolCats.read ? round((acc.toolCats.edit || 0) / acc.toolCats.read, 2) : null,
      mcp_servers_used: topN(acc.mcpServerCalls, 10, "server", "calls"),
    },

    extensions,

    workflow: {
      permission_modes: acc.permissionModes,
      effort_levels: acc.efforts,
      error_recovery: {
        failed_tool_results: acc.toolFailures, total_tool_results: acc.toolResults,
        failure_rate: failureRate,
      },
      avg_user_prompt_chars: acc.userMsgs ? Math.round(acc.userChars / acc.userMsgs) : 0,
      avg_turns_per_session: acc.sessions.size ? round(acc.assistantTurns / acc.sessions.size, 1) : 0,
      parallel_tool_turns: acc.parallelTurns,
      delegation_lines: acc.sidechainLines,
    },

    stack: {
      languages: languages.slice(0, 15),
      file_touches: acc.fileTouches,
      domains: Object.entries(domainScore).sort((a, b) => b[1] - a[1]).map(([d]) => d),
    },

    projects: projList,

    git: { enabled: false, repos: [], totals: { commits: 0, repos: 0 } },

    caveats: [],
  };

  // git 커밋 이력 (기본 켜짐, include_git=false로 끌 수 있음)
  if (opts.include_git !== false) {
    try { pack.git = scanGit(pack.projects, projByHash, cutoff); } catch {}
  }

  pack.rubric = scoreRubric(pack);
  pack.highlights = buildHighlights(pack);

  // 성장 델타 (이전 스냅샷 대비) + 오늘 스냅샷 저장
  pack.growth = buildGrowth(pack, loadPreviousSnapshot(pack.window.to));
  saveSnapshot(pack);

  for (const s of pack.sources) {
    if (!s.detected) pack.caveats.push(s.id + " 로그 없음 — 해당 도구 사용 이력은 반영되지 않았습니다.");
  }
  if (cxFiles || gmFiles) pack.caveats.push("codex·gemini는 토큰·모델만 집계됩니다(도구 수준 로그 미제공) — 도구·확장 지표는 Claude Code 기준입니다.");
  pack.caveats.push("로그 보존 정책상 window 이전 기록은 유실되었을 수 있어, 실제 사용량보다 과소 집계일 수 있습니다.");
  pack.caveats.push("실패율은 도구 결과 텍스트 패턴 기반 추정치입니다.");

  return pack;
}

module.exports = { buildEvidence, SCHEMA_VERSION };
