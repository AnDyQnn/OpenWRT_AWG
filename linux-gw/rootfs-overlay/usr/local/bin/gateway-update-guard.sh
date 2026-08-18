#!/bin/sh
# Dead-man switch (§7). Запускается ОДИН раз на загрузке (gateway-update-guard.service,
# до gateway-compose). Если есть маркер .update-inprogress — значит прошлый накат не
# завершился (зависание / потеря питания / потеря доступа на полпути). Делаем
# авто-откат из бэкапа, снятого тем накатом, чтобы шлюз поднялся в рабочем виде.
set -u
MARKER=/etc/awg-setup/.update-inprogress
WLOG=/var/log/awg-watchdog.log
_log(){ printf '%s gateway-update-guard: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

[ -f "$MARKER" ] || exit 0   # обычная загрузка — маркера нет

_log "ОБНАРУЖЕН незавершённый накат — запускаю авто-откат (dead-man)"

# Каталог бэкапа того наката записан в маркере (поле backup).
bdir=$(grep -oE '"backup"[ ]*:[ ]*"[^"]+"' "$MARKER" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1)
from=$(grep -oE '"from"[ ]*:[ ]*"[^"]+"' "$MARKER" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1)

# 1) Образы: вернуть :rollback → :latest (страховка предыдущей рабочей версии).
for s in awg dnsmasq webui; do
    docker image inspect "gateway-$s:rollback" >/dev/null 2>&1 \
        && docker tag "gateway-$s:rollback" "gateway-$s:latest" 2>/dev/null \
        && _log "образ gateway-$s возвращён из :rollback"
done

# 2) Код /opt/gateway — из снимка дерева, если он есть в бэкапе.
if [ -n "$bdir" ] && [ -f "$bdir/gateway-tree.tar.gz" ]; then
    ( cd / && tar xzf "$bdir/gateway-tree.tar.gz" ) 2>/dev/null && _log "/opt/gateway восстановлен из $bdir"
fi

# 3) Состояние §6 — побайтово из того же бэкапа.
if [ -n "$bdir" ] && [ -d "$bdir" ]; then
    gateway-restore.sh "$bdir" >/dev/null 2>&1 && _log "состояние восстановлено из $bdir"
fi

# 4) Откатить записанную версию (если COMMIT не наступил, .version и так старая —
#    но на всякий случай выставим from из маркера).
[ -n "$from" ] && echo "$from" > /etc/awg-setup/.version 2>/dev/null

# 5) Снять маркер — откат завершён.
rm -f "$MARKER" 2>/dev/null

# Статус для UI.
mkdir -p /run/awg-setup
cat > /run/awg-setup/update-status.json <<EOF
{"stage":"rollback","state":"ok","message":"Накат был прерван (питание/зависание) — выполнен авто-откат на $from","from":"$from","to":"$from","ts":"$(date -Iseconds)"}
EOF
_log "dead-man откат завершён (версия $from)"
exit 0
