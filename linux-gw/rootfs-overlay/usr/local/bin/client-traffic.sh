#!/bin/sh
# Побайтовый учёт трафика по каждому LAN-клиенту через свою цепочку iptables
# GW_ACCT (только счёт, на маршрутизацию не влияет). Счётчики монотонные.
# Пишет /run/awg-setup/client-traffic.json = {"IP":{"rx":<к клиенту>,"tx":<от клиента>}}
LAN_PREFIX="192.168.88."
LEASES=/var/lib/misc/dnsmasq.leases
OUT=/run/awg-setup/client-traffic.json
TMP="$OUT.tmp"
mkdir -p /run/awg-setup

ensure() {
    iptables -t mangle -nL GW_ACCT >/dev/null 2>&1 || iptables -t mangle -N GW_ACCT
    iptables -t mangle -C FORWARD -j GW_ACCT 2>/dev/null || iptables -t mangle -I FORWARD 1 -j GW_ACCT
    [ -f "$LEASES" ] || return
    for ip in $(awk 'NF>=3{print $3}' "$LEASES" | sort -u); do
        case "$ip" in ${LAN_PREFIX}*) ;; *) continue ;; esac
        iptables -t mangle -C GW_ACCT -s "$ip" 2>/dev/null || iptables -t mangle -A GW_ACCT -s "$ip"
        iptables -t mangle -C GW_ACCT -d "$ip" 2>/dev/null || iptables -t mangle -A GW_ACCT -d "$ip"
    done
}

dump() {
    # iptables -L -v -x -n: "pkts bytes [target] prot opt in out source destination"
    # target может отсутствовать (счётное правило) -> source/destination берём как
    # два последних поля (NF-1, NF), это устойчиво к сдвигу колонок.
    iptables -t mangle -L GW_ACCT -v -x -n 2>/dev/null | awk -v p="$LAN_PREFIX" '
        index($(NF-1), p)==1 && $NF=="0.0.0.0/0" { tx[$(NF-1)]=$2; seen[$(NF-1)]=1 }
        index($NF, p)==1 && $(NF-1)=="0.0.0.0/0" { rx[$NF]=$2; seen[$NF]=1 }
        END {
            printf "{"
            first=1
            for (ip in seen) {
                if (!first) printf ","; first=0
                printf "\"%s\":{\"rx\":%d,\"tx\":%d}", ip, (rx[ip]+0), (tx[ip]+0)
            }
            printf "}\n"
        }
    ' > "$TMP" && mv "$TMP" "$OUT"
}

while true; do
    ensure
    dump
    sleep 2
done
