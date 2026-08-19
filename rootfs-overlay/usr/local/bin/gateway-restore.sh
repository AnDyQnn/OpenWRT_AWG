#!/bin/sh
# Восстановление состояния шлюза из бэкапа. $1 = путь к каталогу бэкапа.
# ВАЖНО: восстанавливаем ПОБАЙТОВО и поверх — так корректно откатываются и
# миграции схемы (старый формат rules.json вернётся как был).
set -eu
dir="${1:?usage: gateway-restore.sh <backup-dir>}"
WLOG=/var/log/awg-watchdog.log
_log() { printf '%s gateway-restore: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG" 2>/dev/null || true; }

[ -f "$dir/state.tar.gz" ] || { _log "ERR нет $dir/state.tar.gz"; echo "ERR: нет архива в $dir" >&2; exit 1; }

# Проверка целостности перед распаковкой (защита от битого/подменённого архива).
want=$(cat "$dir/state.sha256" 2>/dev/null || echo "")
have=$(sha256sum "$dir/state.tar.gz" 2>/dev/null | awk '{print $1}')
if [ -n "$want" ] && [ "$want" != "$have" ]; then
    _log "ERR sha256 не сошёлся для $dir (want=$want have=$have)"
    echo "ERR: контрольная сумма не совпала" >&2
    exit 1
fi

# Снимаем «pre-restore» страховку текущего состояния (на случай отмены).
gateway-backup.sh pre-restore safety >/dev/null 2>&1 || true

# Распаковка поверх корня — tar перезапишет файлы состояния как были в бэкапе.
tar xzf "$dir/state.tar.gz" -C / && _log "состояние восстановлено из $dir" || {
    _log "ERR распаковка не удалась"; echo "ERR: распаковка не удалась" >&2; exit 1; }

# Перечитать восстановленное состояние сервисами. НЕ трогаем gw-webui (он читает
# состояние live; его перезапуск оборвал бы запрос из панели). Перезапускаем
# только потребителей состояния: awg (VPN-конфиг/маршруты) и dnsmasq (резервы/блоки).
docker restart gw-awg gw-dnsmasq >/dev/null 2>&1 || \
    ( cd /opt/gateway && docker compose up -d ) >/dev/null 2>&1 || true
_log "восстановление завершено из $dir"
echo "OK"
