#!/bin/sh
# Поднимает AWG-туннель и ВСЕГДА исключает endpoint сервера из маршрутизации
# через туннель — независимо от того, что в AllowedIPs (даже если там
# 212.0.0.0/8, в которую попадает сам сервер). Идемпотентно: можно звать
# повторно (при загрузке нового конфига, из watchdog) — лишнего не сделает.
#
# Применяется ко ВСЕМ конфигам автоматически: парсит Endpoint, резолвит в IP,
# вешает /32-маршрут к нему через реальный WAN-шлюз (приоритетнее любой
# подсети из AllowedIPs).

CONF="${1:-/config/awg0.conf}"
export WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go
WLOG="/var/log/awg-watchdog.log"
_log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

[ -f "$CONF" ] || { _log "INFO awg-up: нет конфига $CONF"; exit 0; }

# WAN-шлюз: несколько источников по надёжности.
wan_gateway() {
    GW=$(cat /run/awg-setup/wan-gw 2>/dev/null || cat /etc/awg-setup/wan-gw 2>/dev/null)
    DEV=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)
    # 1) из default-маршрута (не через awg0)
    if [ -z "$GW" ]; then
        GW=$(ip route show default 2>/dev/null | grep -v awg0 | awk '/default/{print $3; exit}')
        [ -z "$DEV" ] && DEV=$(ip route show default 2>/dev/null | grep -v awg0 | awk '/default/{print $5; exit}')
    fi
    # 2) знаем WAN-устройство, но не шлюз — ищем via-шлюз на этом устройстве
    if [ -z "$GW" ] && [ -n "$DEV" ]; then
        GW=$(ip route show dev "$DEV" 2>/dev/null | awk '/^default via/{print $3; exit}')
        [ -z "$GW" ] && GW=$(ip route show default dev "$DEV" 2>/dev/null | awk '{print $3; exit}')
    fi
    echo "$GW $DEV"
}

# Поднимаем туннель если ещё не поднят
if ! ip link show awg0 >/dev/null 2>&1; then
    _log "INFO awg-up: поднимаю туннель"
    awg-quick up "$CONF" > /var/log/awg-quick.log 2>&1
fi

# ── Исключаем endpoint(ы) из туннеля + ЗАЩИТА ОТ ПЕТЛИ ────────────
# Если endpoint сервера попадает в AllowedIPs (в антифильтр-конфигах туда
# попадает почти весь IPv4), без /32-исключения трафик к серверу уходит в сам
# туннель = петля (туннель «подключён», но мёртв). Вешаем /32 через WAN-шлюз
# и ПРОВЕРЯЕМ, что endpoint реально пошёл не через awg0.
set -- $(wan_gateway)
GW="$1"; DEV="$2"
[ -z "$GW" ] && _log "WARN awg-up: не нашёл WAN-шлюз — endpoint НЕ исключён, риск петли!"
# Все Endpoint из конфига (может быть несколько пиров)
for EP in $(grep -E '^Endpoint' "$CONF" | awk -F'[=]+' '{gsub(/ /,"",$2);print $2}'); do
    EP_HOST=$(echo "$EP" | sed 's/:[0-9]*$//' | tr -d '[]')
    # резолвим хостнейм -> IPv4
    EP_IP=$(getent ahostsv4 "$EP_HOST" 2>/dev/null | awk '{print $1; exit}')
    [ -z "$EP_IP" ] && EP_IP="$EP_HOST"
    # только IPv4-адрес
    case "$EP_IP" in
        *[!0-9.]*) continue ;;
    esac
    if [ -n "$GW" ]; then
        ip route replace "$EP_IP/32" via "$GW" dev "$DEV" 2>/dev/null \
            && _log "OK awg-up: endpoint $EP_IP в обход туннеля (via $GW dev $DEV)"
    fi
    # Контроль петли: endpoint НЕ должен идти через awg0
    VIA=$(ip route get "$EP_IP" 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' | head -1)
    if [ "$VIA" = "awg0" ]; then
        _log "ERR awg-up: endpoint $EP_IP ВСЁ ЕЩЁ через awg0 — ПЕТЛЯ! (GW='$GW' DEV='$DEV')"
    fi
done

# ── ЗАЩИТА РАБОЧИХ СЕТЕЙ ШЛЮЗА ────────────────────────────────────
# AllowedIPs в антифильтр-конфигах накрывают почти весь IP-простор, включая
# наши служебные сети (LAN, docker, WAN-подсеть). Connected-маршруты и так
# специфичнее, но если авто-список вдруг перехватил их в туннель — возвращаем
# напрямую. Так до вебки/SSH/контейнеров всегда можно достучаться.
keep_direct() {  # $1=подсеть/IP  $2=устройство
    [ -n "$2" ] && ip link show "$2" >/dev/null 2>&1 || return 0
    probe="${1%/*}"
    via=$(ip route get "$probe" 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' | head -1)
    if [ "$via" = "awg0" ]; then
        ip route replace "$1" dev "$2" 2>/dev/null \
            && _log "OK awg-up: вернул рабочую сеть $1 на $2 (была перехвачена туннелем)"
    fi
}
keep_direct 192.168.88.0/24 br-lan
keep_direct 172.17.0.0/16 docker0
WAN_DEV=$(cat /run/awg-setup/wan-port 2>/dev/null)
if [ -n "$WAN_DEV" ] && ip link show "$WAN_DEV" >/dev/null 2>&1; then
    # connected-подсеть WAN (например 192.168.0.0/24) — держим на WAN-устройстве
    WAN_NET=$(ip -o -4 route show dev "$WAN_DEV" scope link 2>/dev/null | awk '{print $1; exit}')
    [ -n "$WAN_NET" ] && keep_direct "$WAN_NET" "$WAN_DEV"
fi

# ── NAT для LAN-клиентов через туннель ────────────────────────────
# Без этого трафик из br-lan уходит в awg0 с приватным src 192.168.88.x,
# VPN-сервер его отбрасывает → у клиентов НЕТ интернета (хотя сам шлюз ходит,
# т.к. у него source = адрес туннеля). Идемпотентно.
if ip link show awg0 >/dev/null 2>&1; then
    if ! iptables -t nat -C POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null; then
        iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null \
            && _log "OK awg-up: включил NAT (MASQUERADE) на awg0 для LAN-клиентов"
    fi

    # ── MSS clamping ──────────────────────────────────────────────
    # Туннель MTU (~1280) меньше LAN (1500). Без клампинга большие пакеты
    # клиента не лезут в туннель и молча отбрасываются → страницы не грузятся
    # (особенно русские сайты, плохо переживающие PMTU). --clamp-mss-to-pmtu
    # САМ подстраивает MSS под текущий MTU туннеля. Идемпотентно.
    if ! iptables -t mangle -C FORWARD -o awg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; then
        iptables -t mangle -A FORWARD -o awg0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null \
            && _log "OK awg-up: включил MSS clamping для awg0 (чтобы страницы грузились у клиентов)"
    fi
fi
