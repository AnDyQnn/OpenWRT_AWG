#!/bin/sh
# VPN watchdog: failover + переподтверждение endpoint-маршрута.
# Каждые 5 минут через awg-watchdog.timer. AWG живёт в контейнере gw-awg.

CONF="/etc/amnezia/awg0.conf"
USER_MODE_FILE="/etc/awg-setup/user-mode"
RUNTIME_MODE_FILE="/run/awg-mode"
WLOG="/var/log/awg-watchdog.log"
STATS_DIR="/run/awg-stats"
_log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }
mkdir -p "$STATS_DIR"

_awg() { docker exec gw-awg awg "$@" 2>/dev/null; }

# Пользователь отключил VPN
[ "$(cat "$USER_MODE_FILE" 2>/dev/null || echo vpn)" = "off" ] && exit 0
[ "$(cat "$RUNTIME_MODE_FILE" 2>/dev/null)" = "manual_off" ] && exit 0

# Конфиг не загружен
[ -f "$CONF" ] || { echo "no_config" > "$RUNTIME_MODE_FILE"; exit 0; }

# Состояние туннеля (хэндшейк < 180с)
VPN_UP=false
if ip link show awg0 >/dev/null 2>&1; then
    HS_TS=$(_awg show awg0 latest-handshakes | awk '{print $2; exit}')
    if [ -n "$HS_TS" ] && [ "$HS_TS" -gt 0 ] 2>/dev/null; then
        [ "$(( $(date +%s) - HS_TS ))" -lt 180 ] && VPN_UP=true
    fi
fi

# Гарантируем NAT для LAN-клиентов через VPN-туннель (иначе у клиентов нет
# интернета: трафик уходит в awg0 с приватным src и сервер его дропает).
if ip link show awg0 >/dev/null 2>&1; then
    iptables -t nat -C POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null \
        || iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE
    # MSS clamping: туннель MTU < LAN, без него страницы не грузятся у клиентов.
    iptables -t mangle -C FORWARD -o awg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null \
        || iptables -t mangle -A FORWARD -o awg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
fi

# Рефреш ACL доступа к ресурсам — всегда (блок работает и на прямом интернете,
# у сайтов меняются IP → ipset пересобираем). Идемпотентно.
docker exec gw-awg gw-access-apply >/dev/null 2>&1
# Рефреш per-device обхода (MAC «мимо VPN») — на случай сброса правил. Идемпотентно.
docker exec gw-awg gw-direct-clients >/dev/null 2>&1
# Рефреш сегментов сети (VLAN/egress/изоляция) — на случай сброса правил. Идемпотентно.
docker exec gw-awg gw-network-apply >/dev/null 2>&1
# Рефреш хостового фаервола (вход) — на случай сброса правил. Идемпотентно.
/usr/local/bin/gw-firewall.sh >/dev/null 2>&1

if $VPN_UP; then
    # Туннель жив — на всякий случай переподтверждаем endpoint-маршрут
    # (вдруг кто-то сбросил маршруты). awg-up идемпотентен.
    docker exec gw-awg awg-up "$CONF" >/dev/null 2>&1
    # Рефреш доменов «напрямую» (у сайтов меняются IP).
    docker exec gw-awg gw-access-routes >/dev/null 2>&1
    echo "vpn" > "$RUNTIME_MODE_FILE"
    exit 0
fi

# Туннель упал
_log "WARN VPN down, attempting reconnect"
ENDPOINT=$(grep -E '^Endpoint' "$CONF" | awk -F'[= ]+' '{print $2}' | cut -d: -f1 | head -1)
WAN_PORT=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)

# Сервер вообще доступен?
if [ -n "$ENDPOINT" ] && [ -n "$WAN_PORT" ]; then
    if ! ping -c1 -W5 -I "$WAN_PORT" "$ENDPOINT" >/dev/null 2>&1; then
        _log "WARN Endpoint $ENDPOINT unreachable -> direct internet"
        echo "fallback" > "$RUNTIME_MODE_FILE"
        FAIL=$(cat "$STATS_DIR/failover_count" 2>/dev/null || echo 0)
        echo $((FAIL + 1)) > "$STATS_DIR/failover_count"
        exit 0
    fi
fi

# Сервер доступен — переподнимаем через awg-up (с исключением endpoint)
docker exec gw-awg awg-quick down "$CONF" >/dev/null 2>&1
sleep 2
docker exec gw-awg awg-up "$CONF" >/dev/null 2>&1
sleep 8

HS_TS=$(_awg show awg0 latest-handshakes | awk '{print $2; exit}')
if [ -n "$HS_TS" ] && [ "$HS_TS" -gt 0 ] 2>/dev/null; then
    _log "OK VPN restored"
    echo "vpn" > "$RUNTIME_MODE_FILE"
    REC=$(cat "$STATS_DIR/recovery_count" 2>/dev/null || echo 0)
    echo $((REC + 1)) > "$STATS_DIR/recovery_count"
else
    _log "WARN VPN up but no handshake yet -> fallback"
    echo "fallback" > "$RUNTIME_MODE_FILE"
    FAIL=$(cat "$STATS_DIR/failover_count" 2>/dev/null || echo 0)
    echo $((FAIL + 1)) > "$STATS_DIR/failover_count"
fi
