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
    resume = (db.query(Resume).filter_by(user_id=user.id, format="full")
              .order_by(Resume.updated_at.desc()).first())

    e = html.escape
    rubric = pack.get("rubric", {})
    bars = ""
    for key, label in RUBRIC_LABEL.items():
        sc = (rubric.get(key) or {}).get("score", 0)
        bars += (f'<div class="row"><span class="lb">{label}</span>'
                 f'<div class="bar"><div class="fill" style="width:{sc}%"></div></div>'
                 f'<span class="sc">{sc}</span></div>')

    cards = "".join(f'<li>{e(h.get("fact", ""))}</li>' for h in pack.get("highlights", []))
    caveats = "".join(f'<li>{e(c)}</li>' for c in pack.get("caveats", []))

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
    git_t = (pack.get("git") or {}).get("totals") or {}
    stats = [
        ("토큰", _fmt_tok(vol.get("total_tokens", 0))),
        ("세션", f"{vol.get('sessions', 0)}"),
        ("활동일", f"{pack.get('cadence', {}).get('active_days', 0)}일"),
    ]
    if git_t.get("commits"):
        stats.append(("커밋", f"{git_t['commits']}건"))
    stat_html = "".join(f'<div class="stat"><b>{v}</b><span>{k}</span></div>' for k, v in stats)

    md = ""
    if resume:
        # 마크다운은 이스케이프한 본문을 <pre>로 노출 (렌더러 없이 안전하게)
        md = f'<div class="sec"><h2>이력서</h2><pre class="md">{e(resume.markdown)}</pre></div>'

    win = pack.get("window", {})
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(user.handle)} — AICV</title>
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
.md{{white-space:pre-wrap;background:#171b26;border:1px solid #242b3d;border-radius:10px;
 padding:16px;font-size:13px;line-height:1.6;overflow-x:auto}}
.caveat li{{color:#8b90a0;font-size:13px}}
footer{{margin-top:40px;color:#8b90a0;font-size:13px;border-top:1px solid #242b3d;padding-top:14px}}
</style></head><body>
<h1>{e(user.handle)} <small>의 AI 활용 능력</small></h1>
<div class="badge">🔍 로컬 사용 로그 기반 · {e(win.get('from', ''))} ~ {e(win.get('to', ''))} · schema v{pack.get('schema_version', 1)}</div>
<div class="stats">{stat_html}</div>
<div class="sec"><h2>역량 프로파일 <small>(규칙 기반, 0~100)</small></h2>{bars}</div>
<div class="sec"><h2>하이라이트</h2><ul>{cards}</ul></div>
{spark}
{md}
<div class="sec caveat"><h2>데이터 한계</h2><ul>{caveats}</ul></div>
<footer>AICV — 실제 작업 로그가 역량을 증명합니다 · <a href="/">나도 만들기</a></footer>
</body></html>"""


# ── 정적 파일 ───────────────────────────────────────────────
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")
