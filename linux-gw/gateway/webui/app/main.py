"""Gateway Hub — FastAPI бэкенд.

Адаптировано из server_conf/rpi-config/roles/dashboard/files/app/main.py
для x86 Linux gateway с AmneziaWG.

Маршруты:
  GET  /api/system     — uptime, CPU, RAM, hostname
  GET  /api/network    — интерфейсы WAN/LAN/AWG, скорости
  GET  /api/vpn        — статус AmneziaWG, режим, хэндшейк
  POST /api/vpn/up     — поднять туннель
  POST /api/vpn/down   — опустить туннель
  POST /api/vpn/restart — перезапустить туннель
  POST /api/vpn/mode   — vpn_enable | vpn_disable
  POST /api/vpn/config — загрузить .conf файл
  GET  /api/devices    — DHCP аренды (подключённые устройства)
  GET  /api/logs       — последние строки watchdog.log
  POST /api/login      — авторизация (cookie)
  GET  /logout         — выход
"""
from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import pty
import re
import secrets
import shlex
import shutil
import socket
import struct
import subprocess
import termios
import threading
import time
from pathlib import Path
from typing import Any

import psutil
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# ── Авторизация (cookie-сессия) ──────────────────────────────────
_ENV_USER = os.environ.get("GW_USER", "admin")
_ENV_PASS = os.environ.get("GW_PASSWORD", "admin")
SESSION_TTL = 7 * 24 * 3600
COOKIE_NAME = "gw_session"
_CREDS_FILE = Path("/etc/awg-setup/dashboard-creds.json")


# ── Хеширование паролей панели (pbkdf2-hmac-sha256, stdlib, без зависимостей) ──
_PBKDF2_ITER = 200_000


def _hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", (pw or "").encode(), salt, _PBKDF2_ITER)
    return f"pbkdf2${_PBKDF2_ITER}${salt.hex()}${dk.hex()}"


def _is_hashed(stored) -> bool:
    return isinstance(stored, str) and stored.startswith("pbkdf2$")


def _verify_pw(pw: str, stored: str) -> bool:
    """Проверка пароля. Поддерживает хеш (pbkdf2$...) и legacy-plaintext (миграция)."""
    if _is_hashed(stored):
        try:
            _, it, salt_hex, hash_hex = stored.split("$", 3)
            dk = hashlib.pbkdf2_hmac("sha256", (pw or "").encode(), bytes.fromhex(salt_hex), int(it))
            return hmac.compare_digest(dk.hex(), hash_hex)
        except Exception:
            return False
    return hmac.compare_digest(str(pw or ""), str(stored or ""))


def _migrate_user_hash(username: str, plain_pw: str) -> None:
    """После успешного входа по legacy-plaintext — пересохранить пароль хешем."""
    try:
        users = _load_users()
        changed = False
        for u in users:
            if u.get("username") == username and not _is_hashed(u.get("password")):
                u["password"] = _hash_pw(plain_pw)
                changed = True
        if changed:
            _save_users(users)
    except Exception:
        pass


def _load_creds() -> tuple[str, str]:
    try:
        if _CREDS_FILE.exists():
            d = json.loads(_CREDS_FILE.read_text())
            u, p = d.get("username"), d.get("password")
            if u and p:
                return str(u), str(p)
    except Exception:
        pass
    return _ENV_USER, _ENV_PASS


def _save_creds(username: str, password: str) -> bool:
    try:
        _CREDS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _CREDS_FILE.write_text(json.dumps({"username": username, "password": password}))
        _CREDS_FILE.chmod(0o600)
        return True
    except Exception:
        return False


# ── Многопользовательские учётные записи панели ───────────────────
_USERS_FILE = Path("/etc/awg-setup/dashboard-users.json")


def _load_users() -> list[dict]:
    try:
        if _USERS_FILE.exists():
            d = json.loads(_USERS_FILE.read_text())
            if isinstance(d, list) and d:
                return d
    except Exception:
        pass
    # миграция: одиночная учётка → список (как admin)
    u, p = _load_creds()
    return [{"username": u, "password": p, "role": "admin"}]


def _save_users(users: list[dict]) -> bool:
    try:
        _USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        _USERS_FILE.write_text(json.dumps(users, ensure_ascii=False))
        _USERS_FILE.chmod(0o600)
        # primary admin дублируем в старый файл (совместимость)
        admin = next((x for x in users if x.get("role") == "admin"), users[0] if users else None)
        if admin:
            _save_creds(admin["username"], admin["password"])
        return True
    except Exception:
        return False


def _find_user(name: str):
    return next((x for x in _load_users() if x.get("username") == name), None)


def _token_user(request: Request) -> str:
    try:
        raw = base64.urlsafe_b64decode(request.cookies.get(COOKIE_NAME, "").encode()).decode()
        return raw.rsplit(".", 2)[0]
    except Exception:
        return ""


def _is_admin(request: Request) -> bool:
    u = _find_user(_token_user(request))
    return bool(u and u.get("role") == "admin")


def _session_secret() -> bytes:
    sf = Path("/etc/awg-setup/.session-secret")
    try:
        if sf.exists():
            return sf.read_bytes()
        sec = secrets.token_bytes(32)
        sf.parent.mkdir(parents=True, exist_ok=True)
        sf.write_bytes(sec)
        return sec
    except Exception:
        # не хардкодим предсказуемый секрет: генерим случайный в памяти.
        # токены не переживут рестарт, но подделать их нельзя.
        return secrets.token_bytes(32)


_SECRET = _session_secret()


def _make_token(user: str) -> str:
    exp = str(int(time.time()) + SESSION_TTL)
    payload = f"{user}.{exp}"
    sig = hmac.new(_SECRET, payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}.{sig}".encode()).decode()


def _valid_token(token: str) -> bool:
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        user, exp, sig = raw.rsplit(".", 2)
        expected = hmac.new(_SECRET, f"{user}.{exp}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected) and int(exp) > time.time()
    except Exception:
        return False


# ── FastAPI app ───────────────────────────────────────────────────
app = FastAPI(title="Gateway Hub", docs_url=None, redoc_url=None)
_PUBLIC = {"/login", "/api/login", "/favicon.ico"}


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    # CSP: всё своё (xterm/иконки вшиты), внешних загрузок нет → блокируем
    # утечки. 'unsafe-inline' нужен из-за инлайн-обработчиков и стилей панели.
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "connect-src 'self' ws: wss:; font-src 'self' data:; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    return resp


# Управляющие пути: модератору (не-админу) недоступны (только просмотр). Эндпоинты
# в /api/security|update|backup|system|network и так самогейтятся _is_admin; здесь
# добиваем /api/access и /api/vpn (изменения) + веб-консоль (shell — только админ).
_ADMIN_ONLY_WRITE = ("/api/access", "/api/vpn")
_ADMIN_ONLY_ANY = ("/api/console", "/api/system/console", "/ws/console")


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if path in _PUBLIC or path.startswith("/static/"):
        return await call_next(request)
    if not _valid_token(request.cookies.get(COOKIE_NAME, "")):
        if path.startswith("/api/"):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return RedirectResponse("/login", status_code=302)
    # роль: модератор не может управлять (консоль + изменяющие запросы к access/vpn)
    if not _is_admin(request):
        if any(path.startswith(p) for p in _ADMIN_ONLY_ANY) \
           or (request.method in ("POST", "PUT", "DELETE", "PATCH")
               and any(path.startswith(p) for p in _ADMIN_ONLY_WRITE)):
            return JSONResponse({"detail": "Доступно только администратору"}, status_code=403)
    return await call_next(request)


class LoginReq(BaseModel):
    username: str
    password: str


@app.get("/login")
def login_page():
    p = STATIC_DIR / "login.html"
    return FileResponse(p) if p.exists() else JSONResponse({"error": "login.html not found"}, status_code=404)


# Анти-брутфорс: лимит неудачных попыток входа на IP (в памяти процесса).
_LOGIN_FAILS: dict[str, list] = {}
_LOGIN_MAX = 8
_LOGIN_WINDOW = 300  # 5 минут


def _client_ip(request: Request) -> str:
    return (request.headers.get("x-real-ip")
            or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (request.client.host if request.client else "?"))


def _login_locked(ip: str) -> int:
    rec = _LOGIN_FAILS.get(ip)
    if not rec:
        return 0
    count, first = rec
    if time.time() - first > _LOGIN_WINDOW:
        _LOGIN_FAILS.pop(ip, None)
        return 0
    return int(_LOGIN_WINDOW - (time.time() - first)) if count >= _LOGIN_MAX else 0


@app.post("/api/login")
def api_login(req: LoginReq, request: Request):
    ip = _client_ip(request)
    wait = _login_locked(ip)
    if wait > 0:
        return JSONResponse({"ok": False, "error": f"Слишком много попыток. Подождите {wait} сек."},
                            status_code=429)
    u = _find_user(req.username)
    if u and hmac.compare_digest(req.username, u["username"]) and _verify_pw(req.password, u["password"]):
        _LOGIN_FAILS.pop(ip, None)
        if not _is_hashed(u.get("password")):
            _migrate_user_hash(req.username, req.password)  # апгрейд legacy-plaintext -> pbkdf2
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE_NAME, _make_token(req.username),
                        max_age=SESSION_TTL, httponly=True, samesite="lax")
        return resp
    # фиксируем неудачу (in-memory rate-limit)
    rec = _LOGIN_FAILS.get(ip)
    if not rec or time.time() - rec[1] > _LOGIN_WINDOW:
        _LOGIN_FAILS[ip] = [1, time.time()]
    else:
        rec[0] += 1
    # лог для fail2ban (бан на уровне фаервола) — реальный IP даёт nginx X-Real-IP
    try:
        safe_user = re.sub(r"[^\w.@-]", "", str(req.username))[:32]
        with open("/var/log/panel-auth.log", "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} panel-auth: FAILED login from {ip} user={safe_user}\n")
    except Exception:
        pass
    return JSONResponse({"ok": False, "error": "Неверный логин или пароль"}, status_code=401)


@app.get("/logout")
def logout():
    resp = RedirectResponse("/login", status_code=302)
    resp.delete_cookie(COOKIE_NAME)
    return resp


@app.get("/api/security/whoami")
def whoami(request: Request):
    me = _token_user(request)
    u = _find_user(me)
    # дефолт-креды: логин admin и пароль всё ещё "admin" -> панель потребует смены
    default_creds = bool(u and u.get("username") == "admin"
                         and _verify_pw("admin", u.get("password", "")))
    return {"username": me, "role": (u.get("role") if u else "user"),
            "default_creds": default_creds}


class CredsChange(BaseModel):
    current_password: str
    new_username: str
    new_password: str


@app.post("/api/security/change-password")
def change_password(req: CredsChange, request: Request):
    me_name = _token_user(request)
    users = _load_users()
    me = next((x for x in users if x.get("username") == me_name), None)
    if not me or not _verify_pw(req.current_password, me["password"]):
        return JSONResponse({"ok": False, "error": "Неверный текущий пароль"}, status_code=403)
    new_user = req.new_username.strip()
    if not new_user or not req.new_password:
        return JSONResponse({"ok": False, "error": "Логин и пароль не могут быть пустыми"}, status_code=400)
    if len(req.new_password) < 4:
        return JSONResponse({"ok": False, "error": "Пароль слишком короткий (минимум 4 символа)"}, status_code=400)
    if new_user != me_name and any(x.get("username") == new_user for x in users):
        return JSONResponse({"ok": False, "error": "Логин уже занят другой учёткой"}, status_code=400)
    me["username"], me["password"] = new_user, _hash_pw(req.new_password)
    if not _save_users(users):
        return JSONResponse({"ok": False, "error": "Не удалось сохранить"}, status_code=500)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(COOKIE_NAME, _make_token(new_user),
                    max_age=SESSION_TTL, httponly=True, samesite="lax")
    return resp


# ── SSH-доступ: смена порта онлайн (только админ, с подтверждением паролем) ──
# Порт SSH — СОСТОЯНИЕ машины. Отдельный drop-in, которого нет в репозитории:
# 10-gateway.conf синкается накатом и затирал бы выбранный владельцем порт,
# а сам порт при этом был бы опубликован в открытом коде.
_SSHD_DROPIN = "/etc/ssh/sshd_config.d/20-gateway-port.conf"   # на ХОСТЕ
_SSH_PORT_HELPER = "/usr/local/bin/gateway-ssh-port.sh"        # на ХОСТЕ
_RESERVED_PORTS = {22, 53, 67, 68, 80, 443, 8000}          # 22 разрешим (см. ниже)


def _verify_admin_password(request: Request, password: str) -> bool:
    me_name = _token_user(request)
    me = _find_user(me_name)
    return bool(me and me.get("role") == "admin"
                and _verify_pw(password, me.get("password", "")))


def _current_ssh_port() -> int:
    try:
        r = subprocess.run(_host_prefix() + ["sh", "-c",
                           f"grep -iE '^[[:space:]]*Port[[:space:]]' {_SSHD_DROPIN} 2>/dev/null | awk '{{print $2}}' | tail -1"],
                           capture_output=True, text=True, timeout=10)
        p = (r.stdout or "").strip()
        if p.isdigit():
            return int(p)
        # файла ещё нет (первая загрузка/миграция) — спросим помощника на хосте
        r = subprocess.run(_host_prefix() + [_SSH_PORT_HELPER, "get"],
                           capture_output=True, text=True, timeout=10)
        p = (r.stdout or "").strip()
        return int(p) if p.isdigit() else 22
    except Exception:
        return 22


class SshPortReq(BaseModel):
    port: int
    password: str = ""


@app.get("/api/security/ssh-port")
def ssh_port_get(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    return {"port": _current_ssh_port()}


@app.post("/api/security/ssh-port")
def ssh_port_set(req: SshPortReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not _verify_admin_password(request, req.password):
        return JSONResponse({"ok": False, "error": "Неверный пароль администратора"}, status_code=403)
    p = int(req.port or 0)
    if not (1 <= p <= 65535):
        return JSONResponse({"ok": False, "error": "Порт 1..65535"}, status_code=400)
    if p in (_RESERVED_PORTS - {22}):
        return JSONResponse({"ok": False, "error": f"Порт {p} занят сервисом шлюза, выберите другой"}, status_code=400)
    # переписываем строку Port в host-дропине и перезапускаем sshd.
    # Существующие SSH-сессии при рестарте НЕ рвутся; новый порт — для новых входов.
    # Пишем через хостовый помощник: он и файл сформирует, и sshd -t проверит,
    # и перечитает конфиг. Существующие сессии при этом не рвутся.
    try:
        r = subprocess.run(_host_prefix() + [_SSH_PORT_HELPER, "set", str(p)],
                           capture_output=True, text=True, timeout=25)
        if r.returncode != 0:
            return JSONResponse({"ok": False,
                                 "error": "sshd отверг конфигурацию, порт не изменён"}, status_code=500)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    _wlog(f"WARN SSH-порт изменён на {p} (user={_token_user(request)})")
    return {"ok": True, "port": p}


# ── Консольные креды: пароль root (вход по SSH) + SSH-ключи ───────────────────
_AUTHKEYS = "/root/.ssh/authorized_keys"   # на ХОСТЕ
_SSHKEY_RE = re.compile(r"^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-ssh-\S+|sk-ecdsa-\S+)\s+[A-Za-z0-9+/=]+(\s+\S.*)?$")


class ConsolePassReq(BaseModel):
    admin_password: str = ""
    new_password: str = ""


@app.post("/api/security/console-password")
def console_password(req: ConsolePassReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not _verify_admin_password(request, req.admin_password):
        return JSONResponse({"ok": False, "error": "Неверный пароль администратора"}, status_code=403)
    if len(req.new_password or "") < 6:
        return JSONResponse({"ok": False, "error": "Пароль root минимум 6 символов"}, status_code=400)
    if "\n" in req.new_password or ":" in req.new_password:
        return JSONResponse({"ok": False, "error": "Пароль без переноса строки и двоеточия"}, status_code=400)
    try:
        # пароль передаём через stdin (chpasswd), без шелл-инъекций
        r = subprocess.run(_host_prefix() + ["chpasswd"],
                           input=f"root:{req.new_password}\n".encode(),
                           capture_output=True, timeout=15)
        if r.returncode != 0:
            err = (r.stderr.decode("utf-8", "replace") if r.stderr else "") or "ошибка chpasswd"
            return JSONResponse({"ok": False, "error": err[:200]}, status_code=500)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    _wlog(f"WARN Сменён пароль root (SSH/консоль) (user={_token_user(request)})")
    return {"ok": True}


def _read_authkeys() -> list[str]:
    try:
        r = subprocess.run(_host_prefix() + ["sh", "-c", f"cat {_AUTHKEYS} 2>/dev/null"],
                           capture_output=True, text=True, timeout=10)
        return [l.strip() for l in (r.stdout or "").splitlines() if l.strip() and not l.strip().startswith("#")]
    except Exception:
        return []


def _key_label(k: str) -> str:
    parts = k.split()
    return parts[2] if len(parts) >= 3 else (parts[0] if parts else "ключ")


class SshKeyReq(BaseModel):
    key: str = ""


@app.get("/api/security/ssh-keys")
def ssh_keys_get(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    keys = _read_authkeys()
    return {"keys": [{"type": k.split()[0], "label": _key_label(k), "raw": k,
                      "fp": (k.split()[1][:18] + "…") if len(k.split()) >= 2 else ""} for k in keys]}


@app.post("/api/security/ssh-keys")
def ssh_keys_add(req: SshKeyReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    key = " ".join((req.key or "").split())
    if not _SSHKEY_RE.match(key):
        return JSONResponse({"ok": False, "error": "Не похоже на публичный SSH-ключ (ssh-ed25519/ssh-rsa/ecdsa…)"}, status_code=400)
    if key in _read_authkeys():
        return JSONResponse({"ok": False, "error": "Такой ключ уже добавлен"}, status_code=400)
    try:
        subprocess.run(_host_prefix() + ["sh", "-c",
                       "mkdir -p /root/.ssh && chmod 700 /root/.ssh && "
                       f"cat >> {_AUTHKEYS} && chmod 600 {_AUTHKEYS}"],
                       input=(key + "\n").encode(), capture_output=True, timeout=10)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    _wlog(f"INFO Добавлен SSH-ключ ({_key_label(key)}) (user={_token_user(request)})")
    return {"ok": True}


@app.post("/api/security/ssh-keygen")
def ssh_keygen(request: Request):
    """Генерирует пару ключей НА СЕРВЕРЕ: публичный кладёт в authorized_keys,
    приватный отдаёт пользователю (на сервере НЕ хранится)."""
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    try:
        gen = ("f=$(mktemp -u /tmp/gwkey.XXXXXX); "
               "ssh-keygen -t ed25519 -N '' -C 'gateway-panel' -f \"$f\" >/dev/null 2>&1 && "
               "cat \"$f\"; echo '===PUBSPLIT==='; cat \"$f.pub\" 2>/dev/null; rm -f \"$f\" \"$f.pub\"")
        r = subprocess.run(_host_prefix() + ["sh", "-c", gen], capture_output=True, text=True, timeout=20)
        out = r.stdout or ""
        if "===PUBSPLIT===" not in out:
            return JSONResponse({"ok": False, "error": "ssh-keygen недоступен"}, status_code=500)
        priv, pub = out.split("===PUBSPLIT===", 1)
        priv, pub = priv.strip(), pub.strip()
        if "PRIVATE KEY" not in priv or not pub.startswith("ssh-ed25519"):
            return JSONResponse({"ok": False, "error": "Не удалось сгенерировать ключ"}, status_code=500)
        subprocess.run(_host_prefix() + ["sh", "-c",
                       "mkdir -p /root/.ssh && chmod 700 /root/.ssh && "
                       f"cat >> {_AUTHKEYS} && chmod 600 {_AUTHKEYS}"],
                       input=(pub + "\n").encode(), capture_output=True, timeout=10)
        _wlog(f"INFO Сгенерирован SSH-ключ на сервере (user={_token_user(request)})")
        return {"ok": True, "private": priv, "public": pub}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.post("/api/security/ssh-keys/delete")
def ssh_keys_del(req: SshKeyReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    target = " ".join((req.key or "").split())
    keys = _read_authkeys()
    # сопоставляем по типу+телу (без коммента) — на случай разных меток
    def _kbody(k): p = k.split(); return (p[0], p[1]) if len(p) >= 2 else (k,)
    keep = [k for k in keys if _kbody(k) != _kbody(target)]
    if len(keep) == len(keys):
        return JSONResponse({"ok": False, "error": "Ключ не найден"}, status_code=404)
    try:
        subprocess.run(_host_prefix() + ["sh", "-c", f"cat > {_AUTHKEYS} && chmod 600 {_AUTHKEYS}"],
                       input=("\n".join(keep) + ("\n" if keep else "")).encode(),
                       capture_output=True, timeout=10)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    _wlog(f"INFO Удалён SSH-ключ (user={_token_user(request)})")
    return {"ok": True}


# ── Статистика безопасности (для дашборда): баны, дропы с WAN, брут ──────────
def _f2b_jail(jail: str) -> dict:
    try:
        r = subprocess.run(_host_prefix() + ["fail2ban-client", "status", jail],
                           capture_output=True, text=True, timeout=10)
        out = r.stdout or ""
        cur = re.search(r"Currently banned:\s*(\d+)", out)
        tot = re.search(r"Total banned:\s*(\d+)", out)
        ips = re.search(r"Banned IP list:\s*(.*)", out)
        return {"jail": jail,
                "current": int(cur.group(1)) if cur else 0,
                "total": int(tot.group(1)) if tot else 0,
                "ips": ips.group(1).split() if ips and ips.group(1).strip() else []}
    except Exception:
        return {"jail": jail, "current": 0, "total": 0, "ips": []}


@app.get("/api/security/stats")
def security_stats(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    jails = [_f2b_jail("sshd"), _f2b_jail("gateway-panel")]
    f2b_up = any(j["total"] or j["current"] for j in jails) or True  # status вернулся = жив
    banned_now = sum(j["current"] for j in jails)
    banned_total = sum(j["total"] for j in jails)
    banned_ips = sorted({ip for j in jails for ip in j["ips"]})
    # пакеты, сброшенные фаерволом ИМЕННО со стороны WAN (реальные удары снаружи).
    # Считаем только правило «-i <WAN> -j DROP», а не INVALID-дропы.
    wan_drops = 0
    try:
        r = subprocess.run(_host_prefix() + ["sh", "-c",
                           "W=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null); "
                           "iptables -L GW_INPUT -v -x -n 2>/dev/null | awk -v w=\"$W\" '$3==\"DROP\" && $6==w {s+=$1} END{print s+0}'"],
                           capture_output=True, text=True, timeout=10)
        wan_drops = int((r.stdout or "0").strip() or 0)
    except Exception:
        pass
    # неудачные входы в панель + АКТИВНАЯ угроза (последние 10 мин от НЕ-забаненных IP)
    failed_logins = 0
    recent = []
    max_recent = 0
    try:
        p = Path("/var/log/panel-auth.log")
        if p.exists():
            now = time.time()
            window = 600  # 10 минут
            by_ip = {}
            lines = []
            for l in p.read_text(errors="replace").splitlines():
                if "FAILED login from" not in l:
                    continue
                lines.append(l)
                m = re.match(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*FAILED login from (\S+)", l)
                if not m:
                    continue
                ip = m.group(2)
                if ip in banned_ips:          # уже забанен — угроза нейтрализована
                    continue
                try:
                    ts = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
                except Exception:
                    continue
                if now - ts <= window:
                    by_ip[ip] = by_ip.get(ip, 0) + 1
            failed_logins = len(lines)
            recent = lines[-6:]
            max_recent = max(by_ip.values()) if by_ip else 0
    except Exception:
        pass
    # «Только что заблокировали» — окно ~15с после бана, чтобы «Атаку» было ВИДНО
    # (иначе fail2ban банит за пару секунд и статус промелькнул бы мимо опроса).
    recently_banned = False
    try:
        wl = Path("/var/log/awg-watchdog.log")
        if wl.exists():
            now2 = time.time()
            for l in wl.read_text(errors="replace").splitlines()[-120:]:
                if "fail2ban: ЗАБЛОКИРОВАН" not in l:
                    continue
                m = re.match(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)", l)
                if not m:
                    continue
                try:
                    if now2 - time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")) <= 15:
                        recently_banned = True
                        break
                except Exception:
                    pass
    except Exception:
        pass
    # Уровень = по АКТИВНОЙ угрозе. >=5 неудач (порог бана) ИЛИ только что заблокировали
    # — Атака (держим ~15с, видно); >=2 — Подозрение; иначе Штатно. Когда забаненный
    # «отлежался» 15с — угроза нейтрализована, состояние снова Штатно.
    level = "ok"
    if max_recent >= 2:
        level = "warn"
    if max_recent >= 5 or recently_banned:
        level = "alarm"
    return {"level": level, "banned_now": banned_now, "banned_total": banned_total,
            "banned_ips": banned_ips[:20], "wan_drops": wan_drops,
            "failed_logins": failed_logins, "active_threat": max_recent,
            "jails": jails, "recent": recent}


class UnbanReq(BaseModel):
    ip: str = ""


@app.post("/api/security/unban")
def security_unban(req: UnbanReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    ip = (req.ip or "").strip()
    if not re.match(r"^[0-9a-fA-F:.]{3,45}$", ip):
        return JSONResponse({"ok": False, "error": "Некорректный IP"}, status_code=400)
    for jail in ("sshd", "gateway-panel"):
        try:
            subprocess.run(_host_prefix() + ["fail2ban-client", "set", jail, "unbanip", ip],
                           capture_output=True, timeout=10)
        except Exception:
            pass
    _wlog(f"INFO Разблокирован IP {ip} (user={_token_user(request)})")
    return {"ok": True}


@app.post("/api/security/unban-all")
def security_unban_all(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    try:
        subprocess.run(_host_prefix() + ["fail2ban-client", "unban", "--all"],
                       capture_output=True, timeout=15)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    _wlog(f"INFO Сняты все блокировки (user={_token_user(request)})")
    return {"ok": True}


# ── Управление учётными записями (только администратор) ───────────
@app.get("/api/security/users")
def list_users(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    users = _load_users()
    return {"me": _token_user(request),
            "users": [{"username": x["username"], "role": x.get("role", "user")} for x in users]}


class UserCreate(BaseModel):
    admin_password: str
    username: str
    password: str
    role: str = "user"


@app.post("/api/security/users")
def create_user(req: UserCreate, request: Request):
    me = _find_user(_token_user(request))
    if not me or me.get("role") != "admin":
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not _verify_pw(req.admin_password, me["password"]):
        return JSONResponse({"error": "Неверный пароль администратора"}, status_code=403)
    name = req.username.strip()
    if not name or not req.password:
        return JSONResponse({"error": "Логин и пароль не могут быть пустыми"}, status_code=400)
    if len(req.password) < 4:
        return JSONResponse({"error": "Пароль слишком короткий (минимум 4 символа)"}, status_code=400)
    users = _load_users()
    if any(x.get("username") == name for x in users):
        return JSONResponse({"error": "Учётка с таким логином уже есть"}, status_code=400)
    users.append({"username": name, "password": _hash_pw(req.password),
                  "role": "admin" if req.role == "admin" else "user"})
    if not _save_users(users):
        return JSONResponse({"error": "Не удалось сохранить"}, status_code=500)
    return {"ok": True}


class UserAction(BaseModel):
    admin_password: str
    username: str


@app.post("/api/security/users/delete")
def delete_user(req: UserAction, request: Request):
    me_name = _token_user(request)
    me = _find_user(me_name)
    if not me or me.get("role") != "admin":
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not _verify_pw(req.admin_password, me["password"]):
        return JSONResponse({"error": "Неверный пароль администратора"}, status_code=403)
    if req.username == me_name:
        return JSONResponse({"error": "Нельзя удалить самого себя"}, status_code=400)
    users = _load_users()
    tu = next((x for x in users if x.get("username") == req.username), None)
    if not tu:
        return JSONResponse({"error": "Учётка не найдена"}, status_code=404)
    if tu.get("role") == "admin" and sum(1 for x in users if x.get("role") == "admin") <= 1:
        return JSONResponse({"error": "Нельзя удалить последнего администратора"}, status_code=400)
    users = [x for x in users if x.get("username") != req.username]
    if not _save_users(users):
        return JSONResponse({"error": "Не удалось сохранить"}, status_code=500)
    return {"ok": True}


class PassReset(BaseModel):
    admin_password: str
    username: str
    new_password: str


@app.post("/api/security/reset-password")
def reset_password(req: PassReset, request: Request):
    me = _find_user(_token_user(request))
    if not me or me.get("role") != "admin":
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not _verify_pw(req.admin_password, me["password"]):
        return JSONResponse({"error": "Неверный пароль администратора"}, status_code=403)
    if len(req.new_password) < 4:
        return JSONResponse({"error": "Пароль слишком короткий (минимум 4 символа)"}, status_code=400)
    users = _load_users()
    tu = next((x for x in users if x.get("username") == req.username), None)
    if not tu:
        return JSONResponse({"error": "Учётка не найдена"}, status_code=404)
    tu["password"] = _hash_pw(req.new_password)
    if not _save_users(users):
        return JSONResponse({"error": "Не удалось сохранить"}, status_code=500)
    return {"ok": True}


# ── Helpers ───────────────────────────────────────────────────────
def _run(cmd: list[str], timeout: int = 5) -> tuple[int, str, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except Exception as e:
        return -1, "", str(e)


def _awg_show(args: list[str]) -> str:
    rc, out, _ = _run(["docker", "exec", "gw-awg", "awg"] + args)
    if rc != 0:
        rc, out, _ = _run(["awg"] + args)
    return out


def _read(path: str, default: str = "") -> str:
    try:
        return Path(path).read_text().strip()
    except Exception:
        return default


# ── API: система ─────────────────────────────────────────────────
def _cpu_temp() -> float | None:
    """Температура CPU в °C, если датчики доступны (на железе — да, в VM часто нет)."""
    try:
        temps = psutil.sensors_temperatures()
    except Exception:
        return None
    if not temps:
        return None
    # приоритет известных CPU-датчиков
    for key in ("coretemp", "k10temp", "cpu_thermal", "acpitz", "zenpower"):
        if key in temps and temps[key]:
            return round(temps[key][0].current, 1)
    # иначе — первый попавшийся
    for arr in temps.values():
        if arr:
            return round(arr[0].current, 1)
    return None


psutil.cpu_percent(interval=None)  # прайм: первый замер «с прошлого вызова»


@app.get("/api/system")
def api_system():
    # interval=None — НЕблокирующий замер (% с прошлого вызова). Раньше было
    # interval=0.5 -> каждый запрос /api/system блокировался на 0.5с (нагрузочный
    # тест показал ровно 505мс латентности). Дашборд опрашивает раз в 5с — точность
    # «% за последние ~5с» сохраняется, но ответ теперь мгновенный.
    cpu = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    boot = psutil.boot_time()
    uptime_sec = int(time.time() - boot)
    d, h, m = uptime_sec // 86400, (uptime_sec % 86400) // 3600, (uptime_sec % 3600) // 60
    load = list(os.getloadavg())
    try:
        dio = psutil.disk_io_counters()
        disk_read = dio.read_bytes if dio else 0
        disk_write = dio.write_bytes if dio else 0
    except Exception:
        disk_read = disk_write = 0
    return {
        "hostname": os.uname().nodename,
        "uptime": f"{d}д {h}ч {m}м",
        "uptime_sec": uptime_sec,
        "cpu_pct": cpu,
        "cpu_cores": psutil.cpu_count(logical=True),
        "cpu_temp": _cpu_temp(),
        "load": f"{load[0]:.2f} {load[1]:.2f} {load[2]:.2f}",
        "ram_used_mb": vm.used // 1048576,
        "ram_total_mb": vm.total // 1048576,
        "ram_pct": vm.percent,
        "disk_used_gb": round(disk.used / 1e9, 1),
        "disk_total_gb": round(disk.total / 1e9, 1),
        "disk_pct": disk.percent,
        "disk_read_bytes": disk_read,
        "disk_write_bytes": disk_write,
    }


# ── API: сеть ────────────────────────────────────────────────────
def _iface_master(name: str) -> str:
    """Имя моста-владельца порта (если порт в br-lan) — чтобы показать роль LAN."""
    try:
        return os.path.basename(os.readlink(f"/sys/class/net/{name}/master"))
    except Exception:
        return ""


@app.get("/api/network")
def api_network():
    wan = _read("/run/awg-setup/wan-port") or _read("/etc/awg-setup/wan-port")
    counters = psutil.net_io_counters(pernic=True)
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()

    ifaces = []
    for name, st in stats.items():
        if name in ("lo",) or name.startswith(("veth", "docker", "br-")):
            continue
        addr4 = next((a.address for a in addrs.get(name, []) if a.family == 2), "")
        cnt = counters.get(name)
        master = _iface_master(name)
        is_lan_member = master == "br-lan"
        ifaces.append({
            "name": name,
            "ip": "" if is_lan_member and addr4.startswith("169.254.") else addr4,
            "up": st.isup,
            "speed_mbps": st.speed,
            "mtu": st.mtu,
            "rx_bytes": cnt.bytes_recv if cnt else 0,
            "tx_bytes": cnt.bytes_sent if cnt else 0,
            "is_wan": name == wan,
            # порт-член моста br-lan = тоже LAN (раздача), показываем роль
            "is_lan": name == "br-lan" or is_lan_member,
            "is_lan_member": is_lan_member,
            "is_vpn": name == "awg0",
        })
    # Добавляем br-lan и awg0 если есть
    for special in ("br-lan", "awg0"):
        if special in stats and not any(i["name"] == special for i in ifaces):
            addr4 = next((a.address for a in addrs.get(special, []) if a.family == 2), "")
            cnt = counters.get(special)
            ifaces.append({
                "name": special,
                "ip": addr4,
                "up": stats[special].isup,
                "rx_bytes": cnt.bytes_recv if cnt else 0,
                "tx_bytes": cnt.bytes_sent if cnt else 0,
                "is_wan": False,
                "is_lan": special == "br-lan",
                "is_vpn": special == "awg0",
            })
    return {"wan": wan, "interfaces": ifaces}


# ── API: VPN ─────────────────────────────────────────────────────
def _sync_mode(mode: str):
    """Синхронизируем /run/awg-mode с фактическим состоянием."""
    try:
        Path("/run/awg-mode").write_text(mode + "\n")
    except Exception:
        pass


@app.get("/api/vpn")
def api_vpn():
    user_mode = _read("/etc/awg-setup/user-mode", "vpn")
    conf = Path("/etc/amnezia/awg0.conf")

    # Режим вычисляем ПО ФАКТУ, а не из устаревшего файла.
    # Пользователь явно выключил VPN → manual_off (приоритет).
    if user_mode == "off":
        _sync_mode("manual_off")
        return {"configured": conf.exists(), "up": False, "connected": False,
                "mode": "manual_off", "user_mode": user_mode}

    if not conf.exists():
        _sync_mode("no_config")
        return {"configured": False, "up": False, "connected": False,
                "mode": "no_config", "user_mode": user_mode}

    rc, _, _ = _run(["ip", "link", "show", "awg0"])
    if rc != 0:
        # конфиг есть, но интерфейс не поднят → прямой интернет (failover)
        addr = next((l.split("=")[1].strip() for l in conf.read_text().splitlines()
                     if l.startswith("Address")), "")
        _sync_mode("fallback")
        return {"configured": True, "up": False, "connected": False,
                "mode": "fallback", "user_mode": user_mode, "tunnel_ip": addr}

    awg_out = _awg_show(["show", "awg0"])
    pub_key = re.search(r"public key:\s+(\S+)", awg_out)
    endpoint = re.search(r"endpoint:\s+(\S+)", awg_out)
    transfer = re.search(r"transfer:\s+(.+)", awg_out)
    hs_str = re.search(r"latest handshake:\s+(.+)", awg_out)

    hs_ts_out = _awg_show(["show", "awg0", "latest-handshakes"])
    hs_ts = int(hs_ts_out.split()[-1]) if hs_ts_out.split() else 0
    hs_age = int(time.time()) - hs_ts if hs_ts > 0 else -1
    connected = 0 < hs_age < 180

    # Интерфейс поднят: подключён → vpn, иначе ещё не было хэндшейка → vpn
    # (туннель поднят, пытается соединиться). Реальный обрыв ловит watchdog.
    mode = "vpn"

    rc2, ip_out, _ = _run(["ip", "addr", "show", "awg0"])
    tunnel_ip = re.search(r"inet (\S+)", ip_out)
    _sync_mode(mode)

    # Локализуем строку трафика: "X received, Y sent" → "↓ X · ↑ Y"
    transfer_str = ""
    if transfer:
        tm = re.match(r"(.+?)\s+received,\s+(.+?)\s+sent", transfer.group(1).strip())
        transfer_str = f"↓ {tm.group(1)} · ↑ {tm.group(2)}" if tm else transfer.group(1)

    hs_ru = f"{hs_age} сек назад" if hs_age >= 0 else "—"

    return {
        "configured": True, "up": True, "connected": connected,
        "mode": mode, "user_mode": user_mode,
        "tunnel_ip": tunnel_ip.group(1) if tunnel_ip else "",
        "public_key": pub_key.group(1) if pub_key else "",
        "endpoint": endpoint.group(1) if endpoint else "",
        "transfer": transfer_str,
        "handshake": hs_ru,
        "handshake_age": hs_age,
    }


# ── API: управление VPN ──────────────────────────────────────────
CONF = "/etc/amnezia/awg0.conf"
WLOG = "/var/log/awg-watchdog.log"
USER_MODE = "/etc/awg-setup/user-mode"
RUNTIME_MODE = "/run/awg-mode"


def _wlog(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        Path(WLOG).parent.mkdir(parents=True, exist_ok=True)
        with open(WLOG, "a") as f:
            f.write(f"{ts} {msg}\n")
    except Exception:
        pass


def _awg_quick(action: str):
    # "up" → awg-up wrapper (поднимает туннель + ВСЕГДА исключает endpoint
    # из маршрутизации, любой AllowedIPs). "down" → обычный awg-quick down.
    env = {**os.environ, "WG_QUICK_USERSPACE_IMPLEMENTATION": "amneziawg-go"}
    if action == "up":
        cmd = ["docker", "exec", "gw-awg", "awg-up", "/config/awg0.conf"]
    else:
        cmd = ["docker", "exec", "-e",
               "WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go",
               "gw-awg", "awg-quick", action, "/config/awg0.conf"]
    subprocess.Popen(cmd, env=env)


@app.post("/api/vpn/up")
def vpn_up():
    _awg_quick("up")
    return {"ok": True, "msg": "Поднимаем туннель..."}


@app.post("/api/vpn/down")
def vpn_down():
    _awg_quick("down")
    return {"ok": True, "msg": "Опускаем туннель..."}


@app.post("/api/vpn/restart")
def vpn_restart():
    subprocess.Popen(["sh", "-c",
        "docker exec gw-awg awg-quick down /config/awg0.conf 2>/dev/null; sleep 2; "
        "docker exec gw-awg awg-up /config/awg0.conf"])
    return {"ok": True, "msg": "Перезапускаем туннель..."}


class ModeReq(BaseModel):
    mode: str  # "vpn_enable" | "vpn_disable"


@app.post("/api/vpn/mode")
def vpn_mode(req: ModeReq):
    if req.mode == "vpn_enable":
        Path(USER_MODE).write_text("vpn\n")
        Path(RUNTIME_MODE).unlink(missing_ok=True)
        _awg_quick("up")
        _wlog("INFO VPN включён вручную (persistent)")
        return {"ok": True, "msg": "VPN включён"}
    elif req.mode == "vpn_disable":
        Path(USER_MODE).write_text("off\n")
        Path(RUNTIME_MODE).write_text("manual_off\n")
        _awg_quick("down")
        _wlog("INFO VPN отключён вручную (persistent)")
        return {"ok": True, "msg": "VPN отключён"}
    raise HTTPException(400, "Неизвестный режим")


def _normalize_config(text: str) -> str:
    """Умный шлюз сам рулит туннелированием, а не конфиг.
    Переписываем AllowedIPs -> 0.0.0.0/0, ::/0 (по умолчанию всё в туннель),
    а исключения ('напрямую'/блок) управляются из панели «Доступ».
    Плюсы: простой конфиг; защита от кривых AllowedIPs; нативный обход endpoint
    (0.0.0.0/0 включает fwmark-магию в awg-quick — петли нет).
    Ключи/endpoint/обфускацию/MTU/Address/DNS сохраняем как есть.
    """
    NEW = "AllowedIPs = 0.0.0.0/0, ::/0"
    # нормализуем переводы строк + убираем BOM (грязные конфиги тоже жуём)
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    allowed_re = re.compile(r"(?im)^[ \t]*AllowedIPs[ \t]*=[ \t]*(.*?)[ \t]*$")
    # исходное (первое НЕпустое) значение — для справки
    orig = ""
    for v in allowed_re.findall(text):
        if v.strip():
            orig = v.strip()
            break
    if allowed_re.search(text):
        # есть строка(и) AllowedIPs (в т.ч. пустая) — первую делаем нашей,
        # лишние/пустые дубли убираем.
        state = {"done": False}
        def _repl(_m):
            if state["done"]:
                return "__DROP_ALLOWEDIPS__"
            state["done"] = True
            return NEW
        text = allowed_re.sub(_repl, text)
        text = re.sub(r"(?m)^__DROP_ALLOWEDIPS__\n?", "", text)
    elif re.search(r"(?im)^[ \t]*\[Peer\]", text):
        # AllowedIPs нет вовсе (стоковый/пустой) — добавляем в [Peer]
        text = re.sub(r"(?im)^([ \t]*\[Peer\][ \t]*)$", r"\1\n" + NEW, text, count=1)
    else:
        # совсем без [Peer] — дописываем (awg-quick потом честно сообщит, если бьётся)
        text = text.rstrip() + "\n\n[Peer]\n" + NEW + "\n"
    try:
        fd = Path("/etc/awg-setup/filter")
        fd.mkdir(parents=True, exist_ok=True)
        (fd / "orig-allowedips.txt").write_text(orig)
    except Exception:
        pass
    return text


def _apply_config(text: str):
    """Сохраняет конфиг и применяет туннель. Возвращает dict с результатом."""
    if "[Interface]" not in text:
        return JSONResponse({"ok": False, "error": "Не найден блок [Interface]"}, status_code=400)
    # Нормализуем: туннелированием рулит МЭ (см. выше).
    orig_allowed = ""
    m = re.search(r"(?im)^[ \t]*AllowedIPs[ \t]*=[ \t]*(.+)$", text)
    if m:
        orig_allowed = m.group(1).strip()
    # Сохраняем ИСХОДНЫЙ (до нормализации) конфиг — для скачивания «как залили».
    # ВАЖНО: НЕ в /etc/awg-setup/filter/ — её сканирует dnsmasq по маске *.conf
    # (conf-dir), и WireGuard-конфиг как dnsmasq-конфиг роняет dnsmasq → нет DHCP.
    try:
        Path("/etc/awg-setup").mkdir(parents=True, exist_ok=True)
        Path("/etc/awg-setup/orig-config.conf").write_text(text)
        Path("/etc/awg-setup/orig-config.conf").chmod(0o600)
    except Exception:
        pass
    text = _normalize_config(text)
    try:
        Path(CONF).parent.mkdir(parents=True, exist_ok=True)
        Path(CONF).write_text(text)
        Path(CONF).chmod(0o600)
    except OSError as e:
        return JSONResponse(
            {"ok": False, "error": f"Не удалось сохранить конфиг: {e}"},
            status_code=500)
    _awg_quick("down")
    time.sleep(1)
    _awg_quick("up")
    _wlog("INFO Конфиг обновлён через веб-панель")

    # АВТО-СБОР обхода: дырки ключа -> split-ресурсы (с консолидацией/дедупом).
    auto = {}
    try:
        holes = _compute_holes(orig_allowed)
        if holes:
            rdata = _load_rules()
            auto = _merge_holes_into_split(rdata, holes)
            _apply_rules(rdata)
            _wlog(f"INFO Авто-сбор обхода из ключа: +{auto.get('added',0)} новых, "
                  f"схлопнуто {auto.get('merged',0)}, убрано лишних {auto.get('removed_redundant',0)}")
    except Exception:
        pass

    orig_count = len([x for x in orig_allowed.split(",") if "/" in x]) if orig_allowed else 0

    def _get(key):
        m = re.search(rf"^{key}\s*=\s*(.+)", text, re.MULTILINE)
        return m.group(1).strip() if m else ""
    return {
        "ok": True,
        "addr": _get("Address"), "dns": _get("DNS"), "mtu": _get("MTU"),
        "endpoint": _get("Endpoint"), "allowed": _get("AllowedIPs"),
        "keepalive": _get("PersistentKeepalive"),
        "is_awg": bool(_get("Jc")),
        "jc": _get("Jc"), "jmin": _get("Jmin"), "jmax": _get("Jmax"),
        # Туннелированием теперь рулит МЭ: конфиг нормализован в 0.0.0.0/0,
        # исходные ограничения (orig_count диапазонов) ушли в управление панели.
        "normalized": True, "orig_allowed_count": orig_count,
        "auto_extract": auto,   # авто-сбор обхода из дырок ключа
    }


@app.post("/api/vpn/config")
async def vpn_config(file: UploadFile = File(...)):
    """Загрузка .conf файлом."""
    content = await file.read()
    text = content.decode("utf-8", errors="replace")
    return _apply_config(text)


class ConfigText(BaseModel):
    config: str


@app.post("/api/vpn/config-text")
def vpn_config_text(req: ConfigText):
    """Ручной ввод конфига текстом."""
    return _apply_config(req.config)


@app.get("/api/vpn/config-text")
def vpn_config_get():
    """Текущий конфиг для редактирования (без приватного ключа маскируется)."""
    p = Path(CONF)
    if not p.exists():
        return {"config": ""}
    try:
        return {"config": p.read_text()}
    except OSError:
        return {"config": ""}


@app.get("/api/vpn/config-download")
def vpn_config_download(which: str = "current"):
    """Скачать конфиг файлом. which=current — активный (нормализованный, весь
    трафик в VPN, рулит шлюз); which=original — как был залит (с исходным
    AllowedIPs). За авторизацией — это приватный ключ владельца."""
    if which == "original":
        p = Path("/etc/awg-setup/orig-config.conf")
        fname = "awg-original.conf"
        if not p.exists():
            p = Path(CONF)  # фолбэк: исходного нет (конфиг до этой версии)
            fname = "awg0.conf"
    else:
        p = Path(CONF)
        fname = "awg0.conf"
    if not p.exists():
        raise HTTPException(status_code=404, detail="Конфиг не найден")
    return FileResponse(p, media_type="application/octet-stream", filename=fname)


# ── API: устройства (DHCP) ───────────────────────────────────────
@app.get("/api/devices")
def api_devices():
    leases_file = Path("/var/lib/misc/dnsmasq.leases")
    # Побайтовый учёт по клиентам (пишет client-traffic.sh). rx — к клиенту,
    # tx — от клиента. Кумулятивные счётчики; скорость считает фронтенд.
    traffic = {}
    tfile = Path("/run/awg-setup/client-traffic.json")
    if tfile.exists():
        try:
            traffic = json.loads(tfile.read_text() or "{}")
        except Exception:
            traffic = {}
    devices = []
    if leases_file.exists():
        for line in leases_file.read_text().splitlines():
            parts = line.split()
            if len(parts) >= 4:
                ip = parts[2]
                t = traffic.get(ip, {})
                devices.append({
                    "expire": int(parts[0]),
                    "mac": parts[1],
                    "ip": ip,
                    "name": parts[3] if parts[3] != "*" else "",
                    "rx_bytes": int(t.get("rx", 0)),
                    "tx_bytes": int(t.get("tx", 0)),
                })
    return {"devices": devices, "count": len(devices)}


# ── API: логи ────────────────────────────────────────────────────
@app.get("/api/logs")
def api_logs(n: int = 100):
    log = Path(WLOG)
    if not log.exists():
        return {"lines": []}
    lines = log.read_text().splitlines()[-n:]
    result = []
    for line in lines:
        parts = line.split(" ", 2)
        ts = f"{parts[0]} {parts[1]}" if len(parts) >= 2 else ""
        msg = parts[2] if len(parts) >= 3 else line
        # Уровень: первое слово сообщения или вхождение с пробелами
        first = msg.split()[0] if msg.split() else ""
        if first == "OK" or " OK " in msg:
            level = "ok"
        elif first == "WARN" or " WARN " in msg:
            level = "warn"
        elif first in ("ERR", "ERROR") or " ERR " in msg:
            level = "err"
        else:
            level = "info"
        result.append({"ts": ts, "msg": msg, "level": level})
    return {"lines": result}


@app.get("/api/report")
def api_report():
    """Еженедельный отчёт (weekly-report.sh, воскресенье 02:00): аптайм VPN,
    счётчики failover/восстановлений/рестартов сервисов, число устройств."""
    rep = Path("/etc/awg-setup/weekly-report.json")
    if not rep.exists():
        return {"available": False}
    try:
        d = json.loads(rep.read_text())
        d["available"] = True
        return d
    except Exception:
        return {"available": False}


# ── Резервные копии: снимок/восстановление состояния шлюза (§6A) ───
# Скрипты живут на ХОСТЕ (rootfs-overlay), webui зовёт их через nsenter
# (как веб-консоль). Каталог бэкапов /opt/gateway-backups примонтирован.
_BACKUP_DIR = Path("/opt/gateway-backups")


def _host_prefix() -> list[str]:
    """Префикс запуска команды в namespace хоста (pid:host + nsenter)."""
    try:
        comm = Path("/proc/1/comm").read_text().strip()
    except Exception:
        comm = ""
    if shutil.which("nsenter") and comm in ("systemd", "init"):
        return ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"]
    return []


def _host_detached(argv: list[str]) -> list[str]:
    """Запуск ДОЛГОЙ команды на хосте так, чтобы она пережила пересоздание
    контейнера панели.

    Зачем: накат в середине делает `docker compose up -d`, который пересоздаёт
    сам gw-webui. Обычный Popen оставляет процесс в cgroup контейнера, поэтому
    он умирает вместе с ним — обновление обрывается между установкой и
    health-gate, а старый контейнер остаётся переименованным (0991…_gw-webui),
    и панель «пропадает» из-под своего имени. Ровно так и случилось на живом
    шлюзе при нажатии кнопки «Обновить сейчас».

    systemd-run поднимает команду отдельным transient-юнитом хоста: свой cgroup,
    своя сессия — остановка контейнера её не касается. Проверку наличия делаем
    НА ХОСТЕ (внутри контейнера systemd-run нет), с запасным вариантом setsid.
    """
    q = " ".join(shlex.quote(a) for a in argv)
    script = (
        "if command -v systemd-run >/dev/null 2>&1; then "
        f"exec systemd-run --collect --quiet --unit=gw-panel-$$ -- {q}; "
        f"else exec setsid {q}; fi"
    )
    return _host_prefix() + ["sh", "-c", script]


def _safe_backup_name(name: str) -> str:
    name = (name or "").strip().strip("/")
    return "" if (not name or "/" in name or ".." in name) else name


@app.get("/api/backup/list")
def backup_list(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    items = []
    if _BACKUP_DIR.exists():
        for d in sorted(_BACKUP_DIR.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            meta = {}
            try:
                meta = json.loads((d / "meta.json").read_text())
            except Exception:
                pass
            tarp = d / "state.tar.gz"
            items.append({
                "name": d.name,
                "version": meta.get("version", "?"),
                "reason": meta.get("reason", "?"),
                "created": meta.get("created", ""),
                "size": tarp.stat().st_size if tarp.exists() else 0,
            })
    return {"backups": items}


@app.post("/api/backup/create")
def backup_create(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    try:
        r = subprocess.run(_host_prefix() + ["gateway-backup.sh", "manual"],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return JSONResponse({"ok": False, "error": (r.stderr or "ошибка").strip()[:200]}, status_code=500)
        _wlog("INFO Создан ручной бэкап через панель")
        out = r.stdout.strip().splitlines()
        return {"ok": True, "path": out[-1] if out else ""}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.get("/api/backup/download")
def backup_download(request: Request, name: str = ""):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    n = _safe_backup_name(name)
    f = _BACKUP_DIR / n / "state.tar.gz"
    if not n or not f.exists():
        return JSONResponse({"error": "Бэкап не найден"}, status_code=404)
    return FileResponse(f, filename=f"{n}.tar.gz", media_type="application/gzip")


class BackupAction(BaseModel):
    name: str


@app.post("/api/backup/restore")
def backup_restore(req: BackupAction, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    n = _safe_backup_name(req.name)
    if not n or not (_BACKUP_DIR / n / "state.tar.gz").exists():
        return JSONResponse({"ok": False, "error": "Бэкап не найден"}, status_code=404)
    try:
        r = subprocess.run(_host_prefix() + ["gateway-restore.sh", str(_BACKUP_DIR / n)],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return JSONResponse({"ok": False, "error": (r.stderr or "ошибка").strip()[:200]}, status_code=500)
        _wlog(f"WARN Восстановление из бэкапа {n} через панель")
        return {"ok": True}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)


@app.post("/api/backup/delete")
def backup_delete(req: BackupAction, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    n = _safe_backup_name(req.name)
    d = _BACKUP_DIR / n
    if not n or not d.exists():
        return JSONResponse({"ok": False, "error": "Бэкап не найден"}, status_code=404)
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


@app.post("/api/backup/upload")
async def backup_upload(request: Request, file: UploadFile = File(...)):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    data = await file.read()
    if not data or len(data) > 50 * 1024 * 1024:
        return JSONResponse({"ok": False, "error": "Пустой или слишком большой файл (макс 50 МБ)"}, status_code=400)
    ts = time.strftime("%Y%m%d-%H%M%S")
    d = _BACKUP_DIR / f"uploaded-{ts}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "state.tar.gz").write_bytes(data)
    (d / "state.sha256").write_text(hashlib.sha256(data).hexdigest() + "\n")
    (d / "meta.json").write_text(json.dumps({
        "version": "uploaded", "reason": "upload",
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"), "ts": ts, "size": len(data)}))
    _wlog("INFO Загружен бэкап через панель")
    return {"ok": True, "name": d.name}


# ── Управление железом: перезагрузка / перезапуск сервисов / выключение (§Б) ──
# Команды хосту через nsenter (как веб-консоль). Только админ + подтверждение,
# выключение — усиленное (ввод слова). Всё пишется в журнал событий.
class SystemActionReq(BaseModel):
    confirm: bool = False
    confirm_text: str = ""


@app.post("/api/system/restart-services")
def system_restart_services(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    _wlog(f"WARN Перезапуск сервисов через панель (user={_token_user(request)})")
    try:
        subprocess.Popen(_host_detached(["sh", "-c", "cd /opt/gateway && docker compose restart"]),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    return {"ok": True}


@app.post("/api/system/reboot")
def system_reboot(req: SystemActionReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not req.confirm:
        return JSONResponse({"ok": False, "error": "Нужно подтверждение"}, status_code=400)
    _wlog(f"WARN Перезагрузка шлюза через панель (user={_token_user(request)})")
    # запуск с задержкой, чтобы успеть отдать ответ панели
    subprocess.Popen(_host_prefix() + ["sh", "-c", "sleep 2; systemctl reboot"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True}


@app.post("/api/system/poweroff")
def system_poweroff(req: SystemActionReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not req.confirm or req.confirm_text.strip().lower() not in ("выключить", "poweroff"):
        return JSONResponse({"ok": False, "error": "Нужно усиленное подтверждение (введите «выключить»)"}, status_code=400)
    _wlog(f"WARN ВЫКЛЮЧЕНИЕ шлюза через панель (user={_token_user(request)}) — включить можно будет только физически")
    subprocess.Popen(_host_prefix() + ["sh", "-c", "sleep 2; systemctl poweroff"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True}


# ── Обновление шлюза (§6/§11): версия, проверка, накат, откат, режим ──────────
# Тяжёлые операции (apply/check/rollback) — host-скрипт gateway-update.sh через
# nsenter, в фоне. Прогресс — файл /run/awg-setup/update-status.json (смонтирован),
# фронт его опрашивает. Состояние/конфиг — /etc/awg-setup/* (тоже смонтированы).
_VERSION_FILE = Path("/etc/awg-setup/.version")
_UPDATE_CFG = Path("/etc/awg-setup/update-config.json")
_UPDATE_STATUS = Path("/run/awg-setup/update-status.json")
_IMAGE_VERSION = Path("/opt/gateway/VERSION")


def _read_update_config() -> dict:
    try:
        return json.loads(_UPDATE_CFG.read_text())
    except Exception:
        return {"mode": "manual", "scheduled_time": "04:30", "auto_level": "all",
                "channel": "upd-code", "keep_backups": 3}


class UpdateConfigReq(BaseModel):
    mode: str = "manual"
    scheduled_time: str = "04:30"
    auto_level: str = "all"
    keep_backups: int = 3


@app.get("/api/update/status")
def update_status(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    cur = ""
    try:
        cur = _VERSION_FILE.read_text().strip()
    except Exception:
        try:
            cur = _IMAGE_VERSION.read_text().strip()
        except Exception:
            cur = "?"
    status = {}
    try:
        status = json.loads(_UPDATE_STATUS.read_text())
    except Exception:
        pass
    return {"current": cur or "?", "status": status, "config": _read_update_config(),
            "update_inprogress": Path("/etc/awg-setup/.update-inprogress").exists()}


@app.post("/api/update/check")
def update_check(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    try:
        subprocess.Popen(_host_detached(["gateway-update.sh", "check"]),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    return {"ok": True}


@app.post("/api/update/apply")
def update_apply(req: SystemActionReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not req.confirm:
        return JSONResponse({"ok": False, "error": "Нужно подтверждение обновления"}, status_code=400)
    _wlog(f"WARN Запуск обновления через панель (user={_token_user(request)})")
    try:
        subprocess.Popen(_host_detached(["gateway-update.sh", "apply"]),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    return {"ok": True}


@app.post("/api/update/rollback")
def update_rollback(req: SystemActionReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if not req.confirm:
        return JSONResponse({"ok": False, "error": "Нужно подтверждение отката"}, status_code=400)
    _wlog(f"WARN Ручной откат обновления через панель (user={_token_user(request)})")
    try:
        subprocess.Popen(_host_detached(["gateway-update.sh", "rollback"]),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    return {"ok": True}


@app.get("/api/update/config")
def update_config_get(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    return _read_update_config()


@app.post("/api/update/config")
def update_config_set(req: UpdateConfigReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    if req.mode not in ("manual", "nightly", "scheduled"):
        return JSONResponse({"ok": False, "error": "Неизвестный режим"}, status_code=400)
    if req.auto_level not in ("all", "patch"):
        return JSONResponse({"ok": False, "error": "Неизвестный уровень"}, status_code=400)
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", req.scheduled_time or ""):
        return JSONResponse({"ok": False, "error": "Время в формате ЧЧ:ММ"}, status_code=400)
    keep = max(1, min(20, int(req.keep_backups or 3)))
    cfg = _read_update_config()
    cfg.update({"mode": req.mode, "scheduled_time": req.scheduled_time,
                "auto_level": req.auto_level, "keep_backups": keep,
                "channel": cfg.get("channel", "upd-code")})
    try:
        _UPDATE_CFG.write_text(json.dumps(cfg, ensure_ascii=False))
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    _wlog(f"INFO Режим обновлений: {req.mode} (user={_token_user(request)})")
    return {"ok": True, "config": cfg}


# ══ Кастомный МЭ: доступ к ресурсам + раздельное туннелирование ══════
# ДВЕ РАЗНЫЕ СУЩНОСТИ:
#  1) Раздельное туннелирование (настройка VPN) — список `direct`: домены идут
#     НАПРЯМУЮ мимо туннеля (банки, госуслуги). Применяется маршрутами на шлюзе.
#  2) Доступ к ресурсам (firewall ACL) — `groups`+`rules`+`hosts`: группы доменов
#     с именем/описанием, правило блокировки с областью по MAC (все/только/кроме).
#     Применяется через ipset+iptables (gw-access-apply). Резолв доменов в адреса
#     автоматический. Плюс простой глобальный DNS-блок по имени — список `block`.
FILTER_DIR = Path("/etc/awg-setup/filter")
RULES_FILE = FILTER_DIR / "rules.json"
_DOMAIN_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
)
_MAC_RE = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")
_HOSTNAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
LAN_PREFIX = "192.168.88."


def _norm_domain(d: str) -> str:
    """Нормализует ввод: принимает и домен, и URL -> чистый домен."""
    d = (d or "").strip().lower()
    d = re.sub(r"^https?://", "", d).split("/")[0].split(":")[0]
    if d.startswith("www."):
        d = d[4:]
    return d


def _norm_mac(m: str) -> str:
    return (m or "").strip().lower().replace("-", ":")


def _setname(gid: str) -> str:
    """ipset-имя для группы (<=31 символ, [a-z0-9_])."""
    safe = re.sub(r"[^a-z0-9]", "", str(gid).lower())[:24]
    return "gwacc_" + safe


def _new_id() -> str:
    return secrets.token_hex(4)


# ── Каталог известных сервисов: один домен/ссылка -> готовая группа адресов ──
# Всратый админ вписывает «youtube.com» — а разворачивается весь набор доменов
# ресурса. Если сервис неизвестен — берём сам домен (+ поддомены он накроет
# резолвом). Список курируемый, легко расширять.
KNOWN_SERVICES = {
    "youtube.com": ("YouTube", ["youtube.com", "youtu.be", "ytimg.com",
                                  "googlevideo.com", "ggpht.com", "yt3.ggpht.com",
                                  "youtube-nocookie.com", "youtubei.googleapis.com"]),
    "google.com": ("Google", ["google.com", "gstatic.com", "googleapis.com",
                               "googleusercontent.com", "google.ru"]),
    "instagram.com": ("Instagram", ["instagram.com", "cdninstagram.com", "fbcdn.net"]),
    "facebook.com": ("Facebook", ["facebook.com", "fbcdn.net", "fb.com", "fbsbx.com"]),
    "twitter.com": ("Twitter / X", ["twitter.com", "x.com", "twimg.com", "t.co"]),
    "x.com": ("Twitter / X", ["x.com", "twitter.com", "twimg.com", "t.co"]),
    "tiktok.com": ("TikTok", ["tiktok.com", "tiktokcdn.com", "tiktokv.com",
                              "ibytedtos.com", "muscdn.com"]),
    "telegram.org": ("Telegram", ["telegram.org", "t.me", "telegram.me",
                                   "telesco.pe", "cdn-telegram.org"]),
    "whatsapp.com": ("WhatsApp", ["whatsapp.com", "whatsapp.net"]),
    "discord.com": ("Discord", ["discord.com", "discordapp.com", "discord.gg",
                                "discordapp.net", "discord.media"]),
    "twitch.tv": ("Twitch", ["twitch.tv", "ttvnw.net", "jtvnw.net", "twitchcdn.net"]),
    "netflix.com": ("Netflix", ["netflix.com", "nflxvideo.net", "nflximg.net",
                                "nflxext.com", "nflxso.net"]),
    "vk.com": ("ВКонтакте", ["vk.com", "vk.ru", "userapi.com", "vkuservideo.net",
                             "vk-cdn.net", "mycdn.me"]),
    "ok.ru": ("Одноклассники", ["ok.ru", "odnoklassniki.ru", "mycdn.me"]),
    "gosuslugi.ru": ("Госуслуги", ["gosuslugi.ru", "esia.gosuslugi.ru",
                                   "pos.gosuslugi.ru", "gu-st.ru"]),
    "sberbank.ru": ("Сбербанк", ["sberbank.ru", "online.sberbank.ru", "sber.ru",
                                 "sberbank.com", "sbrf.ru"]),
    "tinkoff.ru": ("Т-Банк", ["tinkoff.ru", "tbank.ru", "tcsbank.ru", "cdn-tinkoff.ru"]),
}


def _expand_domain(raw: str):
    """domain/url -> (имя, [домены]). Известный сервис -> весь набор."""
    d = _norm_domain(raw)
    if not d:
        return "", []
    if d in KNOWN_SERVICES:
        name, doms = KNOWN_SERVICES[d]
        return name, list(doms)
    return d, [d]


SPLIT_DEFAULT = Path("/etc/awg-setup/split-default.json")


def _load_rules() -> dict:
    """Полная структура правил. Недостающие ключи дополняем (миграция со старых).
    split — ресурсы раздельного туннелирования: {id,name,desc,domains[],cidrs[]}."""
    base = {"block": [], "direct": [], "groups": [], "hosts": [], "split": []}
    fresh = not RULES_FILE.exists()
    try:
        r = json.loads(RULES_FILE.read_text())
        for k in base:
            if isinstance(r.get(k), list):
                base[k] = r[k]
    except Exception:
        pass
    # На СВЕЖЕМ шлюзе (rules.json ещё нет) подсеваем стандартный шаблон
    # раздельного туннелирования (RU-обход: госуслуги/банки/…), вшитый в образ.
    if fresh and not base["split"] and SPLIT_DEFAULT.exists():
        try:
            d = json.loads(SPLIT_DEFAULT.read_text())
            res = d.get("resources", d) if isinstance(d, dict) else d
            for x in (res or []):
                doms = [nd for nd in (_norm_domain(y) for y in x.get("domains", [])) if _DOMAIN_RE.match(nd)]
                cidrs = [c for c in (_valid_cidr(y) for y in x.get("cidrs", [])) if c]
                if doms or cidrs:
                    base["split"].append({"id": _new_id(), "name": str(x.get("name", "")).strip() or (doms[0] if doms else cidrs[0]),
                                          "desc": str(x.get("desc", "")).strip(), "domains": doms, "cidrs": cidrs})
        except Exception:
            pass
    # миграция старых плоских direct-доменов в split-ресурсы
    if base["direct"] and not base["split"]:
        for d in base["direct"]:
            base["split"].append({"id": _new_id(), "name": d, "desc": "",
                                  "domains": [d], "cidrs": []})
        base["direct"] = []
    return base


def _write_plan_files(data: dict) -> None:
    """Генерит плоские файлы-планы для dnsmasq и хелперов (sh не парсит JSON)."""
    FILTER_DIR.mkdir(parents=True, exist_ok=True)

    # (1) Глобальный DNS-блок по имени: A->0.0.0.0 и AAAA->:: (иначе обход по IPv6)
    block_lines = []
    for d in data.get("block", []):
        block_lines.append(f"address=/{d}/0.0.0.0")
        block_lines.append(f"address=/{d}/::")
    (FILTER_DIR / "block.conf").write_text("\n".join(block_lines) + "\n")

    # (2) Раздельное туннелирование: домены + подсети «напрямую» (gw-access-routes).
    # Собираем из split-ресурсов (домены резолвятся в рантайме, cidrs — статикой).
    dom_lines, cidr_lines = [], []
    for res in data.get("split", []):
        for dom in res.get("domains", []):
            nd = _norm_domain(dom)
            if nd:
                dom_lines.append(nd)
        for c in res.get("cidrs", []):
            c = (c or "").strip()
            if c:
                cidr_lines.append(c)
    for d in data.get("direct", []):       # legacy
        dom_lines.append(d)
    (FILTER_DIR / "direct.list").write_text("\n".join(dom_lines) + "\n")
    # Защита туннеля: в файл маршрутов «напрямую» не пускаем слишком широкие
    # супер-сети и служебные/внутренние диапазоны (см. _safe_direct_cidr).
    safe_cidrs, dropped = [], 0
    for c in cidr_lines:
        if _safe_direct_cidr(c):
            safe_cidrs.append(c)
        else:
            dropped += 1
    if dropped:
        _wlog(f"WARN Отброшено {dropped} опасных подсетей обхода (широкие/внутренние) — защита VPN-туннеля")
    (FILTER_DIR / "direct-cidrs.list").write_text("\n".join(safe_cidrs) + "\n")

    # (3)+(4) Группы -> ipset-наборы + правила. Блок-политика (scope/macs)
    # хранится ВНУТРИ группы: создал группу, накидал сайтов — оно режет.
    # scope=off -> группа есть, но не блокирует (пока).
    set_lines, rule_lines = [], []
    for g in data.get("groups", []):
        gid = g.get("id")
        if not gid:
            continue
        sn = _setname(gid)
        for dom in g.get("domains", []):
            dom = _norm_domain(dom)
            if dom:
                set_lines.append(f"{sn} {dom}")
        scope = g.get("scope", "all")
        if scope in ("all", "only", "except") and g.get("domains"):
            macs = ",".join(_norm_mac(m) for m in g.get("macs", []) if _MAC_RE.match(_norm_mac(m)))
            rule_lines.append(f"{sn}|block|{scope}|{macs}")
    (FILTER_DIR / "access-sets.txt").write_text("\n".join(set_lines) + "\n")
    (FILTER_DIR / "access-rules.txt").write_text("\n".join(rule_lines) + "\n")

    # (5) DHCP-резервирования (вечные адреса по MAC) -> dnsmasq dhcp-host
    res_lines = []
    for h in data.get("hosts", []):
        mac = _norm_mac(h.get("mac", ""))
        ip = (h.get("ip") or "").strip()
        if not _MAC_RE.match(mac) or not ip.startswith(LAN_PREFIX):
            continue
        name = (h.get("name") or "").strip().lower()
        if _HOSTNAME_RE.match(name):
            res_lines.append(f"dhcp-host={mac},{ip},{name}")
        else:
            res_lines.append(f"dhcp-host={mac},{ip}")
    (FILTER_DIR / "reservations.conf").write_text("\n".join(res_lines) + "\n")

    # (6) Политика по устройству -> device-policy.txt (MAC|egress|isolated).
    #     Потребляет gw-direct-clients.sh (egress-метки + изоляция). Совместимость:
    #     старое поле direct=true трактуем как egress=internet.
    pol_lines, direct_macs = [], []
    for h in data.get("hosts", []):
        mac = _norm_mac(h.get("mac", ""))
        if not _MAC_RE.match(mac):
            continue
        egress = h.get("egress")
        if egress not in ("vpn", "internet", "local"):
            egress = "internet" if h.get("direct") else "vpn"
        isolated = "1" if h.get("isolated") else "0"
        # пишем только НЕ-дефолтные (vpn без изоляции = по умолчанию, строка не нужна)
        if egress != "vpn" or isolated == "1":
            pol_lines.append(f"{mac}|{egress}|{isolated}")
        if egress == "internet":
            direct_macs.append(mac)
    (FILTER_DIR / "device-policy.txt").write_text("\n".join(pol_lines) + "\n")
    (FILTER_DIR / "direct-clients.txt").write_text("\n".join(direct_macs) + "\n")  # совместимость


def _apply_rules(data: dict) -> None:
    """Сохраняет rules.json, пишет планы, перечитывает dnsmasq, применяет ACL."""
    FILTER_DIR.mkdir(parents=True, exist_ok=True)
    RULES_FILE.write_text(json.dumps(data, ensure_ascii=False))
    _write_plan_files(data)
    # block.conf + reservations.conf подхватываются рестартом dnsmasq (быстрый).
    try:
        subprocess.run(["docker", "restart", "-t", "2", "gw-dnsmasq"],
                       capture_output=True, timeout=15)
    except Exception:
        pass
    # Маршруты «напрямую», ACL групп и per-device обход — В ФОНЕ (не держим ответ).
    for helper in ("gw-access-routes", "gw-access-apply", "gw-direct-clients"):
        try:
            subprocess.Popen(["docker", "exec", "gw-awg", helper],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass


# ── Ф4: адаптивная сегментация сети (VLAN L2 / L3-политики) ──────────────────
# Топология — СОСТОЯНИЕ (network.json), переживает обновления (§В.4). webui генерит
# плоские файлы, gw-network-apply (в gw-awg) применяет L2/L3 + egress + изоляцию.
# Адаптивность: VLAN-сегмент поднимается на 802.1Q если ядро умеет, иначе L3.
_NETWORK_FILE = Path("/etc/awg-setup/network.json")
_NET_DHCP_CONF = FILTER_DIR / "zz-network-dhcp.conf"   # настоящий dnsmasq-конфиг
# .list (не .conf!): dnsmasq читает в conf-dir только *.conf — этот плоский файл
# для gw-network-apply, на .conf он бы упал «bad option».
_NET_SEG_CONF = FILTER_DIR / "network-segments.list"


def _default_segment() -> dict:
    return {"id": "default", "name": "Основная сеть", "subnet": "192.168.88.0/24",
            "gateway_ip": "192.168.88.1", "dhcp_start": "192.168.88.10",
            "dhcp_end": "192.168.88.250", "lease": "90d", "egress": "vpn",
            "vlan_id": None, "isolated": False, "reachable_from": "all"}


def _load_network() -> dict:
    try:
        d = json.loads(_NETWORK_FILE.read_text())
        if isinstance(d, dict) and isinstance(d.get("segments"), list) and d["segments"]:
            return d
    except Exception:
        pass
    return {"version": 1, "segments": [_default_segment()]}


def _write_network_files(data: dict) -> None:
    FILTER_DIR.mkdir(parents=True, exist_ok=True)
    seg_lines, dhcp_lines = [], []
    for s in data.get("segments", []):
        vid = s.get("vlan_id")
        vid = str(vid) if vid not in (None, "") else ""
        seg_lines.append("|".join([
            str(s.get("id", "")), str(s.get("name", "")), str(s.get("subnet", "")),
            str(s.get("gateway_ip", "")), str(s.get("dhcp_start", "")),
            str(s.get("dhcp_end", "")), str(s.get("lease", "90d")),
            str(s.get("egress", "vpn")), vid, "1" if s.get("isolated") else "0",
            str(s.get("reachable_from", "all"))]))
        # DHCP только для VLAN-сегментов (default обслуживает baked dnsmasq.conf).
        # Адрес шлюза/DNS клиентам dnsmasq отдаёт = IP интерфейса br-lan.<vid> сам.
        if vid and s.get("dhcp_start") and s.get("dhcp_end"):
            ifn = f"br-lan.{vid}"
            dhcp_lines.append(f"interface={ifn}")
            dhcp_lines.append(f"dhcp-range={s['dhcp_start']},{s['dhcp_end']},{s.get('lease', '90d')}")
    _NET_SEG_CONF.write_text("\n".join(seg_lines) + "\n")
    _NET_DHCP_CONF.write_text("\n".join(dhcp_lines) + "\n")


def _apply_network(data: dict) -> None:
    _NETWORK_FILE.write_text(json.dumps(data, ensure_ascii=False))
    _write_network_files(data)
    # Сначала создаём VLAN-интерфейсы (gw-network-apply), потом рестарт dnsmasq —
    # чтобы он забиндился на новые br-lan.<vid> и отдал их диапазоны.
    try:
        subprocess.run(["docker", "exec", "gw-awg", "gw-network-apply"],
                       capture_output=True, timeout=30)
    except Exception:
        pass
    try:
        subprocess.run(["docker", "restart", "-t", "2", "gw-dnsmasq"],
                       capture_output=True, timeout=15)
    except Exception:
        pass


_SEG_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,20}$")
_CIDR_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$")


def _validate_segments(segs: list) -> str:
    """Возвращает '' если ок, иначе текст ошибки."""
    import ipaddress
    if not segs:
        return "Должен быть хотя бы сегмент по умолчанию"
    ids, nets, vids = set(), [], set()
    has_default = False
    for s in segs:
        sid = (s.get("id") or "").strip()
        if not _SEG_ID_RE.match(sid):
            return f"Некорректный id сегмента: {sid!r}"
        if sid in ids:
            return f"Дублирующийся id: {sid}"
        ids.add(sid)
        if sid == "default":
            has_default = True
        if (s.get("egress") or "vpn") not in ("vpn", "internet", "local"):
            return f"Сегмент {sid}: egress должен быть vpn/internet/local"
        sub = (s.get("subnet") or "").strip()
        if not _CIDR_RE.match(sub):
            return f"Сегмент {sid}: некорректная подсеть {sub!r}"
        try:
            net = ipaddress.ip_network(sub, strict=False)
        except Exception:
            return f"Сегмент {sid}: невалидная подсеть {sub}"
        if net.prefixlen < 8:
            return f"Сегмент {sid}: подсеть слишком широкая (минимум /8)"
        # 10.0.0.0/8 запрещён — его раздаёт VPN-сервер, пересечётся с туннелем.
        if net.overlaps(ipaddress.ip_network("10.0.0.0/8")):
            return f"Сегмент {sid}: 10.0.0.0/8 нельзя (его использует VPN). Возьмите 100.64.x.0/24 или 192.168.x.0/24"
        gw = (s.get("gateway_ip") or "").strip()
        if gw:
            try:
                if ipaddress.ip_address(gw) not in net:
                    return f"Сегмент {sid}: шлюз {gw} вне подсети {sub}"
            except Exception:
                return f"Сегмент {sid}: некорректный IP шлюза {gw}"
        for prev in nets:
            if net.overlaps(prev):
                return f"Сегмент {sid}: подсеть {sub} пересекается с другим сегментом"
        nets.append(net)
        vid = s.get("vlan_id")
        if vid not in (None, ""):
            try:
                vi = int(vid)
            except Exception:
                return f"Сегмент {sid}: vlan_id должен быть числом"
            if not (1 <= vi <= 4094):
                return f"Сегмент {sid}: vlan_id 1..4094"
            if vi in vids:
                return f"Дублирующийся vlan_id: {vi}"
            vids.add(vi)
    if not has_default:
        return "Нельзя удалить сегмент «default» (основная сеть)"
    # reachable_from: all | none | список существующих id через запятую
    for s in segs:
        rf = (s.get("reachable_from") or "all").strip()
        if rf in ("all", "none"):
            continue
        for ref in rf.split(","):
            ref = ref.strip()
            if ref and ref not in ids:
                return f"Сегмент {s.get('id')}: «доступен из» ссылается на несуществующий сегмент {ref}"
    return ""


class NetworkReq(BaseModel):
    segments: list


@app.get("/api/network/segments")
def network_get(request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    cap = False
    try:
        rc, out, _ = _run(["docker", "exec", "gw-awg", "sh", "-c",
                           "modprobe 8021q 2>/dev/null; lsmod | grep -q 8021q && echo yes"])
        cap = "yes" in (out or "")
    except Exception:
        pass
    return {**_load_network(), "vlan_capable": cap}


@app.post("/api/network/segments")
def network_set(req: NetworkReq, request: Request):
    if not _is_admin(request):
        return JSONResponse({"error": "Доступно только администратору"}, status_code=403)
    segs = req.segments or []
    for s in segs:
        v = s.get("vlan_id")
        s["vlan_id"] = int(v) if str(v).strip().isdigit() else None
        s["isolated"] = bool(s.get("isolated"))
        s["reachable_from"] = (s.get("reachable_from") or "all").strip() or "all"
    err = _validate_segments(segs)
    if err:
        return JSONResponse({"ok": False, "error": err}, status_code=400)
    try:
        _apply_network({"version": 1, "segments": segs})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=500)
    _wlog(f"INFO Сегменты сети обновлены ({len(segs)}) (user={_token_user(request)})")
    return {"ok": True, "segments": segs}


def _vpn_route_count() -> int:
    """Сколько диапазонов было в ИСХОДНОМ ключе (до нормализации в 0.0.0.0/0).
    Теперь весь трафик идёт через VPN, а маршрутизацией рулит шлюз."""
    try:
        orig = Path("/etc/awg-setup/filter/orig-allowedips.txt").read_text()
        c = len([x for x in orig.split(",") if "/" in x])
        if c:
            return c
    except Exception:
        pass
    try:
        conf = Path("/etc/amnezia/awg0.conf").read_text()
        m = re.search(r"(?im)^AllowedIPs\s*=\s*(.+)$", conf)
        if m:
            return len([x for x in m.group(1).split(",") if "/" in x])
    except Exception:
        pass
    return 0


def _routed_ranges() -> list[str]:
    """Диапазоны из ИСХОДНОГО AllowedIPs загруженного ключа (до нормализации).
    Показываем их в «Раздельном туннелировании» — что ключ маршрутизировал."""
    try:
        orig = Path("/etc/awg-setup/filter/orig-allowedips.txt").read_text()
        return [x.strip() for x in orig.split(",") if "/" in x]
    except Exception:
        return []


@app.get("/api/access")
def api_access():
    data = _load_rules()
    return {
        "block": sorted(data["block"]),
        "direct": sorted(data["direct"]),
        "split": data["split"],
        "groups": data["groups"],
        "hosts": data["hosts"],
        "vpn_route_count": _vpn_route_count(),
        "routed_ranges": _routed_ranges(),
        # дырки = что в ключе шло НАПРЯМУЮ (это и есть обход, собирается в split)
        "holes": _compute_holes(",".join(_routed_ranges())),
    }


# ── (1) Простые списки: глобальный блок по имени + раздельное туннелирование ──
class AccessReq(BaseModel):
    action: str   # add | remove
    kind: str     # block | direct
    domain: str


@app.post("/api/access")
def api_access_set(req: AccessReq):
    if req.kind not in ("block", "direct"):
        raise HTTPException(status_code=400, detail="bad kind")
    d = _norm_domain(req.domain)
    data = _load_rules()
    if req.action == "add":
        if not _DOMAIN_RE.match(d):
            return {"ok": False, "error": "Некорректный домен"}
        if d not in data[req.kind]:
            data[req.kind].append(d)
    elif req.action == "remove":
        data[req.kind] = [x for x in data[req.kind] if x != d]
    else:
        raise HTTPException(status_code=400, detail="bad action")
    _apply_rules(data)
    return {"ok": True, "block": sorted(data["block"]), "direct": sorted(data["direct"])}


# ── Авто-разворачивание ресурса: домен/ссылка -> имя + набор доменов ──
@app.get("/api/access/expand")
def api_access_expand(domain: str = ""):
    name, doms = _expand_domain(domain)
    if not doms:
        return {"ok": False, "error": "Пустой или некорректный адрес"}
    return {"ok": True, "name": name, "domains": doms,
            "known": _norm_domain(domain) in KNOWN_SERVICES}


# ── Группы: имя/описание + сайты (авто-резолв) + блок-политика по MAC ──
# Одна сущность: создал группу → накидал сайтов (авто-разворот) → задал, кому
# блокировать (всем / только этим / всем кроме). Имя и описание необязательны.
def _valid_scope(s: str) -> str:
    return s if s in ("all", "only", "except", "off") else "all"


class GroupReq(BaseModel):
    action: str   # create | update | delete | add_domain | del_domain
    id: str | None = None
    name: str = ""
    desc: str = ""
    domains: list[str] = []
    domain: str = ""          # для add_domain / del_domain
    scope: str = "all"        # all | only | except | off
    macs: list[str] = []


@app.post("/api/access/group")
def api_access_group(req: GroupReq):
    data = _load_rules()
    groups = data["groups"]
    g = next((x for x in groups if x.get("id") == req.id), None) if req.id else None
    macs = [m for m in (_norm_mac(x) for x in req.macs) if _MAC_RE.match(m)]

    if req.action == "delete":
        data["groups"] = [x for x in groups if x.get("id") != req.id]
    elif req.action == "create":
        # домены при создании необязательны (можно создать пустую и добавлять потом)
        doms = []
        for d in req.domains:
            for nd in _expand_domain(d)[1]:
                if _DOMAIN_RE.match(nd) and nd not in doms:
                    doms.append(nd)
        groups.append({"id": _new_id(), "name": req.name.strip(), "desc": req.desc.strip(),
                       "domains": doms, "scope": _valid_scope(req.scope), "macs": macs})
    elif req.action == "update":
        if not g:
            return {"ok": False, "error": "Группа не найдена"}
        scope = _valid_scope(req.scope)
        if scope in ("only", "except") and not macs:
            return {"ok": False, "error": "Для этой области выберите устройства"}
        g.update({"name": req.name.strip(), "desc": req.desc.strip(),
                  "scope": scope, "macs": macs})
    elif req.action == "add_domain":
        if not g:
            return {"ok": False, "error": "Группа не найдена"}
        added = []
        for nd in _expand_domain(req.domain)[1]:   # авто-разворот известных сервисов
            if _DOMAIN_RE.match(nd) and nd not in g.get("domains", []):
                g.setdefault("domains", []).append(nd)
                added.append(nd)
        if not added:
            return {"ok": False, "error": "Адрес пустой/некорректный или уже в группе"}
    elif req.action == "del_domain":
        if not g:
            return {"ok": False, "error": "Группа не найдена"}
        nd = _norm_domain(req.domain)
        g["domains"] = [x for x in g.get("domains", []) if x != nd]
    else:
        raise HTTPException(status_code=400, detail="bad action")
    _apply_rules(data)
    return {"ok": True, "groups": data["groups"]}


# ── (2) Хосты: имя + закреплённый IP (DHCP-резерв, вечный адрес) ──
class HostReq(BaseModel):
    action: str                  # save | delete
    mac: str
    name: str = ""
    ip: str = ""


@app.post("/api/access/host")
def api_access_host(req: HostReq):
    mac = _norm_mac(req.mac)
    if not _MAC_RE.match(mac):
        return {"ok": False, "error": "Некорректный MAC"}
    data = _load_rules()
    hosts = [h for h in data["hosts"] if _norm_mac(h.get("mac", "")) != mac]
    if req.action == "save":
        ip = req.ip.strip()
        if ip and not (ip.startswith(LAN_PREFIX) and ip.count(".") == 3):
            return {"ok": False, "error": f"IP должен быть из подсети {LAN_PREFIX}0/24"}
        hosts.append({"mac": mac, "name": req.name.strip(), "ip": ip})
    elif req.action != "delete":
        raise HTTPException(status_code=400, detail="bad action")
    data["hosts"] = hosts
    _apply_rules(data)
    return {"ok": True, "hosts": data["hosts"]}


# ── Политика по устройству: выход (vpn/internet/local) + изоляция ──
class HostPolicyReq(BaseModel):
    mac: str
    egress: str = "vpn"          # vpn | internet | local
    isolated: bool = False


_EGRESS_RU = {"vpn": "через VPN", "internet": "напрямую в интернет", "local": "только локальная сеть"}


@app.post("/api/access/host-policy")
def api_host_policy(req: HostPolicyReq):
    mac = _norm_mac(req.mac)
    if not _MAC_RE.match(mac):
        return {"ok": False, "error": "Некорректный MAC"}
    if req.egress not in ("vpn", "internet", "local"):
        return {"ok": False, "error": "Неизвестный режим выхода"}
    data = _load_rules()
    h = next((x for x in data["hosts"] if _norm_mac(x.get("mac", "")) == mac), None)
    if h is None:
        h = {"mac": mac, "name": "", "ip": ""}
        data["hosts"].append(h)
    h["egress"] = req.egress
    h["isolated"] = bool(req.isolated)
    h["direct"] = (req.egress == "internet")   # совместимость со старым полем
    _apply_rules(data)
    _wlog(f"INFO Устройство {mac}: {_EGRESS_RU[req.egress]}{', изолировано' if req.isolated else ''}")
    return {"ok": True}


# совместимость: старый тумблер «мимо VPN»
class HostDirectReq(BaseModel):
    mac: str
    direct: bool


@app.post("/api/access/host-direct")
def api_host_direct(req: HostDirectReq):
    return api_host_policy(HostPolicyReq(mac=req.mac, egress=("internet" if req.direct else "vpn")))


# ══ Раздельное туннелирование: ресурсы (имя/описание/домены/подсети) ══════
# В ОБЕ СТОРОНЫ (как в vpn_awg_2_VPS_pub):
#  вперёд  — домен -> резолв в адреса (маршрут мимо VPN, gw-access-routes);
#  назад   — диапазоны из AllowedIPs ключа подписываются именем ресурса по
#            импортированной карте имя↔подсети.
_CIDR_RE = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3}/\d{1,2})\b")


def _resolve_v4(host: str) -> list[str]:
    try:
        return sorted({i[4][0] for i in socket.getaddrinfo(host, None, socket.AF_INET)})
    except Exception:
        return []


def _resolve_cidrs(host: str) -> list[str]:
    """Домен -> его адреса, свёрнутые в /24 (как в VPS-проекте). Авто-сбор."""
    cidrs = set()
    for ip in _resolve_v4(host):
        try:
            cidrs.add(str(ipaddress.ip_network(ip + "/24", strict=False)))
        except Exception:
            pass
    return sorted(cidrs)


def _valid_cidr(c: str) -> str:
    try:
        return str(ipaddress.ip_network((c or "").strip(), strict=False))
    except Exception:
        return ""


# ── ЗАЩИТА ТУННЕЛЯ ────────────────────────────────────────────────
# Маршрут «напрямую» (мимо VPN) ставится в таблицу main; правило
# `suppress_prefixlength 0` глушит только /0, поэтому ЛЮБАЯ подсеть с
# префиксом >= /1 побеждает таблицу туннеля. Значит, в обход VPN нельзя
# отдавать:
#   • слишком широкие супер-сети (артефакты collapse_addresses над набором
#     антифильтра: 0.0.0.0/1, 128.0.0.0/2, 192.0.0.0/4 … — уводят ВЕСЬ трафик);
#   • служебные/внутренние сети (RFC1918 покрывает LAN 192.168.88/24,
#     WAN-подсеть 192.168.0/24, docker 172.17/16 и внутреннюю сеть туннеля
#     10.13.13/24) и спец-диапазоны — иначе рвём работу шлюза/туннеля.
# Зеркалит фильтр route_safe() в gw-access-routes.sh.
_MIN_DIRECT_PREFIX = 8
_PROTECTED_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
    "224.0.0.0/3", "240.0.0.0/4",
)]


def _safe_direct_cidr(c: str) -> bool:
    """True, если подсеть безопасно маршрутизировать «напрямую» мимо VPN."""
    try:
        net = ipaddress.ip_network((c or "").strip(), strict=False)
    except Exception:
        return False
    if net.version != 4 or net.prefixlen < _MIN_DIRECT_PREFIX:
        return False
    return not any(net.overlaps(p) for p in _PROTECTED_NETS)


def _parse_vps_bypass(text: str) -> list[dict]:
    """Парсит VPS-формат: строка «имя — описание» (или «имя: cidr»), за ней
    строка с подсетями через запятую. Терпим к маркерам •/-/*."""
    resources, cur = [], None
    for raw in text.splitlines():
        line = raw.strip().lstrip("•*").strip()
        if not line:
            continue
        cidrs = _CIDR_RE.findall(line)
        if cidrs and re.sub(r"[\d./,\s]", "", line) == "":   # строка ТОЛЬКО из подсетей
            if cur is not None:
                cur["cidrs"].extend(cidrs)
            continue
        head = _CIDR_RE.sub("", line).rstrip(" :,—–-").strip()
        parts = re.split(r"\s+[—–-]\s+|:\s+", head, maxsplit=1)
        name = parts[0].strip()
        desc = parts[1].strip() if len(parts) > 1 else ""
        nd = _norm_domain(name)
        cur = {"id": _new_id(), "name": name, "desc": desc,
               "domains": [nd] if _DOMAIN_RE.match(nd) else [], "cidrs": list(cidrs)}
        resources.append(cur)
    return resources


class SplitReq(BaseModel):
    action: str   # create|update|delete|add_domain|del_domain|add_cidr|del_cidr
    id: str | None = None
    name: str = ""
    desc: str = ""
    domains: list[str] = []
    cidrs: list[str] = []
    domain: str = ""
    cidr: str = ""


@app.post("/api/split")
def api_split(req: SplitReq):
    data = _load_rules()
    sp = data["split"]
    r = next((x for x in sp if x.get("id") == req.id), None) if req.id else None
    if req.action == "delete":
        data["split"] = [x for x in sp if x.get("id") != req.id]
    elif req.action == "create":
        doms = [nd for nd in (_norm_domain(d) for d in req.domains) if _DOMAIN_RE.match(nd)]
        # одиночный ввод может быть и доменом, и подсетью/IP
        one = (req.name or "").strip()
        if one and not doms and not req.cidrs:
            nd = _norm_domain(one)
            if _DOMAIN_RE.match(nd):
                doms = [nd]
            elif _valid_cidr(one):
                req.cidrs = [one]
        cidrs = [c for c in (_valid_cidr(x) for x in req.cidrs) if c]
        if not (doms or cidrs):
            return {"ok": False, "error": "Укажите домен/ссылку или подсеть"}
        # АВТО-СБОР: домен -> его /24-подсети сразу (ничего вручную не надо)
        for d in doms:
            for c in _resolve_cidrs(d):
                if c not in cidrs:
                    cidrs.append(c)
        name = req.name.strip() or (doms[0] if doms else cidrs[0])
        sp.append({"id": _new_id(), "name": name, "desc": req.desc.strip(),
                   "domains": doms, "cidrs": cidrs})
    elif req.action == "update":
        if not r:
            return {"ok": False, "error": "Ресурс не найден"}
        r.update({"name": req.name.strip(), "desc": req.desc.strip()})
    elif req.action == "add_domain":
        if not r:
            return {"ok": False, "error": "Ресурс не найден"}
        nd = _norm_domain(req.domain)
        if not _DOMAIN_RE.match(nd):
            return {"ok": False, "error": "Некорректный домен"}
        if nd not in r.get("domains", []):
            r.setdefault("domains", []).append(nd)
        for c in _resolve_cidrs(nd):            # авто-сбор адресов
            if c not in r.setdefault("cidrs", []):
                r["cidrs"].append(c)
    elif req.action == "refresh":
        if not r:
            return {"ok": False, "error": "Ресурс не найден"}
        for d in r.get("domains", []):          # перерезолвить адреса (IP меняются)
            for c in _resolve_cidrs(d):
                if c not in r.setdefault("cidrs", []):
                    r["cidrs"].append(c)
    elif req.action == "del_domain":
        if not r:
            return {"ok": False, "error": "Ресурс не найден"}
        r["domains"] = [x for x in r.get("domains", []) if x != _norm_domain(req.domain)]
    elif req.action == "add_cidr":
        if not r:
            return {"ok": False, "error": "Ресурс не найден"}
        c = _valid_cidr(req.cidr)
        if not c:
            return {"ok": False, "error": "Некорректная подсеть/IP"}
        if c not in r.get("cidrs", []):
            r.setdefault("cidrs", []).append(c)
    elif req.action == "del_cidr":
        if not r:
            return {"ok": False, "error": "Ресурс не найден"}
        r["cidrs"] = [x for x in r.get("cidrs", []) if x != req.cidr]
    else:
        raise HTTPException(400, "bad action")
    _apply_rules(data)
    return {"ok": True, "split": data["split"]}


class SplitImportReq(BaseModel):
    text: str = ""
    resources: list[dict] = []


@app.post("/api/split/import")
def api_split_import(req: SplitImportReq):
    """Импорт карты раздельного туннелирования: текст VPS-формата ИЛИ JSON."""
    added = _parse_vps_bypass(req.text) if req.text.strip() else []
    for res in req.resources:
        doms = [nd for nd in (_norm_domain(d) for d in res.get("domains", [])) if _DOMAIN_RE.match(nd)]
        cidrs = [c for c in (_valid_cidr(x) for x in res.get("cidrs", [])) if c]
        if not (doms or cidrs):
            continue
        added.append({"id": str(res.get("id") or _new_id()),
                      "name": str(res.get("name", "")).strip() or (doms[0] if doms else cidrs[0]),
                      "desc": str(res.get("desc", "")).strip(), "domains": doms, "cidrs": cidrs})
    # нормализуем подсети (текстовый парсер мог собрать «голые» строки)
    for a in added:
        a["cidrs"] = [c for c in (_valid_cidr(x) for x in a.get("cidrs", [])) if c]
    if not added:
        return {"ok": False, "error": "Не распознано ни одного ресурса"}
    data = _load_rules()
    data["split"].extend(added)
    _apply_rules(data)
    return {"ok": True, "added": len(added), "split": data["split"]}


@app.get("/api/split/export")
def api_split_export():
    data = _load_rules()
    body = json.dumps({"version": 1, "resources": data["split"]},
                      ensure_ascii=False, indent=2)
    return Response(content=body, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="split-tunnel.json"'})


def _compute_holes(ranges_text: str) -> list[str]:
    """Дополнение AllowedIPs внутри 0.0.0.0/0 = «дырки» = что шло НАПРЯМУЮ.
    Антифильтр-ключ = 0/0 минус дырки; разворачиваем обратно в дырки."""
    nets = []
    for x in ranges_text.split(","):
        x = x.strip()
        if "/" in x and ":" not in x:
            try:
                nets.append(ipaddress.ip_network(x, strict=False))
            except Exception:
                pass
    if not nets:
        return []
    remaining = [ipaddress.ip_network("0.0.0.0/0")]
    for net in ipaddress.collapse_addresses(nets):
        newrem = []
        for r in remaining:
            if not r.overlaps(net):
                newrem.append(r)
            elif net.subnet_of(r):
                try:
                    newrem.extend(r.address_exclude(net))
                except ValueError:
                    pass
            # r внутри net -> r целиком исчезает (не добавляем)
        remaining = newrem
    return [str(h) for h in ipaddress.collapse_addresses(remaining)]


def _consolidate_split(data: dict) -> int:
    """Очистка от лишнего: внутри каждого ресурса схлопываем cidrs (убираем
    вложенные и сливаем смежные). Возвращает, сколько диапазонов убрано."""
    removed = 0
    for res in data.get("split", []):
        nets = []
        for c in res.get("cidrs", []):
            try:
                nets.append(ipaddress.ip_network(c, strict=False))
            except Exception:
                pass
        if nets:
            collapsed = [str(n) for n in ipaddress.collapse_addresses(nets)]
            # collapse_addresses над почти-полным набором рождает супер-сети
            # (0.0.0.0/1, 128.0.0.0/2 …), которые увели бы весь трафик мимо
            # VPN — выкидываем их и служебные/внутренние диапазоны.
            collapsed = [c for c in collapsed if _safe_direct_cidr(c)]
            removed += max(0, len(res["cidrs"]) - len(collapsed))
            res["cidrs"] = collapsed
    return removed


def _merge_holes_into_split(data: dict, holes: list[str]) -> dict:
    """Дырки ключа -> split. Широкая дырка СХЛОПЫВАЕТ узкие ручные диапазоны
    в один (под именем ресурса). Дубли пропускает. Потом общая консолидация."""
    added = merged = removed = 0
    for h in holes:
        try:
            hnet = ipaddress.ip_network(h, strict=False)
        except Exception:
            continue
        host_res = None
        narrower = []          # (ресурс, cidr) которые УЖЕ — внутри дырки
        covered = False        # дырка уже покрыта существующим (равна/уже)
        for res in data["split"]:
            for c in list(res.get("cidrs", [])):
                try:
                    cnet = ipaddress.ip_network(c, strict=False)
                except Exception:
                    continue
                if cnet == hnet or hnet.subnet_of(cnet):
                    covered = True
                elif cnet.subnet_of(hnet):
                    narrower.append((res, c))
                    if host_res is None:
                        host_res = res
        if covered and not narrower:
            continue
        if narrower:           # схлопываем узкие в широкую под именем ресурса
            for res, c in narrower:
                res["cidrs"] = [x for x in res["cidrs"] if x != c]
                removed += 1
            if h not in host_res.get("cidrs", []):
                host_res.setdefault("cidrs", []).append(h)
            merged += 1
        else:                  # новый диапазон -> отдельный ресурс
            data["split"].append({"id": _new_id(), "name": f"из ключа {h}",
                                  "desc": "авто из AllowedIPs", "domains": [], "cidrs": [h]})
            added += 1
    removed += _consolidate_split(data)
    return {"holes": len(holes), "added": added, "merged": merged, "removed_redundant": removed}


@app.post("/api/vpn/extract-holes")
def api_extract_holes():
    """Собрать обход из загруженного ключа: дырки AllowedIPs -> split-ресурсы,
    с консолидацией (узкие схлопываются в широкие, дубли пропускаются)."""
    try:
        orig = Path("/etc/awg-setup/filter/orig-allowedips.txt").read_text()
    except Exception:
        orig = ""
    holes = _compute_holes(orig)
    if not holes:
        return {"ok": False, "error": "В ключе нет дырок (AllowedIPs пустой или 0.0.0.0/0)"}
    data = _load_rules()
    stats = _merge_holes_into_split(data, holes)
    _apply_rules(data)
    return {"ok": True, **stats, "split": data["split"]}


@app.get("/api/vpn/routed-labeled")
def api_routed_labeled():
    """Обратная подпись: диапазоны из AllowedIPs ключа -> имя ресурса по карте
    split (подсети ресурсов + резолв их доменов в /24). Неузнанные -> resource=null."""
    ranges = _routed_ranges()
    data = _load_rules()
    nets = []
    for res in data.get("split", []):
        nm = res.get("name") or (res.get("domains") or [""])[0]
        for c in res.get("cidrs", []):
            try:
                nets.append((ipaddress.ip_network(c, strict=False), nm))
            except Exception:
                pass
        for dom in res.get("domains", [])[:5]:
            for ip in _resolve_v4(dom):
                try:
                    nets.append((ipaddress.ip_network(ip + "/24", strict=False), nm))
                except Exception:
                    pass
    out, summary = [], {}
    for rr in ranges:
        try:
            net = ipaddress.ip_network(rr, strict=False)
            label = next((nm for n, nm in nets if net.overlaps(n)), None)
        except Exception:
            label = None
        out.append({"cidr": rr, "resource": label})
        key = label or "—"
        summary[key] = summary.get(key, 0) + 1
    return {"ranges": out, "summary": summary, "total": len(ranges),
            "matched": sum(1 for x in out if x["resource"])}


# ── (3) Импорт/экспорт правил доступа строгим JSON ──
@app.get("/api/access/export")
def api_access_export():
    data = _load_rules()
    body = json.dumps({"version": 2, **data}, ensure_ascii=False, indent=2)
    return Response(content=body, media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="access-rules.json"'})


class ImportReq(BaseModel):
    block: list[str] = []
    direct: list[str] = []
    groups: list[dict] = []
    rules: list[dict] = []
    hosts: list[dict] = []


@app.post("/api/access/import")
def api_access_import(req: ImportReq):
    """Строгая проверка структуры + нормализация. Полностью заменяет правила."""
    out = {"block": [], "direct": [], "groups": [], "rules": [], "hosts": []}
    try:
        for d in req.block:
            nd = _norm_domain(d)
            if _DOMAIN_RE.match(nd):
                out["block"].append(nd)
        for d in req.direct:
            nd = _norm_domain(d)
            if _DOMAIN_RE.match(nd):
                out["direct"].append(nd)
        for g in req.groups:
            gid = str(g.get("id") or _new_id())
            doms = [x for x in (_norm_domain(y) for y in g.get("domains", [])) if _DOMAIN_RE.match(x)]
            macs = [m for m in (_norm_mac(x) for x in g.get("macs", [])) if _MAC_RE.match(m)]
            out["groups"].append({"id": gid, "name": str(g.get("name", "")).strip(),
                                  "desc": str(g.get("desc", "")).strip(), "domains": doms,
                                  "scope": _valid_scope(g.get("scope", "all")), "macs": macs})
        for h in req.hosts:
            mac = _norm_mac(h.get("mac", ""))
            if not _MAC_RE.match(mac):
                continue
            ip = str(h.get("ip", "")).strip()
            if ip and not ip.startswith(LAN_PREFIX):
                ip = ""
            eg = h.get("egress") if h.get("egress") in ("vpn", "internet", "local") \
                else ("internet" if h.get("direct") else "vpn")
            out["hosts"].append({"mac": mac, "name": str(h.get("name", "")).strip(),
                                 "ip": ip, "egress": eg, "isolated": bool(h.get("isolated")),
                                 "direct": (eg == "internet")})
    except Exception as e:
        return {"ok": False, "error": f"Ошибка разбора: {e}"}
    _apply_rules(out)
    return {"ok": True, **out}


@app.on_event("startup")
def _seed_defaults_on_fresh():
    """Свежий шлюз (rules.json ещё нет) — подсеваем стандартный шаблон
    раздельного туннелирования и сразу применяем (сохранение + маршруты)."""
    try:
        if not RULES_FILE.exists() and SPLIT_DEFAULT.exists():
            data = _load_rules()        # подсеет split из шаблона
            if data.get("split"):
                _apply_rules(data)      # rules.json + план-файлы + маршруты
    except Exception:
        pass


# ── Авто-перерезолв адресов обхода (раз в час) ───────────────────
# У сайтов меняются IP. Маршруты обхода и так рефрешит watchdog (5 мин,
# gw-access-routes резолвит домены вживую), а этот поток обновляет
# СОХРАНЁННЫЕ cidrs в split-ресурсах (для отображения/экспорта/подписи) +
# схлопывает лишнее. Без рестарта dnsmasq — чтобы не моргал DNS у клиентов.
RESOLVE_INTERVAL = int(os.environ.get("GW_RESOLVE_INTERVAL", "3600"))


def _periodic_resolve_loop():
    while True:
        time.sleep(RESOLVE_INTERVAL)
        try:
            data = _load_rules()
            if not data.get("split"):
                continue
            for res in data["split"]:
                for dom in res.get("domains", []):
                    for c in _resolve_cidrs(dom):
                        if c not in res.setdefault("cidrs", []):
                            res["cidrs"].append(c)
            _consolidate_split(data)
            RULES_FILE.write_text(json.dumps(data, ensure_ascii=False))
            _write_plan_files(data)          # обновляем direct.list / direct-cidrs.list
            subprocess.Popen(["docker", "exec", "gw-awg", "gw-access-routes"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _wlog("INFO Авто-перерезолв адресов обхода (раз в час)")
        except Exception:
            pass


@app.on_event("startup")
def _start_periodic_resolve():
    threading.Thread(target=_periodic_resolve_loop, daemon=True).start()


# ── Консоль шлюза: интерактивный PTY поверх WebSocket ─────────────
# Клиент (xterm.js) шлёт сообщения: 'i'+данные — ввод, 'r'+"cols,rows" — ресайз.
# Сервер шлёт сырой вывод терминала. Доступ — по той же cookie-сессии панели.
def _console_argv() -> list[str]:
    """Root-shell самого шлюза. При pid:host заходим в namespace PID 1 хоста
    через nsenter (реальный shell шлюза), иначе — shell контейнера (fallback).
    Авторизация — на уровне приложения, учётными данными ПАНЕЛИ (см. console_ws)."""
    try:
        comm = Path("/proc/1/comm").read_text().strip()
    except Exception:
        comm = ""
    if shutil.which("nsenter") and comm in ("systemd", "init"):
        return ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/bash", "-il"]
    for sh in ("/bin/bash", "/bin/sh"):
        if os.path.exists(sh):
            return [sh, "-il"] if sh.endswith("bash") else [sh, "-i"]
    return ["/bin/sh"]


@app.websocket("/api/console/ws")
async def console_ws(ws: WebSocket):
    tok = ws.cookies.get(COOKIE_NAME, "")
    if not _valid_token(tok):
        await ws.close(code=1008)
        return
    # Веб-консоль (shell) — ТОЛЬКО администратор. Модератору доступа нет.
    try:
        uname = base64.urlsafe_b64decode(tok.encode()).decode().rsplit(".", 2)[0]
    except Exception:
        uname = ""
    u = _find_user(uname)
    if not u or u.get("role") != "admin":
        await ws.close(code=1008)
        return
    await ws.accept()

    # ── Вход в консоль учётными данными ПАНЕЛИ (двойная авторизация: сессия
    #    панели + повторный ввод логина/пароля). Это те же креды, что и при
    #    входе в дашборд — не нужно помнить отдельный системный пароль. ──
    async def _send(s: str):
        await ws.send_text(s)

    async def _readline(echo: bool):
        buf = ""
        while True:
            try:
                msg = await ws.receive_text()
            except Exception:
                return None
            if not msg or msg[0] != "i":
                continue  # на этапе входа игнорируем resize и прочее
            for ch in msg[1:]:
                if ch in ("\r", "\n"):
                    await _send("\r\n")
                    return buf
                if ch in ("\x7f", "\b"):
                    if buf:
                        buf = buf[:-1]
                        if echo:
                            await _send("\b \b")
                elif ch == "\x03":      # Ctrl-C
                    return None
                elif ch >= " ":
                    buf += ch
                    if echo:
                        await _send(ch)

    await _send("\r\n\x1b[1;35m  Gateway Hub — вход в консоль\x1b[0m\r\n"
                "\x1b[90m  Введите учётные данные панели (как при входе в дашборд)\x1b[0m\r\n\r\n")
    me = None
    for _ in range(3):
        await _send("  Логин: ")
        user = await _readline(True)
        if user is None:
            await ws.close(); return
        await _send("  Пароль: ")
        pw = await _readline(False)
        if pw is None:
            await ws.close(); return
        u = _find_user((user or "").strip())
        if u and hmac.compare_digest((user or "").strip(), u["username"]) and _verify_pw(pw or "", u["password"]):
            me = u
            break
        await _send("\r\n\x1b[31m  Неверный логин или пароль\x1b[0m\r\n\r\n")
    if me is None:
        await _send("\r\n\x1b[31m  Доступ запрещён.\x1b[0m\r\n")
        await ws.close(); return

    loop = asyncio.get_event_loop()
    master, slave = pty.openpty()
    argv = _console_argv()
    env = {**os.environ, "TERM": "xterm-256color", "LANG": "C.UTF-8"}

    def _pty_preexec():
        # новая сессия + slave-PTY как управляющий терминал → корректный job control
        # (иначе bash ругается «cannot set terminal process group»).
        os.setsid()
        try:
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        except Exception:
            pass

    try:
        proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                                preexec_fn=_pty_preexec, env=env, close_fds=True)
    except Exception as e:
        os.close(master); os.close(slave)
        try:
            await ws.send_text(f"\r\n[не удалось запустить консоль: {e}]\r\n")
            await ws.close()
        except Exception:
            pass
        return
    os.close(slave)
    _wlog(f"INFO Открыта веб-консоль шлюза (вход: {me['username']})")

    queue: asyncio.Queue = asyncio.Queue()

    def _on_readable():
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        queue.put_nowait(data if data else None)

    loop.add_reader(master, _on_readable)

    async def _sender():
        while True:
            data = await queue.get()
            if data is None:
                break
            try:
                await ws.send_text(data.decode("utf-8", "replace"))
            except Exception:
                break

    send_task = asyncio.create_task(_sender())
    try:
        while True:
            msg = await ws.receive_text()
            if not msg:
                continue
            op, payload = msg[0], msg[1:]
            if op == "i":
                os.write(master, payload.encode("utf-8"))
            elif op == "r":
                try:
                    cols, rows = (int(x) for x in payload.split(",", 1))
                    fcntl.ioctl(master, termios.TIOCSWINSZ,
                                struct.pack("HHHH", rows, cols, 0, 0))
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        try:
            loop.remove_reader(master)
        except Exception:
            pass
        queue.put_nowait(None)
        send_task.cancel()
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            os.close(master)
        except Exception:
            pass
        _wlog("INFO Закрыта веб-консоль шлюза")


# ── Static files ─────────────────────────────────────────────────
@app.get("/")
def root():
    return RedirectResponse("/static/index.html", status_code=302)

if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
