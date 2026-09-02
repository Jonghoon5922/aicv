"""AICV 포탈 — 증거 기반 AI 활용 능력 이력서 공개 프로필.

FastAPI + SQLite 단일 파일 서버.
로그인은 tokenbill과 동일: JWT + bcrypt, GOOGLE_CLIENT_ID 설정 시 구글 로그인,
AUTH_GOOGLE_ONLY=1 이면 구글 전용.

흐름:
  aicv-mcp (로컬) → POST /api/evidence (X-Upload-Token) → /r/<핸들> 공개 프로필
"""
import html
import json
import os
import re
import secrets
from datetime import datetime, timedelta
from pathlib import Path

import bcrypt as _bcrypt
import httpx
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import (Boolean, Column, DateTime, ForeignKey, Integer,
                        String, Text, create_engine)
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# ── 설정 ────────────────────────────────────────────────────
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
JWT_ALG = "HS256"
TOKEN_TTL_HOURS = 24 * 14
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
AUTH_GOOGLE_ONLY = os.environ.get("AUTH_GOOGLE_ONLY", "") == "1"
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./aicv.db")
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# ── DB ──────────────────────────────────────────────────────
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False}
                       if DATABASE_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True, nullable=False)
    password_hash = Column(String)  # 구글 가입이면 없음
    handle = Column(String, unique=True)  # 공개 프로필 URL용
    is_public = Column(Boolean, default=False)
    upload_token = Column(String, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class Evidence(Base):
    __tablename__ = "evidence"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    date = Column(String, nullable=False)  # pack.window.to (YYYY-MM-DD)
    pack = Column(Text, nullable=False)    # 증거 팩 JSON 원문
    uploaded_at = Column(DateTime, default=datetime.utcnow)


class Resume(Base):
    __tablename__ = "resumes"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    format = Column(String, nullable=False, default="full")
    markdown = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow)


Base.metadata.create_all(engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── 인증 (tokenbill과 동일 방식) ────────────────────────────
bearer = HTTPBearer(auto_error=False)


def hash_password(pw: str) -> str:
    return _bcrypt.hashpw(pw.encode()[:72], _bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return _bcrypt.checkpw(pw.encode()[:72], (hashed or "").encode())
    except ValueError:
        return False


def create_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": datetime.utcnow() + timedelta(hours=TOKEN_TTL_HOURS)}
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                 db: Session = Depends(get_db)) -> User:
    if creds is None:
        raise HTTPException(401, "로그인이 필요합니다")
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[JWT_ALG])
        user_id = int(payload["sub"])
    except Exception:
        raise HTTPException(401, "유효하지 않은 토큰입니다")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(401, "사용자를 찾을 수 없습니다")
    return user


def uploader_user(x_upload_token: str | None = Header(None),
                  db: Session = Depends(get_db)) -> User:
    user = (db.query(User).filter_by(upload_token=x_upload_token).first()
            if x_upload_token else None)
    if user is None:
        raise HTTPException(401, "유효하지 않은 업로드 토큰입니다 — 포탈에서 토큰을 발급받으세요")
    return user


# ── 앱 ──────────────────────────────────────────────────────
app = FastAPI(title="AICV", docs_url="/docs")


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class GoogleAuthIn(BaseModel):
    credential: str = Field(min_length=20, max_length=4096)


class MeIn(BaseModel):
    handle: str | None = Field(None, min_length=3, max_length=30)
    is_public: bool | None = None


class ResumeIn(BaseModel):
    format: str = Field("full", pattern="^(full|career|skills|github)$")
    markdown: str = Field(min_length=10, max_length=200_000)


@app.get("/api/auth/config")
def auth_config():
    return {"google_client_id": GOOGLE_CLIENT_ID or None,
            "google_only": bool(AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID)}


@app.post("/api/auth/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    if AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID:
        raise HTTPException(403, "구글 로그인만 사용할 수 있습니다")
    if db.query(User).filter_by(email=body.email.lower()).first():
        raise HTTPException(409, "이미 가입된 이메일입니다")
    user = User(email=body.email.lower(), password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    return {"token": create_token(user.id)}


@app.post("/api/auth/login")
def login(body: RegisterIn, db: Session = Depends(get_db)):
    if AUTH_GOOGLE_ONLY and GOOGLE_CLIENT_ID:
        raise HTTPException(403, "구글 로그인만 사용할 수 있습니다")
    user = db.query(User).filter_by(email=body.email.lower()).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "이메일 또는 비밀번호가 올바르지 않습니다")
    return {"token": create_token(user.id)}


@app.post("/api/auth/google")
def google_login(body: GoogleAuthIn, db: Session = Depends(get_db)):
    """Google Identity Services ID 토큰 검증 → 이메일 기준 자동 가입/로그인."""
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(400, "구글 로그인이 설정되지 않았습니다")
    try:
        r = httpx.get("https://oauth2.googleapis.com/tokeninfo",
                      params={"id_token": body.credential}, timeout=10)
        info = r.json()
    except Exception:
        raise HTTPException(502, "구글 토큰 검증에 실패했습니다")
    if info.get("aud") != GOOGLE_CLIENT_ID or info.get("email_verified") not in ("true", True):
        raise HTTPException(401, "유효하지 않은 구글 계정입니다")
    email = info["email"].lower()
    user = db.query(User).filter_by(email=email).first()
    if user is None:
        user = User(email=email)
        db.add(user)
        db.commit()
    return {"token": create_token(user.id)}


# ── 내 계정 ─────────────────────────────────────────────────
HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")
RESERVED = {"api", "docs", "r", "admin", "static", "www", "aicv"}


@app.get("/api/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    ev = (db.query(Evidence).filter_by(user_id=user.id)
          .order_by(Evidence.date.desc()).first())
    return {
        "email": user.email, "handle": user.handle, "is_public": user.is_public,
        "upload_token": user.upload_token,
        "last_evidence": ev.date if ev else None,
        "profile_url": f"/r/{user.handle}" if user.handle else None,
    }


@app.patch("/api/me")
def update_me(body: MeIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if body.handle is not None:
        h = body.handle.lower()
        if not HANDLE_RE.match(h) or h in RESERVED:
            raise HTTPException(400, "핸들은 3~30자 영소문자·숫자·하이픈만 가능합니다")
        taken = db.query(User).filter(User.handle == h, User.id != user.id).first()
        if taken:
            raise HTTPException(409, "이미 사용 중인 핸들입니다")
        user.handle = h
    if body.is_public is not None:
        if body.is_public and not user.handle:
            raise HTTPException(400, "공개하려면 먼저 핸들을 설정하세요")
        user.is_public = body.is_public
    db.commit()
    return {"handle": user.handle, "is_public": user.is_public}


@app.post("/api/uploader/token")
def issue_token(user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.upload_token = "acv_" + secrets.token_urlsafe(24)
    db.commit()
    return {"upload_token": user.upload_token}


# ── 업로드 (MCP → 서버) ─────────────────────────────────────
@app.post("/api/evidence")
def upload_evidence(pack: dict, user: User = Depends(uploader_user),
                    db: Session = Depends(get_db)):
    if pack.get("schema_version") != 1:
        raise HTTPException(400, "지원하지 않는 schema_version 입니다")
    # 프라이버시: 실경로가 포함된 팩은 서버에 받지 않는다
    red = pack.get("redaction") or {}
    if red.get("projects") == "reveal" or any("path" in p for p in pack.get("projects", [])):
        raise HTTPException(400, "실제 경로가 포함된 팩은 업로드할 수 없습니다 (reveal_projects=false로 다시 수집하세요)")
    date = ((pack.get("window") or {}).get("to") or "")[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        raise HTTPException(400, "window.to 날짜가 올바르지 않습니다")
    raw = json.dumps(pack, ensure_ascii=False)
    if len(raw) > 1_000_000:
        raise HTTPException(413, "팩이 너무 큽니다 (1MB 제한)")
    row = db.query(Evidence).filter_by(user_id=user.id, date=date).first()
    if row:
        row.pack, row.uploaded_at = raw, datetime.utcnow()
    else:
        db.add(Evidence(user_id=user.id, date=date, pack=raw))
    # 스냅샷 이력 90개 초과 시 오래된 것 정리
    old = (db.query(Evidence).filter_by(user_id=user.id)
           .order_by(Evidence.date.desc()).offset(90).all())
    for o in old:
        db.delete(o)
    db.commit()
    return {"ok": True, "date": date,
            "profile": f"/r/{user.handle}" if user.handle and user.is_public else None}


@app.post("/api/resume")
def upload_resume(body: ResumeIn, user: User = Depends(uploader_user),
                  db: Session = Depends(get_db)):
    row = db.query(Resume).filter_by(user_id=user.id, format=body.format).first()
    if row:
        row.markdown, row.updated_at = body.markdown, datetime.utcnow()
    else:
        db.add(Resume(user_id=user.id, format=body.format, markdown=body.markdown))
    db.commit()
    return {"ok": True, "format": body.format}


# ── 마크다운 → HTML (제한 렌더러) ───────────────────────────
# 원문을 먼저 전부 이스케이프한 뒤 우리가 아는 구문만 되살린다 — 스크립트 주입 불가.
_INLINE = [
    (re.compile(r"\*\*([^*]+)\*\*"), r"<b>\1</b>"),
    (re.compile(r"(?<!\*)\*([^*]+)\*(?!\*)"), r"<i>\1</i>"),
    (re.compile(r"`([^`]+)`"), r"<code>\1</code>"),
    # 링크는 http(s)만 허용 (이스케이프 후라 따옴표 주입 불가)
    (re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)"),
     r'<a href="\2" rel="noopener nofollow" target="_blank">\1</a>'),
]


def _inline(s: str) -> str:
    for pat, rep in _INLINE:
        s = pat.sub(rep, s)
    return s


def md_to_html(md: str) -> str:
    lines = html.escape(md).replace("\r\n", "\n").split("\n")
    out, i, n = [], 0, len(lines)
    in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    while i < n:
        line = lines[i]
        s = line.strip()
        if s.startswith("```"):
            close_list()
            block = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            out.append("<pre>" + "\n".join(block) + "</pre>")
        elif s.startswith("|") and i + 1 < n and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            close_list()
            header = [c.strip() for c in s.strip("|").split("|")]
            out.append("<table><thead><tr>" +
                       "".join(f"<th>{_inline(c)}</th>" for c in header) +
                       "</tr></thead><tbody>")
            i += 2
            while i < n and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in cells) + "</tr>")
                i += 1
            out.append("</tbody></table>")
            continue
        elif s.startswith("###"):
            close_list()
            out.append(f"<h4>{_inline(s.lstrip('#').strip())}</h4>")
        elif s.startswith("##"):
            close_list()
            out.append(f"<h3>{_inline(s.lstrip('#').strip())}</h3>")
        elif s.startswith("#"):
            close_list()
            out.append(f"<h2>{_inline(s.lstrip('#').strip())}</h2>")
        elif s.startswith("&gt;"):
            close_list()
            quote = []
            while i < n and lines[i].strip().startswith("&gt;"):
                quote.append(_inline(lines[i].strip()[4:].strip()))
                i += 1
            out.append("<blockquote>" + "<br>".join(quote) + "</blockquote>")
            continue
        elif re.match(r"^[-*] ", s):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{_inline(s[2:])}</li>")
        elif re.match(r"^([-*_])\1\1+$", s):
            close_list()
            out.append("<hr>")
        elif s:
            close_list()
            out.append(f"<p>{_inline(s)}</p>")
        i += 1
    close_list()
    return "\n".join(out)


# ── 공개 프로필 ─────────────────────────────────────────────
RUBRIC_LABEL = {
    "verification": "검증 습관", "context_design": "컨텍스트 설계",
    "automation": "자동화", "tooling_extension": "도구 확장",
    "cost_efficiency": "비용 효율",
}


def _fmt_tok(n: int) -> str:
    if n >= 1_000_000_000:
        return f"{n / 1e9:.1f}B"
    if n >= 1_000_000:
        return f"{n / 1e6:.1f}M"
    return f"{n:,}"


@app.get("/r/{handle}", response_class=HTMLResponse)
def profile(handle: str, db: Session = Depends(get_db)):
    user = db.query(User).filter_by(handle=handle.lower(), is_public=True).first()
    if user is None:
        raise HTTPException(404, "공개된 프로필이 없습니다")
    rows = (db.query(Evidence).filter_by(user_id=user.id)
            .order_by(Evidence.date.desc()).limit(30).all())
    if not rows:
        raise HTTPException(404, "아직 업로드된 데이터가 없습니다")
    pack = json.loads(rows[0].pack)
    # 가장 최근에 업로드된 이력서를 표시 (양식 무관 — 마지막 발행이 곧 현재 이력서)
    resume = (db.query(Resume).filter_by(user_id=user.id)
              .order_by(Resume.updated_at.desc()).first())

    e = html.escape
    rubric = pack.get("rubric", {})
    bars = ""
    for key, label in RUBRIC_LABEL.items():
        sc = (rubric.get(key) or {}).get("score", 0)
        bars += (f'<div class="row"><span class="lb">{label}</span>'
                 f'<div class="bar"><div class="fill" style="width:{sc}%"></div></div>'
                 f'<span class="sc">{sc}</span></div>')

    # 하이라이트는 이력서 작성용 내부 원료 — 프로필에는 노출하지 않는다 (이력서 본문과 중복·맥락 없는 수치)
    caveats = "".join(f'<li>{e(c)}</li>' for c in pack.get("caveats", []))

    # 직접 만든 자동화 자산 — "쓰는 사람"이 아니라 "만들어 쓰는 사람"임을 목록으로 보여주는 구간
    ext = pack.get("extensions") or {}
    authored = [s for s in ext.get("custom_skills", []) if s.get("authored")]
    mcp_servers = ext.get("mcp_servers_configured", [])
    assets = ""
    if authored or mcp_servers:
        parts = []
        if authored:
            total_inv = sum(s.get("invocations", 0) for s in authored)
            window_d = pack.get("window", {}).get("days", 90)
            pills = "".join(
                f'<span class="pill">{e(s["name"])}<em>×{s.get("invocations", 0):,}</em></span>'
                for s in authored[:12])
            parts.append(
                f'<p class="asset-lead">반복 업무를 프롬프트가 아닌 재사용 도구로 만들어 씁니다 — '
                f'커스텀 스킬 <b>{len(authored)}종</b>을 직접 작성, '
                f'{window_d}일간 <b>{total_inv:,}회</b> 실전 투입.</p>'
                f'<div class="pills">{pills}</div>')
        if mcp_servers:
            names = "".join(f'<span class="pill mcp">{e(s.get("name", ""))}</span>' for s in mcp_servers[:8])
            parts.append(
                f'<p class="asset-lead">MCP 서버 <b>{len(mcp_servers)}개</b>를 직접 개발·구성해 운영합니다.</p>'
                f'<div class="pills">{names}</div>')
        assets = ('<div class="sec"><h2>직접 만든 자동화 자산</h2>' + "".join(parts) + "</div>")

    # 성장 그래프: 스냅샷 시계열 (날짜별 rubric 평균)
    series = []
    for r in reversed(rows):
        try:
            pk = json.loads(r.pack)
            scores = [v.get("score", 0) for k, v in pk.get("rubric", {}).items()
                      if isinstance(v, dict)]
            if scores:
                series.append((r.date, round(sum(scores) / len(scores))))
        except Exception:
            pass
    spark = ""
    if len(series) >= 2:
        pts = " ".join(f"{i * (300 / (len(series) - 1)):.0f},{60 - s * 0.6:.0f}"
                       for i, (_, s) in enumerate(series))
        spark = (f'<div class="sec"><h2>성장 추이 <small>(rubric 평균, {e(series[0][0])} ~ '
                 f'{e(series[-1][0])})</small></h2>'
                 f'<svg viewBox="0 0 300 64" class="spark"><polyline points="{pts}"/></svg></div>')

    vol = pack.get("volume", {})
    # 커밋 카드는 git 커버리지가 로컬 .git 보유 레포에 한정돼 과소집계 — 커버리지 개선 전까지 미노출
    stats = [
        ("토큰", _fmt_tok(vol.get("total_tokens", 0))),
        ("세션", f"{vol.get('sessions', 0)}"),
        ("활동일", f"{pack.get('cadence', {}).get('active_days', 0)}일"),
    ]
    stat_html = "".join(f'<div class="stat"><b>{v}</b><span>{k}</span></div>' for k, v in stats)

    md = ""
    if resume:
        md = f'<div class="sec md-body"><h2>이력서</h2>{md_to_html(resume.markdown)}</div>'

    win = pack.get("window", {})
    # OG 설명: 상위 rubric 2축 + 핵심 규모
    top2 = sorted(((RUBRIC_LABEL.get(k, k), (v or {}).get("score", 0))
                   for k, v in rubric.items() if k != "method"),
                  key=lambda x: -x[1])[:2]
    og_desc = (" · ".join(f"{lb} {sc}" for lb, sc in top2) +
               f" | {_fmt_tok(vol.get('total_tokens', 0))} 토큰 · "
               f"{pack.get('cadence', {}).get('active_days', 0)}일 활동 — "
               "로컬 AI 사용 로그로 증명된 AI 활용 능력")
    og_url = f"https://aicv.tokenbill.my/r/{user.handle}"
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(user.handle)} — AICV</title>
<meta name="description" content="{e(og_desc)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="AICV">
<meta property="og:title" content="{e(user.handle)}의 AI 활용 능력 — AICV">
<meta property="og:description" content="{e(og_desc)}">
<meta property="og:url" content="{e(og_url)}">
<meta property="og:locale" content="ko_KR">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{e(user.handle)}의 AI 활용 능력 — AICV">
<meta name="twitter:description" content="{e(og_desc)}">
<link rel="canonical" href="{e(og_url)}">
<style>
body{{font-family:'Segoe UI',Pretendard,sans-serif;max-width:720px;margin:0 auto;
 padding:32px 20px;background:#0f1117;color:#e6e8ee}}
a{{color:#7aa2ff}} h1{{margin:0 0 4px}} small{{color:#8b90a0;font-weight:400}}
.badge{{display:inline-block;background:#1d2333;border:1px solid #2e3650;color:#9fb4ff;
 border-radius:20px;padding:2px 12px;font-size:13px;margin:6px 0}}
.stats{{display:flex;gap:12px;margin:20px 0;flex-wrap:wrap}}
.stat{{background:#171b26;border:1px solid #242b3d;border-radius:10px;padding:12px 18px;
 display:flex;flex-direction:column;min-width:90px}}
.stat b{{font-size:20px}} .stat span{{color:#8b90a0;font-size:12px}}
.sec{{margin:28px 0}} h2{{font-size:17px;border-bottom:1px solid #242b3d;padding-bottom:6px}}
.row{{display:flex;align-items:center;gap:10px;margin:8px 0}}
.lb{{width:110px;font-size:14px;color:#aab}} .sc{{width:32px;text-align:right;font-weight:600}}
.bar{{flex:1;height:10px;background:#1d2333;border-radius:6px;overflow:hidden}}
.fill{{height:100%;background:linear-gradient(90deg,#5b7bff,#8f6bff);border-radius:6px}}
ul{{padding-left:20px}} li{{margin:6px 0}}
.spark{{width:100%;height:64px}} .spark polyline{{fill:none;stroke:#7aa2ff;stroke-width:2}}
.md-body{{background:#171b26;border:1px solid #242b3d;border-radius:10px;padding:6px 20px 16px;
 font-size:14px;line-height:1.7}}
.md-body>h2{{margin:14px -20px 10px;padding:0 20px 6px}}
.md-body h2:not(:first-child),.md-body h3{{font-size:16px;margin:20px 0 8px;color:#cdd3e0;
 border:0;padding:0}}
.md-body h4{{font-size:14px;margin:14px 0 6px}}
.md-body blockquote{{margin:10px 0;padding:8px 14px;border-left:3px solid #5b7bff;
 background:#131722;border-radius:0 8px 8px 0;color:#9aa1b5;font-size:13px}}
.md-body table{{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px;display:block;
 overflow-x:auto}}
.md-body th,.md-body td{{border:1px solid #242b3d;padding:6px 10px;text-align:left}}
.md-body th{{background:#1d2333}}
.md-body code{{background:#0f1117;border:1px solid #242b3d;border-radius:4px;padding:1px 5px;
 font-size:12px}}
.md-body pre{{background:#0f1117;border:1px solid #242b3d;border-radius:8px;padding:12px;
 overflow-x:auto;font-size:12px}}
.md-body hr{{border:0;border-top:1px solid #242b3d;margin:16px 0}}
.md-body p{{margin:8px 0}}
.caveat li{{color:#8b90a0;font-size:13px}}
.asset-lead{{margin:12px 0 8px;font-size:14px;color:#c3c9d8}}
.pills{{display:flex;flex-wrap:wrap;gap:8px}}
.pill{{background:#1d2333;border:1px solid #2e3650;border-radius:16px;padding:4px 12px;
 font-size:13px;color:#cdd6f4}}
.pill em{{font-style:normal;color:#7aa2ff;margin-left:6px;font-size:12px}}
.pill.mcp{{border-color:#3d3163;background:#221d33;color:#d8ccf4}}
footer{{margin-top:40px;color:#8b90a0;font-size:13px;border-top:1px solid #242b3d;padding-top:14px}}
</style></head><body>
<h1>{e(user.handle)} <small>의 AI 활용 능력</small></h1>
<div class="badge">🔍 로컬 사용 로그 기반 · {e(win.get('from', ''))} ~ {e(win.get('to', ''))} · schema v{pack.get('schema_version', 1)}</div>
<div class="stats">{stat_html}</div>
{assets}
<div class="sec"><h2>역량 프로파일 <small>(규칙 기반, 0~100)</small></h2>{bars}</div>
{spark}
{md}
<div class="sec caveat"><h2>데이터 한계</h2><ul>{caveats}</ul></div>
<footer>AICV — 실제 작업 로그가 역량을 증명합니다 · <a href="/">나도 만들기</a></footer>
</body></html>"""


# ── 정적 파일 ───────────────────────────────────────────────
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")
