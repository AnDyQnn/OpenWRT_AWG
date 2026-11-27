#!/usr/bin/env python3
"""История скорости по портам шлюза (для общего графика «Журнала сети»).

    gw-netmetrics.py collect          — служба: раз в 5 с счётчики, раз в минуту запись
    gw-netmetrics.py query --days N   — JSON для панели (агрегаты + базовая линия WAN)

Порты: WAN, порты моста br-lan (LAN) и туннель awg0 (VPN). Для каждого раз в
минуту пишем: среднюю скорость ↓/↑ (Мбит/с), пик за минуту (по 5-секундным
замерам), скорость согласования линка (минимум за минуту) и сколько секунд не
было линка. «↓» — всегда к офису: для WAN/VPN это приём порта, для LAN — отдача.

Хранение — SQLite (только стандартная библиотека; на хосте нет pip):
  m1  — поминутно, 3 дня;
  m15 — по 15 минут, 400 дней (суммы для средних + максимумы).
База — /var/lib/awg-setup/netmetrics.db (не в /etc/awg-setup: в бэкап не нужна).

Базовая линия WAN («обычный максимум», без хардкода): медиана суточных пиков
поминутной средней загрузки за последние 30 дней (дни с заметным трафиком).
"""
import json
import os
import sqlite3
import statistics
import sys
import time

DB = os.environ.get("GW_NETMETRICS_DB", "/var/lib/awg-setup/netmetrics.db")
RUN = "/run/awg-setup"
SAMPLE = 5
KEEP_M1 = 3 * 86400
KEEP_M15 = 400 * 86400


def read(p):
    try:
        with open(p) as f:
            return f.read().strip()
    except Exception:
        return ""


def ports():
    """{ifname: role} — набор портов пересчитывается каждую минуту."""
    out = {}
    wan = read(f"{RUN}/wan-port") or read("/etc/awg-setup/wan-port")
    if wan and os.path.exists(f"/sys/class/net/{wan}"):
        out[wan] = "WAN"
    try:
        for p in os.listdir("/sys/class/net/br-lan/brif"):
            out.setdefault(p, "LAN")
    except Exception:
        pass
    # все остальные интерфейсы — сами: туннели (awg*/wg*/tun*) = VPN, прочие
    # (второй провайдер, модем, Wi‑Fi) = «порт». Служебные и сами мосты не берём.
    try:
        names = os.listdir("/sys/class/net")
    except Exception:
        names = []
    for n in names:
        if n in out or n == "lo" or n.startswith(("docker", "veth", "br-", "br", "virbr", "dummy")):
            continue
        if os.path.exists(f"/sys/class/net/{n}/bridge"):      # мост (в т.ч. с другим именем)
            continue
        out[n] = "VPN" if n.startswith(("awg", "wg", "tun")) else "PORT"
    return out


def counters(ifn):
    b = f"/sys/class/net/{ifn}"
    try:
        rx = int(read(f"{b}/statistics/rx_bytes")); tx = int(read(f"{b}/statistics/tx_bytes"))
    except Exception:
        return None
    carrier = read(f"{b}/carrier") == "1"
    try:
        sp = int(read(f"{b}/speed"))
        sp = sp if sp > 0 else None
    except Exception:
        sp = None
    return rx, tx, carrier, sp


def db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    c = sqlite3.connect(DB, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.executescript("""
    CREATE TABLE IF NOT EXISTS m1 (ts INTEGER, ifn TEXT, role TEXT, dn REAL, up REAL, dn_pk REAL, up_pk REAL,
        link INTEGER, down_s INTEGER, PRIMARY KEY (ts, ifn));
    CREATE TABLE IF NOT EXISTS m15 (ts INTEGER, ifn TEXT, role TEXT, dn_sum REAL, up_sum REAL, n INTEGER,
        dn_pk REAL, up_pk REAL, dn_m1max REAL, up_m1max REAL, link INTEGER, down_s INTEGER, PRIMARY KEY (ts, ifn));
    """)
    return c


def collect():
    c = db()
    prev = {}                    # ifn → (t, rx, tx)
    acc = {}                     # ifn → накопитель текущей минуты
    pmap = ports(); pmap_t = time.time()
    minute = int(time.time() // 60)
    last_clean = 0
    while True:
        t = time.time()
        if t - pmap_t > 60:
            pmap = ports(); pmap_t = t
        for ifn, role in pmap.items():
            cv = counters(ifn)
            if not cv:
                continue
            rx, tx, carrier, sp = cv
            a = acc.setdefault(ifn, {"role": role, "rx": 0, "tx": 0, "dt": 0.0, "rx_pk": 0.0, "tx_pk": 0.0,
                                     "link": None, "down": 0})
            a["role"] = role
            if not carrier:
                a["down"] += SAMPLE
            if sp:
                a["link"] = sp if a["link"] is None else min(a["link"], sp)
            p = prev.get(ifn)
            if p:
                dt = t - p[0]; drx = rx - p[1]; dtx = tx - p[2]
                if 0 < dt < 60 and drx >= 0 and dtx >= 0:     # сброс счётчика (пересоздан awg0) — пропуск
                    a["rx"] += drx; a["tx"] += dtx; a["dt"] += dt
                    a["rx_pk"] = max(a["rx_pk"], drx * 8 / dt / 1e6)
                    a["tx_pk"] = max(a["tx_pk"], dtx * 8 / dt / 1e6)
            prev[ifn] = (t, rx, tx)
        cur = int(t // 60)
        if cur != minute:
            ts = minute * 60
            rows = []
            for ifn, a in acc.items():
                if a["dt"] < 20:          # слишком мало данных за минуту (старт/пересоздание)
                    continue
                rxm = a["rx"] * 8 / a["dt"] / 1e6; txm = a["tx"] * 8 / a["dt"] / 1e6
                # «↓» — к офису: LAN-порт отдаёт в офис (tx), WAN/VPN принимают (rx)
                dn, up, dpk, upk = (txm, rxm, a["tx_pk"], a["rx_pk"]) if a["role"] == "LAN" else (rxm, txm, a["rx_pk"], a["tx_pk"])
                rows.append((ts, ifn, a["role"], round(dn, 3), round(up, 3), round(dpk, 3), round(upk, 3), a["link"], a["down"]))
            try:
                with c:
                    c.executemany("INSERT OR REPLACE INTO m1 VALUES (?,?,?,?,?,?,?,?,?)", rows)
                    for r in rows:
                        t15 = r[0] // 900 * 900
                        c.execute("""INSERT INTO m15 VALUES (?,?,?,?,?,1,?,?,?,?,?,?)
                            ON CONFLICT(ts, ifn) DO UPDATE SET role=excluded.role, dn_sum=dn_sum+excluded.dn_sum,
                            up_sum=up_sum+excluded.up_sum, n=n+1, dn_pk=max(dn_pk, excluded.dn_pk),
                            up_pk=max(up_pk, excluded.up_pk), dn_m1max=max(dn_m1max, excluded.dn_m1max),
                            up_m1max=max(up_m1max, excluded.up_m1max),
                            link=CASE WHEN link IS NULL THEN excluded.link WHEN excluded.link IS NULL THEN link
                                      ELSE min(link, excluded.link) END,
                            down_s=down_s+excluded.down_s""",
                                  (t15, r[1], r[2], r[3], r[4], r[5], r[6], r[3], r[4], r[7], r[8]))
                if t - last_clean > 3600:
                    with c:
                        c.execute("DELETE FROM m1 WHERE ts < ?", (int(t) - KEEP_M1,))
                        c.execute("DELETE FROM m15 WHERE ts < ?", (int(t) - KEEP_M15,))
                    last_clean = t
            except Exception as e:
                print("db:", e, file=sys.stderr)
            acc = {}
            minute = cur
        time.sleep(max(0.5, SAMPLE - (time.time() - t)))


def query(days, t_from=None, t_to=None):
    now = int(time.time())
    until = min(int(t_to), now) if t_to else now
    since = int(t_from) if t_from else now - days * 86400
    span_d = max(1.0, (until - since) / 86400)
    # ~300–400 точек на период
    bucket = 300 if span_d <= 1.5 else 1800 if span_d <= 8 else 7200 if span_d <= 31 else 21600 if span_d <= 92 else 86400
    out = {"bucket_s": bucket, "since": since, "now": until, "ifaces": [], "baseline": None, "data_from": None}
    if not os.path.exists(DB):
        return out
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    if bucket < 900 and since < now - 3 * 86400 + 600:
        bucket = 900
        out["bucket_s"] = bucket
    if bucket < 900:
        rows = c.execute(f"""SELECT ifn, role, (ts/{bucket})*{bucket} AS b, avg(dn), avg(up), max(dn_pk), max(up_pk),
            min(link), sum(down_s) FROM m1 WHERE ts >= ? AND ts < ? GROUP BY ifn, b ORDER BY b""", (since, until)).fetchall()
    else:
        rows = c.execute(f"""SELECT ifn, role, (ts/{bucket})*{bucket} AS b, sum(dn_sum)/sum(n), sum(up_sum)/sum(n),
            max(dn_pk), max(up_pk), min(link), sum(down_s) FROM m15 WHERE ts >= ? AND ts < ? GROUP BY ifn, b ORDER BY b""",
                         (since, until)).fetchall()
    by = {}
    for ifn, role, b, dn, up, dpk, upk, link, down_s in rows:
        s = by.setdefault(ifn, {"name": ifn, "role": role, "t": [], "dn": [], "up": [], "dn_pk": [], "up_pk": [],
                                "link": [], "down_s": []})
        s["role"] = role
        for k, v in (("t", b), ("dn", dn), ("up", up), ("dn_pk", dpk), ("up_pk", upk), ("link", link), ("down_s", down_s)):
            s[k].append(round(v, 3) if isinstance(v, float) else v)   # 0.001 Мбит/с = 1 Кбит/с
    out["ifaces"] = sorted(by.values(), key=lambda s: ({"WAN": 0, "LAN": 1, "VPN": 2}.get(s["role"], 3), s["name"]))
    r = c.execute("SELECT min(ts) FROM m15").fetchone()
    out["data_from"] = r[0] if r else None
    # базовая линия WAN: медиана суточных пиков поминутной средней (30 дней)
    daily = c.execute("""SELECT ts/86400 AS d, max(dn_m1max), max(up_m1max) FROM m15
        WHERE role='WAN' AND ts >= ? GROUP BY d""", (now - 30 * 86400,)).fetchall()
    dn = [x[1] for x in daily if x[1] and x[1] > 1]
    up = [x[2] for x in daily if x[2] and x[2] > 1]
    if dn:
        out["baseline"] = {"dn": round(statistics.median(dn), 1), "up": round(statistics.median(up), 1) if up else None,
                           "days": len(dn)}
    c.close()
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "collect":
        collect()
    elif cmd == "query":
        days = 7
        arg = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None
        try:
            days = max(1, min(365, int(arg("--days") or 7)))
        except Exception:
            pass
        print(json.dumps(query(days, arg("--from"), arg("--to")), ensure_ascii=False, separators=(",", ":")))
    else:
        print(__doc__)
        sys.exit(2)
