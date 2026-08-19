#!/bin/sh
# Порт SSH — это СОСТОЯНИЕ машины, а не код проекта.
#
# Почему так. Раньше порт был прописан в rootfs-overlay/etc/ssh/sshd_config.d/
# 10-gateway.conf, то есть лежал в публичном репозитории: любой видел, на каком
# порту стоит SSH у всех установок. Плюс накат перезаписывал этот файл из репо —
# и порт, изменённый владельцем в панели, откатывался обратно на опубликованный.
#
# Теперь порт живёт в отдельном drop-in, которого в репозитории НЕТ:
#   /etc/ssh/sshd_config.d/20-gateway-port.conf
# Обновление его не трогает (cp -a копирует только то, что есть в репозитории),
# а у каждой установки порт свой.
#
#   gateway-ssh-port.sh ensure      — создать, если нет (перенос старого / случайный)
#   gateway-ssh-port.sh get         — напечатать текущий порт
#   gateway-ssh-port.sh set <порт>  — задать и перечитать sshd
set -u

PORT_FILE=/etc/ssh/sshd_config.d/20-gateway-port.conf
LEGACY=/etc/ssh/sshd_config.d/10-gateway.conf
STATE=/etc/awg-setup/ssh-port          # дубль для панели и экрана готовности
WLOG=/var/log/awg-watchdog.log
DEFAULT_MIN=20000
DEFAULT_MAX=59999

_log(){ printf '%s gateway-ssh-port: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG" 2>/dev/null; }

_valid(){ case "${1:-}" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# Случайный порт из /dev/urandom (в dash нет $RANDOM).
_random_port(){
    n=$(od -An -N2 -tu2 < /dev/urandom 2>/dev/null | tr -d ' \n')
    [ -n "$n" ] || n=$$
    echo $(( DEFAULT_MIN + (n % (DEFAULT_MAX - DEFAULT_MIN + 1)) ))
}

_write(){  # $1 = порт
    mkdir -p /etc/ssh/sshd_config.d /etc/awg-setup
    cat > "$PORT_FILE" <<EOF
# SSH-порт этой установки. Файла НЕТ в репозитории — он задаётся на устройстве,
# поэтому обновление его не перезаписывает, и порт не публикуется в исходниках.
# Сменить: панель → Система → Безопасность → SSH-доступ, либо
#          gateway-ssh-port.sh set <порт>
Port $1
EOF
    chmod 644 "$PORT_FILE"
    printf '%s\n' "$1" > "$STATE"
}

do_get(){
    p=$(grep -iE '^[[:space:]]*Port[[:space:]]' "$PORT_FILE" 2>/dev/null | awk '{print $2}' | tail -1)
    _valid "${p:-}" && { echo "$p"; return 0; }
    p=$(cat "$STATE" 2>/dev/null)
    _valid "${p:-}" && { echo "$p"; return 0; }
    echo 22
}

do_ensure(){
    p=$(grep -iE '^[[:space:]]*Port[[:space:]]' "$PORT_FILE" 2>/dev/null | awk '{print $2}' | tail -1)
    if _valid "${p:-}"; then printf '%s\n' "$p" > "$STATE"; echo "$p"; return 0; fi

    # Перенос со старых установок: порт мог лежать в 10-gateway.conf, который
    # накат вот-вот перезапишет версией из репозитория (уже без Port). Если не
    # перенести — sshd после reload уедет на 22 и доступ потеряется.
    p=$(grep -iE '^[[:space:]]*Port[[:space:]]' "$LEGACY" 2>/dev/null | awk '{print $2}' | tail -1)
    if _valid "${p:-}"; then
        _write "$p"; _log "порт перенесён из 10-gateway.conf: $p"; echo "$p"; return 0
    fi

    p=$(_random_port)
    _write "$p"; _log "сгенерирован случайный порт: $p"; echo "$p"
}

do_set(){
    _valid "${1:-}" || { echo "usage: gateway-ssh-port.sh set <1..65535>" >&2; return 2; }
    _write "$1"
    if sshd -t 2>/dev/null; then
        systemctl reload ssh 2>/dev/null || systemctl restart ssh 2>/dev/null
        _log "порт изменён на $1"
        echo "$1"
    else
        _log "ОШИБКА: sshd -t не прошёл после смены порта на $1"
        return 1
    fi
}

case "${1:-get}" in
    ensure) do_ensure ;;
    get)    do_get ;;
    set)    do_set "${2:-}" ;;
    *) echo "usage: gateway-ssh-port.sh {ensure|get|set <порт>}" >&2; exit 2 ;;
esac
