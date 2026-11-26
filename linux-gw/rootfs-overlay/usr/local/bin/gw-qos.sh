#!/bin/sh
# Справедливое распределение скорости между устройствами (QoS).
#
# Проблема, которую решаем. Без управления очередью пакеты всех устройств стоят
# в одной общей FIFO у самого узкого места пути (провайдер или VPN-сервер). Кто
# открыл больше соединений (телевизор со стримингом, машина, качающая обновления
# ОС), тот и забирает почти весь канал, а у остальных скорость проседает в разы.
#
# Что делаем. Сами становимся узким местом, чуть ниже реальной скорости канала,
# и внутри раздаём полосу ПО УСТРОЙСТВАМ (CAKE, режим изоляции по хостам):
#   * одно активное устройство получает канал целиком — никаких квот;
#   * несколько конкурирующих — каждое поровну, независимо от числа соединений;
#   * устройство, которому нужно меньше доли (ТВ-стрим 25 Мбит/с), берёт сколько
#     нужно, остаток уходит остальным.
#
# Чего НЕ трогаем. Коммутация внутри LAN (порт↔порт моста, комп↔клиентская
# машина) идёт мимо qdisc br-lan — шлюз остаётся обычным коммутатором на полной
# скорости. Трафик самого шлюза и между сегментами — в неограниченный класс.
#
# Схема:
#   загрузка (к клиентам), выход br-lan:
#       HTB 1:   ├ 1:1  интернет, общий потолок WAN_DOWN
#                │   ├ 1:10  пришло из awg0 (VPN)   ceil VPN_DOWN → CAKE dual-dsthost
#                │   └ 1:20  пришло с WAN (напрямую) ceil WAN_DOWN → CAKE dual-dsthost
#                └ 1:30  всё остальное (локальное)  без ограничения → fq_codel
#       Класс выбирают марка iptables mangle FORWARD + tc fw-фильтр, по входному
#       интерфейсу. Неклассифицированное = 1:30 = без ограничения: сбой
#       классификации выключает шейпинг, но НЕ ломает сеть.
#   отдача (от клиентов): выход awg0 — CAKE VPN_UP nat dual-srchost,
#                         выход WAN  — CAKE WAN_UP nat dual-srchost.
#
# Настройки: /etc/awg-setup/qos.env (KEY=число, пишет панель). 0 = не ограничивать
# это направление. Скорости в Мбит/с — это УЖЕ ставки шейпера (панель предлагает
# ~90% от замера), скрипт их не уменьшает.
#
# Использование: gw-qos.sh apply | clear | status | measure [--enable] | daemon

CFG=/etc/awg-setup/qos.env
RUN=/run/awg-setup
STATUS="$RUN/qos-status.json"
MEASURE="$RUN/qos-measure.json"
MEASURING="$RUN/qos-measuring"
SIG="$RUN/qos-applied.sig"
WLOG=/var/log/awg-watchdog.log
LAN=br-lan
VPN=awg0
CHAIN=GW_QOS
# Марки классов. НЕ CLASSIFY: хостовый iptables 1.8.9 (nft) пишет его как
# «meta priority set», но прочитать обратно не может — после этого любой
# листинг таблицы mangle (-S/-L/iptables-save) падает с «incompatible».
# Биты 0x300000 свободны (0x1 — маршрутизация «напрямую», 0xca6c — awg).
# --set-xmark с маской не трогает чужие биты; марка ставится в FORWARD, то
# есть ПОСЛЕ выбора маршрута, и на маршрутизацию не влияет.
MARK_MASK=0x300000
MARK_VPN=0x100000
MARK_WAN=0x200000
mkdir -p "$RUN"

# Один применяющий за раз: панель и демон могут позвать apply одновременно.
_lock(){ exec 9>"$RUN/qos.lock"; flock -w 120 9 2>/dev/null || true; }
_unlock(){ flock -u 9 2>/dev/null; exec 9>&-; }
apply_locked(){ _lock; apply; r=$?; _unlock; return $r; }

_log(){ printf '%s gw-qos: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

# Значение из qos.env: только целое число, иначе 0 (файл не исполняем — source
# небезопасен, туда пишет панель).
_cfg(){
    v=$(sed -n "s/^$1=\([0-9][0-9]*\)[[:space:]]*\$/\1/p" "$CFG" 2>/dev/null | tail -1)
    echo "${v:-0}"
}
_wan(){ cat "$RUN/wan-port" 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null; }
_has(){ [ -n "$1" ] && ip link show "$1" >/dev/null 2>&1; }
_ifidx(){ cat "/sys/class/net/$1/ifindex" 2>/dev/null || echo -; }
_min(){ [ "$1" -le "$2" ] && echo "$1" || echo "$2"; }

_load(){
    ENABLED=$(_cfg ENABLED); VPN_DOWN=$(_cfg VPN_DOWN); VPN_UP=$(_cfg VPN_UP)
    WAN_DOWN=$(_cfg WAN_DOWN); WAN_UP=$(_cfg WAN_UP); WAN=$(_wan)
    # VPN едет поверх WAN — быстрее WAN он быть не может.
    [ "$WAN_DOWN" -gt 0 ] && [ "$VPN_DOWN" -gt "$WAN_DOWN" ] && VPN_DOWN=$WAN_DOWN
    [ "$WAN_UP" -gt 0 ] && [ "$VPN_UP" -gt "$WAN_UP" ] && VPN_UP=$WAN_UP
}

# Отпечаток желаемого состояния: настройки + ifindex интерфейсов. awg0 при
# переподъёме туннеля создаётся заново (новый ifindex, qdisc потерян) — по
# смене отпечатка демон переприменит.
_signature(){
    _load
    echo "$ENABLED:$VPN_DOWN:$VPN_UP:$WAN_DOWN:$WAN_UP:$WAN:$(_ifidx $LAN):$(_ifidx $VPN):$(_ifidx "$WAN")"
}

# Снять только своё: корневой qdisc br-lan (HTB 1: ставим только мы), cake на
# awg0/WAN, классификацию в mangle.
_clear_tc(){
    WAN=${WAN:-$(_wan)}
    tc qdisc show dev "$LAN" 2>/dev/null | grep -q '^qdisc htb 1: root' \
        && tc qdisc del dev "$LAN" root 2>/dev/null
    for d in "$VPN" "$WAN"; do
        _has "$d" || continue
        tc qdisc show dev "$d" 2>/dev/null | grep -q '^qdisc cake [0-9a-f]*: root' \
            && tc qdisc del dev "$d" root 2>/dev/null
    done
    iptables -t mangle -D FORWARD -j "$CHAIN" 2>/dev/null
    iptables -t mangle -F "$CHAIN" 2>/dev/null
    iptables -t mangle -X "$CHAIN" 2>/dev/null
}

_write_status(){ # $1=active(true|false) $2=note
    now=$(date '+%Y-%m-%d %H:%M:%S')
    printf '{"enabled":%s,"active":%s,"vpn_down":%s,"vpn_up":%s,"wan_down":%s,"wan_up":%s,"wan":"%s","applied_at":"%s","note":"%s"}\n' \
        "$([ "$ENABLED" = 1 ] && echo true || echo false)" "$1" \
        "$VPN_DOWN" "$VPN_UP" "$WAN_DOWN" "$WAN_UP" "$WAN" "$now" "$2" > "$STATUS.tmp" \
        && mv -f "$STATUS.tmp" "$STATUS"
}

# kbit для HTB; гарантия классу = половина потолка (остальное занимается у соседа).
_kb(){ echo $(( $1 * 1000 )); }

apply(){
    _load
    _clear_tc
    if [ "$ENABLED" != 1 ]; then
        _write_status false "выключено"
        _signature > "$SIG"; return 0
    fi
    errs=""

    # ── загрузка: br-lan ──────────────────────────────────────────
    TOT=$WAN_DOWN; [ "$TOT" -gt 0 ] || TOT=$VPN_DOWN
    if _has "$LAN" && [ "$TOT" -gt 0 ]; then
        ip link set "$LAN" txqueuelen 1000 2>/dev/null
        T=$(_kb "$TOT")
        tc qdisc replace dev "$LAN" root handle 1: htb default 30 r2q 100 \
        && tc class replace dev "$LAN" parent 1: classid 1:1 htb rate "${T}kbit" ceil "${T}kbit" quantum 3028 \
        && tc class replace dev "$LAN" parent 1: classid 1:30 htb rate 10gbit ceil 10gbit quantum 60000 \
        && tc qdisc replace dev "$LAN" parent 1:30 handle 30: fq_codel \
        || errs="$errs br-lan"
        iptables -t mangle -N "$CHAIN" 2>/dev/null; iptables -t mangle -F "$CHAIN"
        iptables -t mangle -C FORWARD -j "$CHAIN" 2>/dev/null || iptables -t mangle -A FORWARD -j "$CHAIN"
        if [ "$VPN_DOWN" -gt 0 ]; then
            C=$(_kb "$VPN_DOWN"); R=$(_kb "$(_min "$(( (VPN_DOWN + 1) / 2 ))" "$TOT")")
            tc class replace dev "$LAN" parent 1:1 classid 1:10 htb rate "${R}kbit" ceil "${C}kbit" quantum 3028 \
            && tc qdisc replace dev "$LAN" parent 1:10 handle 10: cake unlimited besteffort dual-dsthost \
            && tc filter add dev "$LAN" parent 1: protocol all prio 1 handle "$MARK_VPN/$MARK_MASK" fw classid 1:10 \
            && iptables -t mangle -A "$CHAIN" -i "$VPN" -o "$LAN+" -j MARK --set-xmark "$MARK_VPN/$MARK_MASK" \
            || errs="$errs vpn-down"
        fi
        if [ "$WAN_DOWN" -gt 0 ] && [ -n "$WAN" ]; then
            C=$(_kb "$WAN_DOWN"); R=$(_kb "$(( (WAN_DOWN + 1) / 2 ))")
            tc class replace dev "$LAN" parent 1:1 classid 1:20 htb rate "${R}kbit" ceil "${C}kbit" quantum 3028 \
            && tc qdisc replace dev "$LAN" parent 1:20 handle 20: cake unlimited besteffort dual-dsthost \
            && tc filter add dev "$LAN" parent 1: protocol all prio 1 handle "$MARK_WAN/$MARK_MASK" fw classid 1:20 \
            && iptables -t mangle -A "$CHAIN" -i "$WAN" -o "$LAN+" -j MARK --set-xmark "$MARK_WAN/$MARK_MASK" \
            || errs="$errs wan-down"
        fi
    fi

    # ── отдача: awg0 и WAN ────────────────────────────────────────
    if [ "$VPN_UP" -gt 0 ] && _has "$VPN"; then
        tc qdisc replace dev "$VPN" root cake bandwidth "$(_kb "$VPN_UP")kbit" besteffort dual-srchost nat \
            || errs="$errs vpn-up"
    fi
    if [ "$WAN_UP" -gt 0 ] && _has "$WAN"; then
        tc qdisc replace dev "$WAN" root cake bandwidth "$(_kb "$WAN_UP")kbit" besteffort dual-srchost nat \
            || errs="$errs wan-up"
    fi

    if [ -n "$errs" ]; then
        # Половинчатое состояние хуже никакого — снимаем всё.
        _clear_tc
        _write_status false "ошибка применения:$errs"
        _log "ERR не удалось применить:$errs — шейпинг снят, сеть работает без него"
        _signature > "$SIG"; return 1
    fi
    note=""; _has "$VPN" || note="туннель не поднят — VPN-часть применится при его подъёме"
    _write_status true "$note"
    _signature > "$SIG"
    _log "применено: VPN ↓$VPN_DOWN ↑$VPN_UP, напрямую ↓$WAN_DOWN ↑$WAN_UP Мбит/с (WAN=$WAN)"
}

clear_all(){
    _load; _clear_tc
    ENABLED=0; _write_status false "выключено"
    _log "шейпинг снят"
}

# Признак, что применённое реально на месте (кто-то мог снести qdisc).
_in_place(){
    _load
    [ "$ENABLED" = 1 ] || return 0
    TOT=$WAN_DOWN; [ "$TOT" -gt 0 ] || TOT=$VPN_DOWN
    if [ "$TOT" -gt 0 ] && _has "$LAN"; then
        tc qdisc show dev "$LAN" 2>/dev/null | grep -q '^qdisc htb 1: root' || return 1
        iptables -t mangle -C FORWARD -j "$CHAIN" 2>/dev/null || return 1
    fi
    if [ "$VPN_UP" -gt 0 ] && _has "$VPN"; then
        tc qdisc show dev "$VPN" 2>/dev/null | grep -q '^qdisc cake' || return 1
    fi
    if [ "$WAN_UP" -gt 0 ] && _has "$WAN"; then
        tc qdisc show dev "$WAN" 2>/dev/null | grep -q '^qdisc cake' || return 1
    fi
    return 0
}

# ── Замер скорости канала ─────────────────────────────────────────
# Параллельные потоки к speed.cloudflare.com (anycast — ближайшая точка и для
# российского WAN, и для выхода VPN). Потоки качают В ЦИКЛЕ до дедлайна, а
# скорость берём по счётчику интерфейса в окне [3 с .. 10 с] — так разгон TCP
# (slow start, особенно на VPN с большим RTT) не занижает результат на быстрых
# каналах. На время замера шейпинг снимается, иначе меряли бы сами себя.
_DL_URL="https://speed.cloudflare.com/__down?bytes=25000000"
_DL_PROBE="https://speed.cloudflare.com/__down?bytes=1000"
_DL_FALLBACK="https://speedtest.selectel.ru/100MB"
_UL_URL="https://speed.cloudflare.com/__up"
_STREAMS=4
_RUN_S=12        # сколько живут потоки
_WIN_FROM=3      # окно измерения, секунды от старта
_WIN_TO=10

_mstatus(){ # $1=state $2=step
    printf '{"state":"%s","step":"%s","vpn_down":%s,"vpn_up":%s,"wan_down":%s,"wan_up":%s,"at":"%s"}\n' \
        "$1" "$2" "${M_VD:-0}" "${M_VU:-0}" "${M_WD:-0}" "${M_WU:-0}" "$(date '+%Y-%m-%d %H:%M:%S')" \
        > "$MEASURE.tmp" && mv -f "$MEASURE.tmp" "$MEASURE"
}

_now(){ awk '{print $1}' /proc/uptime; }      # секунды с долями
_ctr(){ cat "/sys/class/net/$1/statistics/$2" 2>/dev/null || echo 0; }

# Один поток: повторяет запрос, пока не выйдет время. $1=ifc $2=down|up $3=url $4=файл-кодов
_stream(){
    end=$(( $(date +%s) + _RUN_S ))
    while :; do
        left=$(( end - $(date +%s) )); [ "$left" -gt 0 ] || break
        if [ "$2" = down ]; then
            curl -s -o /dev/null -m "$left" --interface "$1" -w '%{http_code}\n' "$3" >> "$4" 2>/dev/null
        else
            # -T - шлёт поток (chunked), не читая всё в память, как --data-binary @-
            head -c 400000000 /dev/zero | curl -s -o /dev/null -m "$left" --interface "$1" \
                -X POST -T - -w '%{http_code}\n' "$3" >> "$4" 2>/dev/null
        fi
    done
}

# Замер «напрямую» при поднятом VPN. Ответ сервера приходит на WAN, а обратный
# маршрут к нему (таблица awg, 0.0.0.0/0) ведёт в туннель — строгий rp_filter
# (gw-firewall) режет такие пакеты как martian, и замер выходит нулевым. На
# время замера ведём адреса серверов замера через WAN явными /32 (main table,
# suppress_prefixlength 0 их пропускает) — тот же приём, что в auto-timezone.
_PINNED=""
_pin_wan(){ # $1=WAN-устройство
    gw=$(cat "$RUN/wan-gw" 2>/dev/null || cat /etc/awg-setup/wan-gw 2>/dev/null)
    [ -z "$gw" ] && gw=$(ip route show default dev "$1" 2>/dev/null | awk '/via/{print $3; exit}')
    [ -n "$gw" ] || return 0
    for h in speed.cloudflare.com speedtest.selectel.ru; do
        for a in $(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}' | sort -u); do
            ip route show "$a/32" 2>/dev/null | grep -q . && continue   # чужой — не трогаем
            ip route add "$a/32" via "$gw" dev "$1" 2>/dev/null && _PINNED="$_PINNED $a"
        done
    done
}
_unpin_wan(){
    for a in $_PINNED; do ip route del "$a/32" 2>/dev/null; done
    _PINNED=""
}

# $1=интерфейс $2=down|up → Мбит/с (целое; 0 = не удалось)
_speed(){
    url=$_UL_URL; stat=tx_bytes
    if [ "$2" = down ]; then
        stat=rx_bytes; url=$_DL_URL
        code=$(curl -s -o /dev/null -m 6 --interface "$1" -w '%{http_code}' "$_DL_PROBE" 2>/dev/null)
        [ "$code" = 200 ] || url=$_DL_FALLBACK
    fi
    dir=$(mktemp -d)
    i=0
    while [ $i -lt $_STREAMS ]; do
        _stream "$1" "$2" "$url" "$dir/codes" &
        i=$((i+1))
    done
    sleep "$_WIN_FROM"; b1=$(_ctr "$1" "$stat"); t1=$(_now)
    sleep $(( _WIN_TO - _WIN_FROM )); b2=$(_ctr "$1" "$stat"); t2=$(_now)
    wait
    # Критерий — реально прошедшие байты, а не коды ответа: отдача обрывается по
    # дедлайну (код 000) штатно, а сервер, отвечающий отказом, байт не нагонит.
    if [ "$(( b2 - b1 ))" -gt 1000000 ]; then
        awk -v b="$(( b2 - b1 ))" -v t1="$t1" -v t2="$t2" \
            'BEGIN { d = t2 - t1; if (d <= 0) d = 1; printf "%d\n", b * 8 / d / 1000000 }'
    else
        echo 0
    fi
    rm -rf "$dir"
}

measure(){
    want_enable="$1"
    if [ -f "$MEASURING" ] && kill -0 "$(cat "$MEASURING" 2>/dev/null)" 2>/dev/null; then
        echo "замер уже идёт"; return 1
    fi
    echo $$ > "$MEASURING"
    _lock
    trap '_unpin_wan; rm -f "$MEASURING"' EXIT INT TERM
    M_VD=0; M_VU=0; M_WD=0; M_WU=0
    _mstatus running "подготовка"
    _load; _clear_tc
    rm -f "$SIG"   # демон переприменит после замера
    if _has "$VPN"; then
        _mstatus running "через VPN: загрузка";  M_VD=$(_speed "$VPN" down)
        _mstatus running "через VPN: отдача";    M_VU=$(_speed "$VPN" up)
    fi
    if _has "$WAN"; then
        _pin_wan "$WAN"
        _mstatus running "напрямую: загрузка";   M_WD=$(_speed "$WAN" down)
        _mstatus running "напрямую: отдача";     M_WU=$(_speed "$WAN" up)
        _unpin_wan
    fi
    if [ "${M_VD:-0}" -eq 0 ] && [ "${M_WD:-0}" -eq 0 ]; then
        _mstatus error "не удалось измерить (нет связи с сервером замера)"
        _log "WARN замер скорости не удался"
        apply >/dev/null 2>&1
        return 1
    fi
    _mstatus "done" "готово"
    _log "замер: VPN ↓$M_VD ↑$M_VU, напрямую ↓$M_WD ↑$M_WU Мбит/с"
    if [ "$want_enable" = "--enable" ]; then
        # ставки = 90% замера: шейпер должен быть чуть уже реального канала,
        # иначе очередь снова соберётся у провайдера и честность пропадёт.
        p(){ echo $(( $1 * 90 / 100 )); }
        cat > "$CFG.tmp" <<EOF
ENABLED=1
VPN_DOWN=$(p "$M_VD")
VPN_UP=$(p "$M_VU")
WAN_DOWN=$(p "$M_WD")
WAN_UP=$(p "$M_WU")
EOF
        mv -f "$CFG.tmp" "$CFG"
    fi
    apply
}

status(){
    cat "$STATUS" 2>/dev/null || echo '{}'
    WAN=$(_wan)
    for d in "$LAN" "$VPN" "$WAN"; do
        _has "$d" || continue
        echo "── $d"; tc -s qdisc show dev "$d" 2>/dev/null
        [ "$d" = "$LAN" ] && tc -s class show dev "$d" 2>/dev/null
    done
    iptables -t mangle -L "$CHAIN" -v -n 2>/dev/null
}

# Демон: следит, чтобы применённое соответствовало настройкам и интерфейсам.
# Дёшево: раз в 10 с сравнивает отпечаток и наличие qdisc.
daemon(){
    _log "демон запущен"
    rm -f "$SIG"
    while true; do
        if [ ! -f "$MEASURING" ]; then
            cur=$(_signature)
            if [ "$cur" != "$(cat "$SIG" 2>/dev/null)" ] || ! _in_place; then
                apply_locked >/dev/null 2>&1
            fi
        fi
        sleep 10
    done
}

case "$1" in
    apply)   apply_locked ;;
    clear)   _lock; clear_all; _unlock ;;
    status)  status ;;
    measure) measure "$2" ;;
    daemon)  daemon ;;
    *) echo "usage: $0 apply|clear|status|measure [--enable]|daemon"; exit 2 ;;
esac
