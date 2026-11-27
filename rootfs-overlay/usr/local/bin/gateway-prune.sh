#!/bin/sh
# Целевая очистка после смены поколения (§8). НЕ трогает :latest и :rollback.
# Вызывается из gateway-update.sh на шаге [CLEANUP]. Идемпотентен, безопасен.
# $@ = ID образа(ов) прошлого поколения для удаления (опционально, через пробел).
#
# ⚠ Сознательно НЕ делает `docker system prune -a`: он считает :rollback мусором
#   (на него не ссылается запущенный контейнер) и снёс бы страховку отката.
WLOG=/var/log/awg-watchdog.log
KEEP_BACKUPS="${GW_KEEP_BACKUPS:-3}"
BK=/opt/gateway-backups
_log(){ printf '%s gateway-prune: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

# 1) Явно переданные осиротевшие образы прошлого поколения (бывший :rollback=N-2).
for img in "$@"; do
    [ -n "$img" ] || continue
    docker rmi "$img" >/dev/null 2>&1 && _log "удалён старый образ $img"
done

# 2) Висячие слои (безымянные) — :rollback это НЕ заденет (у него есть тег).
docker image prune -f >/dev/null 2>&1 && _log "image prune (dangling) ok"

# 3) Кэш сборки (актуально для домашней сборки/CI).
docker builder prune -f >/dev/null 2>&1 && _log "builder prune ok"

# 4) Staging-папка (после успешного APPLY больше не нужна).
rm -rf /opt/gateway-staging 2>/dev/null

# 5) Бэкапы сверх ретеншна (ручные/keep — оставляем; помечены файлом .keep).
if [ -d "$BK" ]; then
    # сортируем по времени (новые сверху), пропускаем первые K, удаляем хвост,
    # но НЕ трогаем каталоги с маркером .keep
    n=0
    for d in $(ls -1dt "$BK"/*/ 2>/dev/null); do
        [ -f "${d}.keep" ] && continue
        n=$((n+1))
        if [ "$n" -gt "$KEEP_BACKUPS" ]; then
            rm -rf "$d" && _log "удалён бэкап сверх ретеншна: $d"
        fi
    done
fi
_log "очистка завершена (ретеншн бэкапов=$KEEP_BACKUPS)"
exit 0
