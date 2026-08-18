#!/bin/sh
# Мониторинг сервисов. Запускается каждую минуту через sysmon.timer.

WLOG="/var/log/awg-watchdog.log"
STATS_DIR="/run/awg-stats"
_log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }
mkdir -p "$STATS_DIR"

RESTARTS=$(cat "$STATS_DIR/service_restarts" 2>/dev/null || echo 0)

# Сервисы шлюза (VPN, DHCP/DNS, веб-панель) живут в Docker-контейнерах, а НЕ как
# host-сервисы. Поэтому мониторим контейнеры, а не systemd-юниты nginx/dnsmasq
# (их на хосте нет — старый код спамил журнал «failed to restart»).
for cont in gw-awg gw-dnsmasq gw-webui; do
    state=$(docker inspect -f '{{.State.Running}}' "$cont" 2>/dev/null)
    if [ "$state" != "true" ]; then
        _log "WARN контейнер $cont не запущен, поднимаю"
        if docker start "$cont" >/dev/null 2>&1; then
            _log "OK контейнер $cont поднят"
        else
            _log "ERR контейнер $cont не поднялся (см. docker logs $cont)"
        fi
        RESTARTS=$((RESTARTS + 1))
        echo "$RESTARTS" > "$STATS_DIR/service_restarts"
    fi
done

# WAN interface
WAN_PORT=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null || echo "")
if [ -n "$WAN_PORT" ]; then
    if ! ip addr show "$WAN_PORT" | grep -q 'inet '; then
        _log "WARN WAN $WAN_PORT lost IP, trying dhcpcd"
        dhcpcd "$WAN_PORT" 2>/dev/null || dhclient "$WAN_PORT" 2>/dev/null || true
    fi
fi

# Память
MEM_FREE=$(awk '/MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null || echo 99999)
if [ "$MEM_FREE" -lt 20480 ] 2>/dev/null; then
    _log "WARN low memory (${MEM_FREE}KB), dropping caches"
    echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
fi

# Ротация журнала: чтобы awg-watchdog.log не рос бесконечно — при >1 МБ
# оставляем последние 2000 строк (журнал самоочищается, диск не забивается).
if [ -f "$WLOG" ]; then
    SZ=$(wc -c < "$WLOG" 2>/dev/null || echo 0)
    if [ "$SZ" -gt 1048576 ] 2>/dev/null; then
        tail -n 2000 "$WLOG" > "${WLOG}.tmp" 2>/dev/null && mv "${WLOG}.tmp" "$WLOG"
        _log "INFO Журнал усечён до 2000 строк (был ${SZ} байт)"
    fi
fi
