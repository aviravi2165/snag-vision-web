from fastapi import APIRouter, Depends, HTTPException, status, Header
from sqlalchemy.orm import Session
from typing import List
from models import get_db
from models.database import User, UserRole
from schemas.models import UserCreate, UserOut, Token, LoginIn
from passlib.context import CryptContext
from jose import jwt, JWTError
from datetime import datetime, timedelta
from config import settings

router = APIRouter(prefix="/auth", tags=["auth"])
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 48


def hash_pw(pw: str) -> str:

    return pwd_ctx.hash(pw)


def verify_pw(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


def create_token(user_id: str) -> str:
    exp = datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS)
    return jwt.encode({"sub": user_id, "exp": exp}, settings.SECRET_KEY, ALGORITHM)


def get_current_user(authorization: str = Header(None), db: Session = Depends(get_db)) -> User:
    """Real JWT auth for the web-facing routers — the frontend's axios
    interceptor (api.js) already attaches this header on every request once
    logged in, and every data page is behind ProtectedRoute, so requiring
    this here doesn't change what the frontend sends, only what the server
    now checks."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    user = db.query(User).get(payload.get("sub"))
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found")
    return user


def require_role(*roles: UserRole):
    """Dependency factory: `Depends(require_role(UserRole.admin))` etc.
    Only apply this where the allowed roles are actually known — plain
    `Depends(get_current_user)` (any logged-in user) is the safe default."""
    def _check(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted for this role")
        return user
    return _check


@router.post("/register", response_model=Token, status_code=201)
def register(data: UserCreate, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == data.email).first():
        raise HTTPException(400, "Email already registered")
    user = User(
        name=data.name,
        email=data.email,
        hashed_password=hash_pw(data.password),
        role=data.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return Token(access_token=create_token(user.id), user=UserOut.model_validate(user))


@router.post("/login", response_model=Token)
def login(data: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_pw(data.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    return Token(access_token=create_token(user.id), user=UserOut.model_validate(user))


@router.get("/users", response_model=List[UserOut])
def list_users(db: Session = Depends(get_db), _=Depends(get_current_user)):
    """Directory of users who can be assigned work — backs the Issue
    "Assign Users" picker (routers/issues.py). Login-gated; returns only the
    public UserOut fields (never the password hash)."""
    return db.query(User).order_by(User.name).all()
