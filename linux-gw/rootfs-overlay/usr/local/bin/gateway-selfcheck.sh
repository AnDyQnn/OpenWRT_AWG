#!/bin/sh
# Health-gate шлюза (§9). ТОЛЬКО read-only проверки, без мутации состояния.
# Используется машиной обновления (gateway-update.sh) как ворота: провал любой
# HARD-проверки → откат. Так же годен для ручного запуска и dead-man-проверки.
#
# Коды выхода: 0 = всё ок; 1 = провалена HARD-проверка (см. вывод "FAIL: <что>").
# Stdout: по строке на проверку (PASS/WARN/FAIL). Последняя строка при провале —
#         "FAIL: <короткий-id>" (его подставляем в уведомление «ошибка на этапе X»).
#
# Классы проверок:
#   HARD  — провал = откат (контейнеры, панель, состояние, регресс защиты туннеля);
#   VPN   — проверяем только если VPN сконфигурирован И не выключен пользователем;
#   SOFT  — только предупреждение (может быть пусто легитимно: нет правил доступа).

CONF="/etc/amnezia/awg0.conf"
USER_MODE_FILE="/etc/awg-setup/user-mode"
RUNTIME_MODE_FILE="/run/awg-mode"
RULES="/etc/awg-setup/filter/rules.json"
HS_MAX=180                       # свежесть хэндшейка, сек
FAILED=""                        # id первой упавшей HARD-проверки

_ok()   { echo "PASS $1"; }
_warn() { echo "WARN $1 — $2"; }
_fail() { echo "FAIL $1 — $2"; [ -z "$FAILED" ] && FAILED="$1"; }

# --- HARD: контейнеры запущены ---------------------------------------------
for c in gw-awg gw-dnsmasq gw-webui; do
    st=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)
    if [ "$st" = "true" ]; then _ok "container:$c"; else _fail "container:$c" "не running ($st)"; fi
done

# --- HARD: веб-панель отвечает (uvicorn за nginx) ---------------------------
code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8000/login 2>/dev/null)
[ "$code" = "200" ] && _ok "panel:login(8000)" || {
    # запасной путь — через nginx 443 (вдруг uvicorn слушает иначе)
    code2=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 https://127.0.0.1/login 2>/dev/null)
    [ "$code2" = "200" ] && _ok "panel:login(443)" || _fail "panel:login" "HTTP $code/$code2"
}

# --- HARD: состояние не потерялось (rules.json валиден и не пуст) -----------
if [ -s "$RULES" ]; then
    if command -v python3 >/dev/null 2>&1; then
        if python3 -c "import json,sys; d=json.load(open('$RULES')); sys.exit(0 if isinstance(d,dict) else 1)" 2>/dev/null; then
            _ok "state:rules.json"
        else
            _fail "state:rules.json" "невалидный JSON"
        fi
    else
        # без python хотя бы проверим, что это похоже на JSON-объект
        head -c1 "$RULES" | grep -q '{' && _ok "state:rules.json(raw)" || _fail "state:rules.json" "не похоже на JSON"
    fi
else
    _fail "state:rules.json" "пуст/отсутствует"
fi

# --- HARD: регресс защиты туннеля — нет широких супернетов /1../7 В ОБХОД ------
# Баг авторезолва: «прямые» (bypass) маршруты получали супернеты, пересекавшие
# LAN, и роняли VPN. ВАЖНО: сам туннель при AllowedIPs=0.0.0.0/0 ЛЕГИТИМНО ставит
# в main кучу /2../7 `dev awg0` (сплит с исключением endpoint) — это НЕ регресс.
# Поэтому ловим только широкие маршруты, идущие НЕ через awg0 (т.е. в обход).
wide=$(ip route show table main 2>/dev/null | grep -E '/[1-7] ' | grep -v default \
       | grep -v 'dev awg0' | awk '{print $1}')
if [ -n "$wide" ]; then
    _fail "routes:wide-supernet" "в обход VPN есть /1../7: $(echo "$wide" | tr '\n' ' ')"
else
    _ok "routes:no-wide-bypass"
fi

# --- определяем, активен ли VPN-режим --------------------------------------
um=$(cat "$USER_MODE_FILE" 2>/dev/null || echo vpn)
rm_mode=$(cat "$RUNTIME_MODE_FILE" 2>/dev/null || echo "")
VPN_EXPECTED=true
[ "$um" = "off" ] && VPN_EXPECTED=false
[ -f "$CONF" ] || VPN_EXPECTED=false
# fallback (сервер недоступен → прямой инет) — это НЕ провал апдейта, туннель не ждём
[ "$rm_mode" = "fallback" ] && VPN_EXPECTED=false
[ "$rm_mode" = "manual_off" ] && VPN_EXPECTED=false

if $VPN_EXPECTED; then
    # --- VPN-HARD: туннель поднят, хэндшейк свежий ---
    if ip link show awg0 >/dev/null 2>&1; then
        hs=$(docker exec gw-awg awg show awg0 latest-handshakes 2>/dev/null | awk '{print $2; exit}')
        if [ -n "$hs" ] && [ "$hs" -gt 0 ] 2>/dev/null && [ "$(( $(date +%s) - hs ))" -lt "$HS_MAX" ]; then
            _ok "vpn:handshake"
        else
            _fail "vpn:handshake" "нет свежего хэндшейка (<${HS_MAX}s)"
        fi
        # --- VPN-HARD: endpoint не заворачивается в awg0 (нет петли) ---
        ep=$(grep -E '^Endpoint' "$CONF" 2>/dev/null | awk -F'[= ]+' '{print $2}' | cut -d: -f1 | head -1)
        if [ -n "$ep" ]; then
            dev=$(ip route get "$ep" 2>/dev/null | grep -oE 'dev [^ ]+' | awk '{print $2}' | head -1)
            [ "$dev" = "awg0" ] && _fail "vpn:endpoint-loop" "endpoint $ep уходит в awg0" || _ok "vpn:endpoint-direct"
        fi
        # --- VPN-HARD: forwarding для клиентов (NAT + MSS) ---
        iptables -t nat -C POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null \
            && _ok "vpn:masquerade" || _fail "vpn:masquerade" "нет NAT на awg0"
        iptables -t mangle -C FORWARD -o awg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null \
            && _ok "vpn:mss-clamp" || _warn "vpn:mss-clamp" "нет MSS clamp (страницы могут не грузиться)"
    else
        _fail "vpn:awg0" "интерфейс awg0 отсутствует, хотя VPN ожидается"
    fi
else
    _warn "vpn" "режим прямого интернета (off/fallback/нет конфига) — VPN-проверки пропущены"
fi

# --- SOFT: ACL-цепочка доступа на месте (может быть пустой легитимно) -------
iptables -C FORWARD -j GW_ACCESS 2>/dev/null || iptables -L GW_ACCESS -n >/dev/null 2>&1 \
    && _ok "acl:GW_ACCESS" || _warn "acl:GW_ACCESS" "цепочка не найдена (нет правил доступа?)"

# --- SOFT: DNS резолвится через dnsmasq на LAN-интерфейсе -------------------
gwip=$(ip -4 -o addr show br-lan 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
if [ -n "$gwip" ]; then
    if docker exec gw-dnsmasq nslookup example.com "$gwip" >/dev/null 2>&1; then
        _ok "dns:resolve"
    else
        _warn "dns:resolve" "dnsmasq на $gwip не резолвит example.com"
    fi
else
    _warn "dns:resolve" "br-lan без IP — DNS-проверка пропущена"
fi

# --- SOFT: объявленные host-пакеты установлены ------------------------------
# Накат ставит недостающие сам (_sync_host_requirements), но если зеркало было
# недоступно — он не откатывается, а оставляет недостачу. Показываем её здесь,
# чтобы она не осталась незамеченной. SOFT: отсутствие пакета не повод к откату.
REQ=/opt/gateway/host-requirements.list
if [ -f "$REQ" ]; then
    miss=""
    for p in $(sed -n 's/^pkg[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' "$REQ") \
             $(sed -n 's/^pkg-docker[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' "$REQ"); do
        dpkg-query -W -f='${Status}' "$p" 2>/dev/null \
            | grep -q '^install ok installed$' || miss="$miss $p"
    done
    [ -z "$miss" ] && _ok "pkg:host-requirements" \
                   || _warn "pkg:host-requirements" "не установлены:$miss"
else
    _warn "pkg:host-requirements" "$REQ отсутствует"
fi

# --- итог -------------------------------------------------------------------
if [ -n "$FAILED" ]; then
    echo "FAIL: $FAILED"
    exit 1
fi
echo "OK: все HARD-проверки пройдены"
exit 0
