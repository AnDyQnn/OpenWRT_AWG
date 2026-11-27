#!/bin/sh
# Снимок состояния шлюза (КОД не трогаем — только пользовательское состояние §6).
# $1 = причина (update|cron|manual|pre-restore), $2 = метка (напр. версия).
# Печатает путь созданного бэкапа в stdout. Идемпотентен, безопасен для прода.
set -eu
BK=/opt/gateway-backups
WLOG=/var/log/awg-watchdog.log
reason="${1:-manual}"
label="${2:-$(cat /etc/awg-setup/.version 2>/dev/null || echo v0)}"
ts=$(date '+%Y%m%d-%H%M%S')
dir="$BK/${label}-${reason}-${ts}"
_log() { printf '%s gateway-backup: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG" 2>/dev/null || true; }

mkdir -p "$dir"

# Состояние §6 целиком — оно крошечное (килобайты). Отсутствующие пути пропускаем.
# /etc/awg-setup    — rules.json, creds/users, session-secret, orig-config, user-mode,
#                     update-config, weekly-report, wan-* и т.п.
# /etc/amnezia      — awg0.conf + приватные ключи (0600).
# dnsmasq.leases    — аренды (клиенты сохранят IP).
tar czf "$dir/state.tar.gz" \
    --ignore-failed-read \
    -C / \
    etc/awg-setup \
    etc/amnezia \
    var/lib/misc/dnsmasq.leases 2>/dev/null || true

# Метаданные.
ver="$label"
size=$(wc -c < "$dir/state.tar.gz" 2>/dev/null || echo 0)
cat > "$dir/meta.json" <<EOF
{"version":"$ver","reason":"$reason","created":"$(date -Iseconds)","ts":"$ts","size":$size}
EOF

# Контрольная сумма — целостность при восстановлении.
sha256sum "$dir/state.tar.gz" 2>/dev/null | awk '{print $1}' > "$dir/state.sha256" || true

# Права: бэкапы содержат приватные ключи VPN — закрываем.
chmod 700 "$BK" 2>/dev/null || true
chmod -R go-rwx "$dir" 2>/dev/null || true

_log "бэкап создан: $dir (причина=$reason, $size Б)"
echo "$dir"
