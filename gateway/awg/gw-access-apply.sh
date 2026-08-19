#!/bin/sh
# Применяет правила доступа к ресурсам (кастомный МЭ): группы доменов -> ipset,
# правила -> цепочка iptables FORWARD с матчем по MAC клиента.
#
# Источник правды — два ПЛОСКИХ файла, которые генерит веб-панель (чтобы не
# парсить JSON в sh). Их же перечитывает watchdog для рефреша IP (у сайтов
# адреса меняются):
#
#   access-sets.txt   строки:  <setname> <domain>
#                     какие домены резолвить в какой ipset.
#   access-rules.txt  строки:  <setname>|<action>|<scope>|<mac1,mac2,...>
#                     action: block (пока только блок)
#                     scope:  all   — блок для всех
#                             only  — блок ТОЛЬКО перечисленным MAC (чёрный список)
#                             except— блок всем, КРОМЕ перечисленных MAC (белый список)
#
# Запуск: из веб-панели при изменении правил + из vpn-watchdog (рефреш).
# Идемпотентно: полностью пересобирает наборы и цепочку с нуля.

SETS=/etc/awg-setup/filter/access-sets.txt
RULESF=/etc/awg-setup/filter/access-rules.txt
WLOG=/var/log/awg-watchdog.log
CHAIN=GW_ACCESS
_log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

# ── Тот же фильтр, что в gw-access-routes: не пускаем в наборы адреса из
# служебных/внутренних сетей (домен может срезолвиться в приватный IP — тогда
# REJECT-правило заблокировало бы внутренний ресурс/часть туннеля). ───────────
GW_PROTECTED_NETS="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/3 240.0.0.0/4"
_ip2int() { oIFS=$IFS; IFS=.; set -- $1; IFS=$oIFS; echo $(( ($1<<24) + ($2<<16) + ($3<<8) + $4 )); }
_cidr_bounds() {
    case "$1" in */*) _b_ip=${1%/*}; PFX=${1#*/} ;; *) _b_ip=$1; PFX=32 ;; esac
    _b_base=$(_ip2int "$_b_ip")
    if [ "$PFX" -le 0 ]; then _b_mask=0
    elif [ "$PFX" -ge 32 ]; then _b_mask=4294967295
    else _b_mask=$(( (4294967295 << (32 - PFX)) & 4294967295 )); fi
    LO=$(( _b_base & _b_mask )); HI=$(( LO | (_b_mask ^ 4294967295) ))
}
GW_PROT_BOUNDS=""
for _p in $GW_PROTECTED_NETS; do _cidr_bounds "$_p"; GW_PROT_BOUNDS="$GW_PROT_BOUNDS $LO:$HI"; done
ip_internal() {  # 0 = внутренний/служебный (пропустить), 1 = внешний (можно)
    _cidr_bounds "$1"; _c_lo=$LO; _c_hi=$HI
    for _b in $GW_PROT_BOUNDS; do
        _p_lo=${_b%:*}; _p_hi=${_b#*:}
        [ "$_c_lo" -le "$_p_hi" ] && [ "$_p_lo" -le "$_c_hi" ] && return 0
    done
    return 1
}

command -v ipset >/dev/null 2>&1 || { _log "ERR gw-access-apply: нет ipset в контейнере"; exit 1; }

# Модули ядра (на хосте, контейнер privileged) — на случай если не подгружены.
modprobe ip_set 2>/dev/null
modprobe ip_set_hash_ip 2>/dev/null
modprobe xt_set 2>/dev/null

# ── 1) Наборы ipset: домен -> резолв в IP, атомарный swap ──────────
# Имена наборов берём из обоих файлов (set может не иметь доменов -> пустой).
setnames=$( { [ -f "$SETS" ] && awk '{print $1}' "$SETS"
             [ -f "$RULESF" ] && awk -F'|' '{print $1}' "$RULESF"; } \
           | grep -vE '^#|^$' | sort -u )

for s in $setnames; do
    case "$s" in gwacc_*) ;; *) continue ;; esac   # только наши наборы
    ipset create "$s" hash:ip family inet -exist 2>/dev/null
    tmp="${s}_t"
    ipset create "$tmp" hash:ip family inet -exist 2>/dev/null
    ipset flush "$tmp" 2>/dev/null
    if [ -f "$SETS" ]; then
        awk -v S="$s" '$1==S{print $2}' "$SETS" | while IFS= read -r dom; do
            dom=$(printf '%s' "$dom" | tr -d ' \t\r')
            [ -n "$dom" ] || continue
            case "$dom" in \#*) continue ;; esac
            for ip in $(getent ahostsv4 "$dom" 2>/dev/null | awk '{print $1}' | sort -u); do
                case "$ip" in
                    *[!0-9.]*) continue ;;
                    0.0.0.0|127.*) continue ;;
                esac
                ip_internal "$ip" && continue   # не блокируем внутренние/служебные адреса
                ipset add "$tmp" "$ip" -exist 2>/dev/null
            done
        done
    fi
    ipset swap "$tmp" "$s" 2>/dev/null
    ipset destroy "$tmp" 2>/dev/null
done

# ── 2) Пересобираем цепочку iptables FORWARD ──────────────────────
# Каждое правило -> своя подцепочка GW_ACC_<n>, чтобы RETURN (для scope=except)
# не выходил из общей цепочки и не отменял правила других групп.
iptables -N "$CHAIN" 2>/dev/null
iptables -F "$CHAIN" 2>/dev/null
# сносим старые подцепочки правил
for c in $(iptables -S 2>/dev/null | awk '/^-N GW_ACC_/{print $2}'); do
    iptables -F "$c" 2>/dev/null
    iptables -X "$c" 2>/dev/null
done
# гарантируем вход из FORWARD (первым правилом)
iptables -C FORWARD -j "$CHAIN" 2>/dev/null || iptables -I FORWARD 1 -j "$CHAIN"

n_rules=0
if [ -f "$RULESF" ]; then
    idx=0
    while IFS='|' read -r setname action scope macs; do
        setname=$(printf '%s' "$setname" | tr -d ' \t\r')
        [ -n "$setname" ] || continue
        case "$setname" in \#*) continue ;; esac
        action=$(printf '%s' "$action" | tr -d ' \t\r')
        scope=$(printf '%s' "$scope" | tr -d ' \t\r')
        [ "$action" = "block" ] || continue
        # набор должен существовать
        ipset list -n "$setname" >/dev/null 2>&1 || continue

        idx=$((idx+1))
        sub="GW_ACC_${idx}"
        iptables -N "$sub" 2>/dev/null
        iptables -F "$sub" 2>/dev/null
        # REJECT: TCP — мгновенный reset, остальное — icmp prohibited
        case "$scope" in
            only)
                OIFS=$IFS; IFS=','
                for m in $macs; do
                    [ -n "$m" ] || continue
                    iptables -A "$sub" -m mac --mac-source "$m" -m set --match-set "$setname" dst -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null
                    iptables -A "$sub" -m mac --mac-source "$m" -m set --match-set "$setname" dst -j REJECT --reject-with icmp-port-unreachable 2>/dev/null
                done
                IFS=$OIFS
                ;;
            except)
                OIFS=$IFS; IFS=','
                for m in $macs; do
                    [ -n "$m" ] || continue
                    # разрешённым — выходим из подцепочки (трафик пойдёт дальше)
                    iptables -A "$sub" -m mac --mac-source "$m" -m set --match-set "$setname" dst -j RETURN 2>/dev/null
                done
                IFS=$OIFS
                iptables -A "$sub" -m set --match-set "$setname" dst -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null
                iptables -A "$sub" -m set --match-set "$setname" dst -j REJECT --reject-with icmp-port-unreachable 2>/dev/null
                ;;
            *)  # all
                iptables -A "$sub" -m set --match-set "$setname" dst -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null
                iptables -A "$sub" -m set --match-set "$setname" dst -j REJECT --reject-with icmp-port-unreachable 2>/dev/null
                ;;
        esac
        iptables -A "$CHAIN" -j "$sub" 2>/dev/null
        n_rules=$((n_rules+1))
    done < "$RULESF"
fi

_log "OK gw-access-apply: наборов=$(echo "$setnames" | grep -c gwacc_) правил=$n_rules"
exit 0
