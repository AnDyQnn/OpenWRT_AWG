#!/bin/sh
# Периодический «тик» обновлений (вызывается gateway-update.timer, напр. раз в 30м).
# 1) всегда обновляет «плашку» о доступной версии (gateway-update.sh check);
# 2) по режиму из update-config.json решает, накатывать ли автоматически.
# Ручной накат идёт мимо этого скрипта — webui зовёт gateway-update.sh apply.
set -u
CFG=/etc/awg-setup/update-config.json
STAMP=/run/awg-setup/last-auto-update     # защита «один авто-накат в сутки»
WLOG=/var/log/awg-watchdog.log
_log(){ printf '%s gateway-update-tick: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }
mkdir -p /run/awg-setup

_cfg(){ grep -oE "\"$1\"[ ]*:[ ]*\"[^\"]+\"" "$CFG" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1; }

# 1) Проверка наличия версии (обновляет плашку, дешёвый GET).
gateway-update.sh check >/dev/null 2>&1
rc=$?   # 0=есть обновление, 1=актуально, 2=канал недоступен
[ "$rc" = "0" ] || exit 0   # нечего катить (или нет связи)

mode=$(_cfg mode); [ -n "$mode" ] || mode="manual"
[ "$mode" = "manual" ] && { _log "доступно обновление, режим manual — жду кнопку"; exit 0; }

# защита: не чаще раза в сутки
today=$(date '+%Y-%m-%d')
[ "$(cat "$STAMP" 2>/dev/null)" = "$today" ] && exit 0

now_h=$(date '+%H'); now_hm=$(date '+%H:%M')

case "$mode" in
    nightly)
        # окно 04:00–04:59 локального времени
        [ "$now_h" = "04" ] || exit 0
        ;;
    scheduled)
        want=$(_cfg scheduled_time); [ -n "$want" ] || want="04:30"
        # допуск ±15 минут вокруг заданного времени
        wmin=$(( $(echo "$want" | cut -d: -f1)*60 + $(echo "$want" | cut -d: -f2) ))
        nmin=$(( $(echo "$now_hm" | cut -d: -f1)*60 + $(echo "$now_hm" | cut -d: -f2) ))
        d=$(( nmin - wmin )); [ "$d" -lt 0 ] && d=$(( -d ))
        [ "$d" -le 15 ] || exit 0
        # уровень: patch — только X.Y.* (та же major.minor)
        lvl=$(_cfg auto_level); [ -n "$lvl" ] || lvl="all"
        if [ "$lvl" = "patch" ]; then
            cur=$(cat /etc/awg-setup/.version 2>/dev/null || echo 0.0.0)
            new=$(grep -oE '"to"[ ]*:[ ]*"[^"]+"' /run/awg-setup/update-status.json 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | head -1)
            cmm=$(echo "$cur" | cut -d. -f1,2); nmm=$(echo "$new" | cut -d. -f1,2)
            [ "$cmm" = "$nmm" ] || { _log "auto_level=patch, $new не patch к $cur — пропуск"; exit 0; }
        fi
        ;;
    *) exit 0 ;;
esac

echo "$today" > "$STAMP"
_log "авто-накат (режим $mode) — запускаю gateway-update.sh apply"
gateway-update.sh apply >/dev/null 2>&1
exit 0
