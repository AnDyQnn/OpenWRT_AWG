#!/bin/sh
# Авто-определение часового пояса через интернет (geo-IP) при загрузке.
# Само ВРЕМЯ ставит NTP (systemd-timesyncd); этот скрипт ставит ПОЯС.
#
# ВАЖНО: запрос геолокации идёт ЧЕРЕЗ WAN в обход VPN-туннеля — иначе geo-IP
# вернёт локацию VPN-сервера (другая страна/пояс), а не реальную.
# Фолбэк — Europe/Moscow.
LOG=/var/log/awg-watchdog.log
DEFAULT_TZ="Europe/Moscow"
_log(){ printf '%s auto-tz: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

get_wan() {
    GW=$(cat /run/awg-setup/wan-gw 2>/dev/null || cat /etc/awg-setup/wan-gw 2>/dev/null)
    DEV=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)
    if [ -z "$GW" ]; then
        GW=$(ip route show default 2>/dev/null | grep -v awg0 | awk '/default/{print $3; exit}')
        DEV=$(ip route show default 2>/dev/null | grep -v awg0 | awk '/default/{print $5; exit}')
    fi
    echo "$GW $DEV"
}

# geo-IP строго через WAN: резолвим сервер, вешаем /32 через WAN-шлюз, спрашиваем
geoip_tz() {
    set -- $(get_wan); GW="$1"; DEV="$2"
    IP=$(getent ahostsv4 ip-api.com 2>/dev/null | awk '{print $1; exit}')
    [ -z "$IP" ] && return 1
    ADDED=0
    if [ -n "$GW" ] && [ -n "$DEV" ]; then
        ip route add "$IP/32" via "$GW" dev "$DEV" 2>/dev/null && ADDED=1
    fi
    tz=$(curl -s --max-time 8 -H "Host: ip-api.com" "http://$IP/line/?fields=timezone" 2>/dev/null)
    [ "$ADDED" = 1 ] && ip route del "$IP/32" 2>/dev/null
    printf '%s' "$tz"
}

set_tz() {
    tz="$1"
    [ -f "/usr/share/zoneinfo/$tz" ] || return 1
    if command -v timedatectl >/dev/null 2>&1; then
        timedatectl set-timezone "$tz" 2>/dev/null
    else
        ln -sf "/usr/share/zoneinfo/$tz" /etc/localtime
        echo "$tz" > /etc/timezone
    fi
    _log "часовой пояс установлен: $tz ($(date '+%Z %z'))"
}

# Ждём интернет и спрашиваем geo-IP через WAN (до ~1 мин)
TZ=""
i=0
while [ $i -lt 12 ]; do
    TZ=$(geoip_tz)
    case "$TZ" in
        */*) [ -f "/usr/share/zoneinfo/$TZ" ] && break ;;
    esac
    TZ=""
    sleep 5
    i=$((i + 1))
done

if [ -n "$TZ" ]; then
    _log "geo-IP (через WAN) определил пояс: $TZ"
    set_tz "$TZ" || set_tz "$DEFAULT_TZ"
else
    _log "geo-IP недоступен -> фолбэк $DEFAULT_TZ"
    set_tz "$DEFAULT_TZ"
fi
