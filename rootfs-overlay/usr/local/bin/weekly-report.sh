#!/bin/sh
# Еженедельный отчёт. Запускается по воскресеньям в 02:00.

WLOG="/var/log/awg-watchdog.log"
REPORT="/etc/awg-setup/weekly-report.json"
STATS_DIR="/run/awg-stats"

FAILOVER=$(cat "$STATS_DIR/failover_count"  2>/dev/null || echo 0)
RECOVERY=$(cat "$STATS_DIR/recovery_count"  2>/dev/null || echo 0)
RESTARTS=$(cat "$STATS_DIR/service_restarts" 2>/dev/null || echo 0)
DEVICES=$(wc -l < /var/lib/misc/dnsmasq.leases 2>/dev/null | tr -d ' ')
[ -z "$DEVICES" ] && DEVICES=0

OK_LINES=$(grep -c ' OK '   "$WLOG" 2>/dev/null || echo 0)
TOTAL=$((OK_LINES + $(grep -c ' WARN \| ERR ' "$WLOG" 2>/dev/null || echo 0)))
VPN_PCT=0
[ "$TOTAL" -gt 0 ] && VPN_PCT=$(awk "BEGIN{printf \"%.1f\", $OK_LINES/$TOTAL*100}")

cat > "$REPORT" <<EOF
{"vpn_uptime_pct":${VPN_PCT},"failover_total":${FAILOVER},"recovery_total":${RECOVERY},"service_restarts":${RESTARTS},"devices":${DEVICES},"generated":"$(date -Iseconds)"}
EOF

# Сброс счётчиков
echo 0 > "$STATS_DIR/failover_count"
echo 0 > "$STATS_DIR/recovery_count"
echo 0 > "$STATS_DIR/service_restarts"

printf '%s INFO Weekly report generated (VPN uptime: %s%%)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$VPN_PCT" >> "$WLOG"
