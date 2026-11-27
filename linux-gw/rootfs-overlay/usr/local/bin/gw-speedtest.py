#!/usr/bin/env python3
"""Интернетометр шлюза: скорость и пинг через разные сервисы и по каждому
каналу (напрямую через WAN и через VPN-туннель).

    gw-speedtest.py [--paths direct,vpn] [--providers yandex,2ip,cloudflare] [--secs 8]

Сервисы:
  yandex     — Яндекс.Интернетометр: его API сам выдаёт ближайшие узлы CDN
               (probes/50mb на загрузку, /upload на отдачу, /ping для задержки);
  2ip        — 2ip.ru: площадки провайдеров, протокол WebSocket
               (PING / «DOWNLOAD n» / пакеты «UPLOAD …»), площадку выбирает сам 2ip;
  cloudflare — speed.cloudflare.com (__down / __up), международный ориентир.

Каналы:
  vpn    — обычный маршрут шлюза (при включённом VPN весь его трафик идёт в туннель);
  direct — мимо VPN: на время замера адреса серверов прибиваются /32-маршрутами
           через шлюз провайдера (иначе строгий rp_filter роняет ответы как martian —
           тот же приём, что в gw-qos.sh).

Скорость = байты, прокачанные САМИМ тестом, в окне после разгона (первые 25%
времени не считаем). Счётчики интерфейса не используются — в них попал бы
трафик всего офиса. Только стандартная библиотека Python (на хосте нет pip).

Прогресс и результат: /run/awg-setup/speedtest.json; история (последние 60
замеров): /etc/awg-setup/speedtest-history.json.
"""
import argparse
import base64
import http.client
import json
import os
import re
import socket
import ssl
import statistics
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

RUN = os.environ.get("GWST_RUN", "/run/awg-setup")   # переопределение — для тестов
STATUS = f"{RUN}/speedtest.json"
HIST_DIR = os.environ.get("GWST_HIST", "/etc/awg-setup")   # смонтирован в контейнер панели
HIST = f"{HIST_DIR}/speedtest-history.json"
LOCK = f"{RUN}/speedtest.lock"
WLOG = "/var/log/awg-watchdog.log"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
CTX = ssl.create_default_context()
TIMEOUT = 8

PROVIDER_NAMES = {"yandex": "Яндекс", "2ip": "2ip", "cloudflare": "Cloudflare"}
PATH_NAMES = {"direct": "напрямую (WAN)", "vpn": "через VPN"}


# ── служебное ────────────────────────────────────────────────────
def log(msg):
    try:
        with open(WLOG, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S") + " gw-speedtest: " + msg + "\n")
    except Exception:
        pass


def write_json(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        pass


def sh(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ""


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return ""


def http_get(url, headers=None, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return r.read().decode("utf-8", "replace")


def resolve(host):
    try:
        return sorted({a[4][0] for a in socket.getaddrinfo(host, None, socket.AF_INET)})
    except Exception:
        return []


# ── каналы ───────────────────────────────────────────────────────
class Path:
    """Канал замера. direct — прибиваем адреса серверов к шлюзу провайдера."""

    def __init__(self, kind):
        self.kind = kind
        self.pinned = []
        self.wan = read(f"{RUN}/wan-port") or read("/etc/awg-setup/wan-port")
        gw = read(f"{RUN}/wan-gw") or read("/etc/awg-setup/wan-gw")
        if not gw and self.wan:
            m = re.search(r"default via (\S+)", sh("ip", "route", "show", "default", "dev", self.wan))
            gw = m.group(1) if m else ""
        self.gw = gw

    def available(self):
        if self.kind == "vpn":
            return os.path.exists("/sys/class/net/awg0") and read("/run/awg-mode") != "direct"
        return bool(self.wan and self.gw) or sys.platform != "linux"

    def pin(self, hosts):
        if self.kind != "direct" or sys.platform != "linux":
            return
        for h in hosts:
            for a in resolve(h):
                if a in self.pinned or sh("ip", "route", "show", f"{a}/32").strip():
                    continue          # чужой маршрут (обход, доступ) — не трогаем
                if subprocess.run(["ip", "route", "add", f"{a}/32", "via", self.gw, "dev", self.wan],
                                  capture_output=True).returncode == 0:
                    self.pinned.append(a)

    def unpin(self):
        for a in self.pinned:
            subprocess.run(["ip", "route", "del", f"{a}/32"], capture_output=True)
        self.pinned = []


# ── замер потоками ───────────────────────────────────────────────
class Meter:
    """Общий счётчик байт потоков; скорость считаем в окне [warm, secs]."""

    def __init__(self, secs):
        self.secs = secs
        self.warm = max(1.5, secs * 0.25)
        self.t0 = time.monotonic()
        self.lock = threading.Lock()
        self.total = 0
        self.mark = None          # (t, bytes) на конце разгона
        self.errors = []

    def add(self, n):
        with self.lock:
            self.total += n
            now = time.monotonic() - self.t0
            if self.mark is None and now >= self.warm:
                self.mark = (now, self.total)

    def alive(self):
        return time.monotonic() - self.t0 < self.secs

    def mbps(self):
        end = time.monotonic() - self.t0
        if self.mark is None or end - self.mark[0] < 0.5:
            return 0.0
        return (self.total - self.mark[1]) * 8 / (end - self.mark[0]) / 1e6


def run_streams(meter, worker, n):
    ths = [threading.Thread(target=worker, daemon=True) for _ in range(n)]
    for t in ths:
        t.start()
    for t in ths:
        t.join(meter.secs + 6)
    return meter.mbps()


def _conn(url):
    u = urllib.parse.urlsplit(url)
    cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    kw = {"context": CTX} if u.scheme == "https" else {}
    c = cls(u.hostname, u.port, timeout=TIMEOUT, **kw)
    return c, (u.path or "/") + ("?" + u.query if u.query else "")


def http_download(meter, url_fn):
    def worker():
        while meter.alive():
            try:
                c, p = _conn(url_fn())
                c.request("GET", p, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
                r = c.getresponse()
                if r.status != 200:
                    meter.errors.append(f"HTTP {r.status}"); c.close(); return
                while meter.alive():
                    b = r.read(65536)
                    if not b:
                        break
                    meter.add(len(b))
                c.close()
            except Exception as e:
                meter.errors.append(str(e)[:80])
                time.sleep(0.3)
    return worker


def http_upload(meter, url_fn, method="POST", total=200 * 1024 * 1024):
    chunk = os.urandom(64 * 1024)

    def worker():
        while meter.alive():
            try:
                c, p = _conn(url_fn())
                c.putrequest(method, p, skip_accept_encoding=True)
                c.putheader("User-Agent", UA)
                c.putheader("Content-Type", "application/octet-stream")
                c.putheader("Content-Length", str(total))
                c.endheaders()
                try:
                    c.sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 128 * 1024)
                except Exception:
                    pass
                sent = 0
                while meter.alive() and sent < total:
                    c.sock.sendall(chunk)
                    sent += len(chunk)
                    meter.add(len(chunk))
                c.close()
            except Exception as e:
                if meter.alive():
                    meter.errors.append(str(e)[:80])
                    time.sleep(0.3)
    return worker


def http_ping(url, n=6):
    """Задержка = время запроса по уже открытому соединению (без TLS-рукопожатия)."""
    c, p = _conn(url)
    out = []
    try:
        for i in range(n + 1):
            t = time.monotonic()
            c.request("GET", p, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
            r = c.getresponse(); r.read()
            if i:                          # первый — прогрев (DNS/TLS)
                out.append((time.monotonic() - t) * 1000)
    finally:
        c.close()
    return out


# ── минимальный WebSocket-клиент (для 2ip) ───────────────────────
class WS:
    def __init__(self, url):
        u = urllib.parse.urlsplit(url)
        raw = socket.create_connection((u.hostname, u.port or (443 if u.scheme == "wss" else 80)), timeout=TIMEOUT)
        self.s = CTX.wrap_socket(raw, server_hostname=u.hostname) if u.scheme == "wss" else raw
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {u.path or '/'} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
               f"Origin: https://2ip.ru\r\nUser-Agent: {UA}\r\n\r\n")
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            d = self.s.recv(4096)
            if not d:
                raise OSError("ws: соединение закрыто при рукопожатии")
            buf += d
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise OSError("ws: " + head.split(b"\r\n", 1)[0].decode("latin1"))

    def send(self, data, binary=False):
        if isinstance(data, str):
            data = data.encode()
        op = 0x2 if binary else 0x1
        n = len(data)
        hdr = bytes([0x80 | op])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        # маскирование: XOR через int — быстро и без numpy
        m = (mask * (n // 4 + 1))[:n]
        body = (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big") if n else b""
        self.s.sendall(hdr + mask + body)

    def _need(self, n, on_bytes=None):
        while len(self.buf) < n:
            d = self.s.recv(262144)
            if not d:
                raise OSError("ws: закрыто")
            if on_bytes:
                on_bytes(len(d))
            self.buf += d

    def recv(self, on_bytes=None):
        """Возвращает (opcode, payload). on_bytes — счётчик сырых байт (для замера)."""
        self._need(2, on_bytes)
        b1, b2 = self.buf[0], self.buf[1]
        n, off = b2 & 0x7F, 2
        if n == 126:
            self._need(4, on_bytes); n = struct.unpack(">H", self.buf[2:4])[0]; off = 4
        elif n == 127:
            self._need(10, on_bytes); n = struct.unpack(">Q", self.buf[2:10])[0]; off = 10
        self._need(off + n, on_bytes)
        payload = self.buf[off:off + n]
        self.buf = self.buf[off + n:]
        return b1 & 0x0F, payload

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


# ── сервисы ──────────────────────────────────────────────────────
def prov_cloudflare(path, secs):
    hosts = ["speed.cloudflare.com"]
    path.pin(hosts)
    res = {"server": "speed.cloudflare.com"}
    try:
        res["ping"] = http_ping("https://speed.cloudflare.com/__down?bytes=0")
    except Exception as e:
        res["error"] = f"нет связи: {e}"[:120]; return res
    m = Meter(secs)
    res["down"] = run_streams(m, http_download(m, lambda: "https://speed.cloudflare.com/__down?bytes=50000000"), 6)
    m = Meter(secs)
    res["up"] = run_streams(m, http_upload(m, lambda: "https://speed.cloudflare.com/__up", total=50_000_000), 4)
    return res


def prov_yandex(path, secs):
    # API выдаёт набор узлов CDN, ближайших к адресу, с которого спрашиваем
    path.pin(["yandex.ru"])
    d = json.loads(http_get("https://yandex.ru/internet/api/v0/get-probes"))
    lat = [p["url"] for p in d.get("latency", {}).get("probes", [])]
    dls = [p["url"] for p in d.get("download", {}).get("probes", []) if "/probes/50mb" in p["url"]]
    uls = [p["url"] for p in d.get("upload", {}).get("probes", []) if "timeout=" not in p["url"]]
    hosts = sorted({urllib.parse.urlsplit(u).hostname for u in lat + dls + uls})
    path.pin(hosts)
    # ближайший узел — с минимальным пингом
    best, best_ping, pings = None, None, {}
    for u in lat:
        try:
            p = http_ping(u, 3)
            pings[u] = p
            if best_ping is None or min(p) < best_ping:
                best, best_ping = u, min(p)
        except Exception:
            continue
    if not best:
        return {"error": "узлы Яндекса не отвечают", "server": ", ".join(hosts)[:80]}
    host = urllib.parse.urlsplit(best).hostname
    res = {"server": host, "ping": http_ping(best, 6)}
    dl = [u for u in dls if urllib.parse.urlsplit(u).hostname == host] or dls
    ul = [u for u in uls if urllib.parse.urlsplit(u).hostname == host] or uls
    m = Meter(secs)
    res["down"] = run_streams(m, http_download(m, lambda: dl[0]), 6) if dl else 0.0
    m = Meter(secs)
    # /upload?size=… принимает тело запроса; размер — в КБ, как в самом интернетометре
    up_url = re.sub(r"size=\d+", "size=30720", ul[0]) if ul else ""
    res["up"] = run_streams(m, http_upload(m, lambda: up_url, total=30720 * 1024), 4) if up_url else 0.0
    return res


def _2ip_platform():
    """Страница 2ip отдаёт площадку по умолчанию (для нашего IP) и список.
    Перед ней — простая JS-проверка: cookie из base64 (повторяем её)."""
    url = "https://2ip.ru/speed/"
    ck = ""
    for _ in range(3):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru", "Cookie": ck})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT, context=CTX) as r:
                html = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            html = e.read().decode("utf-8", "replace")
        m = re.search(r'atob\("([^"]+)"\)', html)
        # 2ip.ru отвечает 503 с JS-проверкой и потом редиректит на 2ip.io
        if m and not re.search(r"platform\s*:", html):
            js = base64.b64decode(m.group(1)).decode("utf-8", "replace")
            a = re.search(r'answer\s*=\s*"([^"]+)"', js); s = re.search(r'salt\s*=\s*"([^"]+)"', js)
            if a and s:
                ck = f"2ip_js_challenge_salt={s.group(1)}; 2ip_js_challenge={a.group(1)}"
                continue
        break
    # площадка по умолчанию — JS-объект с одинарными кавычками:
    #   platform: { id: '1500', url: 'wss://server-1500.2ipcore.com:8002/ws', cityName: '…' },
    m = re.search(r'\bplatform\s*:\s*\{([^{}]*)\}', html)
    plats = []
    pm = re.search(r'platforms\s*:\s*(\[.*?\])\s*,\s*\n', html, re.S)
    if pm:
        try:
            plats = json.loads(pm.group(1))
        except Exception:
            plats = []
    cur = None
    if m:
        f = dict(re.findall(r"""(\w+)\s*:\s*['"]([^'"]*)['"]""", m.group(1)))
        if f.get("url"):
            cur = {"url": f["url"].replace("\\/", "/"), "id": f.get("id", ""),
                   "adTitle": f.get("cityName", "")}
            for p in plats:                       # подпись провайдера площадки, если есть
                if p.get("id") == cur["id"] and p.get("adTitle"):
                    cur["adTitle"] = f"{p['adTitle']}, {f.get('cityName', '')}".strip(", ")
    return cur, plats


def prov_2ip(path, secs):
    path.pin(["2ip.ru", "2ip.io"])
    cur, plats = _2ip_platform()
    cands = ([cur] if cur else []) + [p for p in plats if not cur or p.get("url") != cur.get("url")][:5]
    if not cands:
        return {"error": "2ip не отдал список площадок"}
    last_err = ""
    for p in cands:
        url = p.get("url", "").replace("\\/", "/")
        host = urllib.parse.urlsplit(url).hostname
        if not host:
            continue
        path.pin([host])
        try:
            res = {"server": f"{host} — {p.get('adTitle', '')}".strip(" —")[:90]}
            # пинг: PING → ответ сервера
            ws = WS(url)
            pings = []
            for i in range(7):
                t = time.monotonic(); ws.send(f"PING {int(time.time() * 1000)}"); ws.recv()
                if i:
                    pings.append((time.monotonic() - t) * 1000)
            ws.close()
            res["ping"] = pings
            res["down"] = _2ip_down(url, secs)
            res["up"] = _2ip_up(url, secs)
            return res
        except Exception as e:
            last_err = f"{host}: {e}"[:120]
            continue
    return {"error": "площадки 2ip не отвечают (" + last_err + ")"}


def _2ip_down(url, secs):
    m = Meter(secs)

    def worker():
        try:
            ws = WS(url)
            size = 5000
            while m.alive():
                t = time.monotonic()
                ws.send(f"DOWNLOAD {size}")
                ws.recv(on_bytes=m.add)
                if time.monotonic() - t < 0.3 and size <= 5_120_000:   # как в их JS: растим пакет
                    size *= 2
            ws.close()
        except Exception as e:
            m.errors.append(str(e)[:80])
    return run_streams(m, worker, 6)


def _2ip_up(url, secs):
    m = Meter(secs)

    def worker():
        try:
            ws = WS(url)
            size = 5000
            while m.alive():
                pkt = b"UPLOAD " + os.urandom(max(0, size - 7))
                t = time.monotonic()
                ws.send(pkt, binary=True)
                ws.recv()
                m.add(size)
                if time.monotonic() - t < 0.3 and size <= 5_120_000:
                    size *= 2
            ws.close()
        except Exception as e:
            m.errors.append(str(e)[:80])
    return run_streams(m, worker, 6)


PROVIDERS = {"yandex": prov_yandex, "2ip": prov_2ip, "cloudflare": prov_cloudflare}


# ── запуск ───────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", default="direct,vpn")
    ap.add_argument("--providers", default="yandex,2ip,cloudflare")
    ap.add_argument("--secs", type=float, default=8)
    a = ap.parse_args()
    paths = [p for p in a.paths.split(",") if p in PATH_NAMES]
    provs = [p for p in a.providers.split(",") if p in PROVIDERS]
    secs = max(4.0, min(a.secs, 15.0))

    os.makedirs(RUN, exist_ok=True)
    # один замер за раз
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_RDWR)
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("замер уже идёт"); return 1
    except Exception:
        pass

    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    st = {"state": "running", "started": started, "pid": os.getpid(), "step": "подготовка",
          "results": [], "paths": paths, "providers": provs}
    write_json(STATUS, st)
    for kind in paths:
        path = Path(kind)
        if not path.available():
            for pv in provs:
                st["results"].append({"path": kind, "provider": pv,
                                      "error": "VPN выключен" if kind == "vpn" else "WAN не определён"})
            write_json(STATUS, st)
            continue
        try:
            for pv in provs:
                st["step"] = f"{PATH_NAMES[kind]} · {PROVIDER_NAMES[pv]}"
                write_json(STATUS, st)
                t = time.monotonic()
                try:
                    r = PROVIDERS[pv](path, secs)
                except Exception as e:
                    r = {"error": f"ошибка: {e}"[:140]}
                ping = r.pop("ping", None)
                if ping:
                    r["ping_ms"] = round(statistics.median(ping), 1)
                    r["jitter_ms"] = round(statistics.pstdev(ping), 1) if len(ping) > 1 else 0.0
                for k in ("down", "up"):
                    if k in r:
                        r[k] = round(r[k], 1)
                if not r.get("error") and not r.get("down") and not r.get("up"):
                    r["error"] = "сервис не отдал данные"
                r.update({"path": kind, "provider": pv, "secs": round(time.monotonic() - t, 1)})
                st["results"].append(r)
                write_json(STATUS, st)
        finally:
            path.unpin()

    st.update({"state": "done", "step": "готово", "finished": time.strftime("%Y-%m-%dT%H:%M:%S")})
    st.pop("pid", None)
    write_json(STATUS, st)
    try:
        with open(HIST, encoding="utf-8") as f:
            hist = json.load(f)
    except Exception:
        hist = []
    hist.append({"ts": started, "results": st["results"]})
    write_json(HIST, hist[-60:])
    ok = [r for r in st["results"] if not r.get("error")]
    log("замер: " + "; ".join(
        f"{PATH_NAMES[r['path']]} {PROVIDER_NAMES[r['provider']]} ↓{r.get('down', 0):g} ↑{r.get('up', 0):g} "
        f"пинг {r.get('ping_ms', '?')}" for r in ok) if ok else "WARN замер скорости: ни один сервис не ответил")
    print(json.dumps(st, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
