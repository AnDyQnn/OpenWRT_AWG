#!/bin/sh
# Раздельное туннелирование: домены из direct.list идут НАПРЯМУЮ (мимо VPN).
# Резолвим каждый домен и вешаем /32-маршрут через WAN-шлюз — он приоритетнее
# широких диапазонов AllowedIPs (которые гонят всё в туннель).
# Запускается: из веб-панели при изменении списка + из vpn-watchdog (рефреш,
# т.к. у сайтов IP меняются).
LIST=/etc/awg-setup/filter/direct.list
WLOG=/var/log/awg-watchdog.log
_log(){ printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }
[ -f "$LIST" ] || exit 0

# ── ЗАЩИТА ТУННЕЛЯ: фильтр опасных «прямых» маршрутов ─────────────
# Маршрут в таблице main с префиксом >= /1 побеждает таблицу туннеля 51820
# (правило `suppress_prefixlength 0` глушит только /0). Поэтому если в
# direct-cidrs.list или в резолве домена попадёт:
#   • слишком широкая супер-сеть (напр. 0.0.0.0/1, 128.0.0.0/2 — артефакты
#     схлопывания антифильтра) — она уведёт ВЕСЬ трафик мимо VPN;
#   • адрес из служебной/внутренней сети (LAN, WAN-подсеть, docker и сама
#     внутренняя сеть туннеля 10.13.13.0/24) — мы разорвём работу шлюза/туннеля.
# Такие кандидаты пропускаем. Порог ширины настраивается (по умолчанию /8).
MIN_PREFIX="${GW_MIN_DIRECT_PREFIX:-8}"
# Служебные и спец-диапазоны, которые НИКОГДА не должны идти «напрямую».
# RFC1918 (10/8, 172.16/12, 192.168/16) накрывает все наши сети: LAN
# 192.168.88/24, WAN-подсеть 192.168.0/24, docker 172.17/16 и внутреннюю
# сеть туннеля 10.13.13/24. Плюс loopback, link-local, CGNAT, multicast, reserved.
GW_PROTECTED_NETS="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/3 240.0.0.0/4"

_ip2int() {  # a.b.c.d -> 32-битное целое
    oIFS=$IFS; IFS=.; set -- $1; IFS=$oIFS
    echo $(( ($1<<24) + ($2<<16) + ($3<<8) + $4 ))
}
_cidr_bounds() {  # "ip" или "ip/pfx" -> LO HI PFX (границы диапазона)
    case "$1" in
        */*) _b_ip=${1%/*}; PFX=${1#*/} ;;
        *)   _b_ip=$1; PFX=32 ;;
    esac
    _b_base=$(_ip2int "$_b_ip")
    if [ "$PFX" -le 0 ]; then _b_mask=0
    elif [ "$PFX" -ge 32 ]; then _b_mask=4294967295
    else _b_mask=$(( (4294967295 << (32 - PFX)) & 4294967295 )); fi
    LO=$(( _b_base & _b_mask )); HI=$(( LO | (_b_mask ^ 4294967295) ))
}
# Границы защищённых сетей считаем один раз.
GW_PROT_BOUNDS=""
for _p in $GW_PROTECTED_NETS; do _cidr_bounds "$_p"; GW_PROT_BOUNDS="$GW_PROT_BOUNDS $LO:$HI"; done

route_safe() {  # $1 = ip или cidr; 0 = можно ставить, 1 = опасно (пропустить)
    _cidr_bounds "$1"
    _c_lo=$LO; _c_hi=$HI
    if [ "$PFX" -lt "$MIN_PREFIX" ]; then
        _log "SKIP gw-access: $1 слишком широкий (/$PFX < /$MIN_PREFIX) — увёл бы весь трафик мимо VPN"
        return 1
    fi
    for _b in $GW_PROT_BOUNDS; do
        _p_lo=${_b%:*}; _p_hi=${_b#*:}
        if [ "$_c_lo" -le "$_p_hi" ] && [ "$_p_lo" -le "$_c_hi" ]; then
            _log "SKIP gw-access: $1 пересекает служебную/внутреннюю сеть — пропущен (защита туннеля)"
            return 1
        fi
    done
    return 0
}

# WAN-шлюз (как в awg-up)
GW=$(cat /run/awg-setup/wan-gw 2>/dev/null || cat /etc/awg-setup/wan-gw 2>/dev/null)
DEV=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)
if [ -z "$GW" ]; then
    GW=$(ip route show default 2>/dev/null | grep -v awg0 | awk '/default/{print $3; exit}')
    [ -z "$DEV" ] && DEV=$(ip route show default 2>/dev/null | grep -v awg0 | awk '/default/{print $5; exit}')
fi
[ -z "$GW" ] && { _log "WARN gw-access: нет WAN-шлюза — домены 'напрямую' не применены"; exit 0; }

n=0
while IFS= read -r dom; do
    dom=$(printf '%s' "$dom" | tr -d ' \t\r')
    [ -n "$dom" ] || continue
    case "$dom" in \#*) continue ;; esac
    for ip in $(getent ahostsv4 "$dom" 2>/dev/null | awk '{print $1}' | sort -u); do
        case "$ip" in
            *[!0-9.]*) continue ;;
            0.0.0.0) continue ;;
        esac
        route_safe "$ip/32" || continue
        ip route replace "$ip/32" via "$GW" dev "$DEV" 2>/dev/null && n=$((n+1))
    done
done < "$LIST"

# Подсети «напрямую» (cidrs ресурсов split + импортированные из VPS-карты).
CIDRS=/etc/awg-setup/filter/direct-cidrs.list
if [ -f "$CIDRS" ]; then
    while IFS= read -r net; do
        net=$(printf '%s' "$net" | tr -d ' \t\r')
        [ -n "$net" ] || continue
        case "$net" in \#*) continue ;; esac
        case "$net" in
            *[!0-9./]*) continue ;;   # только IPv4-подсети
        esac
        route_safe "$net" || continue
        ip route replace "$net" via "$GW" dev "$DEV" 2>/dev/null && n=$((n+1))
    done < "$CIDRS"
fi
[ "$n" -gt 0 ] && _log "OK gw-access: $n маршрутов напрямую (мимо VPN, via $GW)"
exit 0
