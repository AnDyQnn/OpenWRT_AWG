#!/bin/sh
# Адаптивная сегментация сети (Ф4). Работает И на простом железе (L3-политики,
# без managed-свитча), И с VLAN-aware железом (настоящий L2 на 802.1Q) — выбор
# автоматический по наличию vlan_id у сегмента и поддержке 8021q ядром.
#
# Состояние webui кладёт в плоский файл (как для access/direct):
#   /etc/awg-setup/filter/network-segments.list — по строке на сегмент:
#     id|name|subnet|gw_ip|dhcp_start|dhcp_end|lease|egress|vlan_id|isolated|reachable_from
#   egress = vpn|internet|local ; vlan_id = пусто(L3)|число(L2) ; isolated=0|1 ;
#   reachable_from = all|none|csv-id (кто может ИНИЦИИРОВАТЬ связь В этот сегмент;
#   кейс 1С: egress=local + reachable_from=all — сервер без интернета, но доступен всем).
# DHCP-диапазоны VLAN-сегментов webui пишет отдельным dnsmasq-конфигом
# (zz-network-dhcp.conf). Этот скрипт делает L2/L3 + forward + egress + изоляцию.
# Идемпотентен: каждый запуск полностью пересобирает свои цепочки/правила.
# .list, НЕ .conf — иначе dnsmasq (conf-dir=...,*.conf) упадёт «bad option».
SEG=/etc/awg-setup/filter/network-segments.list
WLOG=/var/log/awg-watchdog.log
BR=br-lan
MARK=0x1                 # тот же mark/таблица, что у per-device обхода (Ф3)
PREF=32763
MSEG_CHAIN=GW_NETSEG     # mangle PREROUTING: egress-метки по подсети
ISO_CHAIN=GW_NETISO      # filter FORWARD: изоляция/доступ + local-only (поз. 1)
FWD_CHAIN=GW_NETFWD      # filter FORWARD: ACCEPT трафика VLAN-интерфейсов (поз. 2)
_log(){ printf '%s gw-network: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

WAN=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)

# 8021q доступен? (адаптивный детект L2-возможности)
VLAN_CAP=0
if modprobe 8021q 2>/dev/null || lsmod 2>/dev/null | grep -q 8021q; then VLAN_CAP=1; fi

# ── пересобираем цепочки с нуля ──
iptables -t mangle -N "$MSEG_CHAIN" 2>/dev/null; iptables -t mangle -F "$MSEG_CHAIN"
iptables -t mangle -C PREROUTING -j "$MSEG_CHAIN" 2>/dev/null || iptables -t mangle -I PREROUTING 1 -j "$MSEG_CHAIN"
iptables -N "$ISO_CHAIN" 2>/dev/null; iptables -F "$ISO_CHAIN"
iptables -N "$FWD_CHAIN" 2>/dev/null; iptables -F "$FWD_CHAIN"
# порядок в FORWARD: сперва изоляция (дропы), потом accept VLAN-интерфейсов
iptables -C FORWARD -j "$FWD_CHAIN" 2>/dev/null || iptables -I FORWARD 1 -j "$FWD_CHAIN"
iptables -C FORWARD -j "$ISO_CHAIN" 2>/dev/null || iptables -I FORWARD 1 -j "$ISO_CHAIN"

# правило маршрутизации «mark 0x1 -> main (WAN)» (как в Ф3)
ip rule list 2>/dev/null | grep -q "fwmark $MARK lookup main" \
    || ip rule add fwmark $MARK lookup main pref $PREF 2>/dev/null

# Снимаем VLAN-субинтерфейсы, которых больше нет в конфиге.
want_vlans=""
[ -f "$SEG" ] && want_vlans=$(awk -F'|' 'NF>=9 && $9!=""{print $9}' "$SEG" | tr '\n' ' ')
for ifc in $(ls /sys/class/net/ 2>/dev/null | grep "^${BR}\."); do
    vid=${ifc#${BR}.}
    case " $want_vlans " in *" $vid "*) : ;; *) ip link del "$ifc" 2>/dev/null && _log "удалён старый VLAN-интерфейс $ifc" ;; esac
done

# ── ПРОХОД 1: интерфейсы, forward-accept, egress ──
n=0
if [ -f "$SEG" ]; then
    while IFS='|' read -r id name subnet gwip dstart dend lease egress vlan_id isolated rfrom; do
        case "$id" in ""|\#*) continue ;; esac
        [ -n "$subnet" ] || continue
        n=$((n+1))

        if [ -n "$vlan_id" ] && [ "$VLAN_CAP" = "1" ]; then
            ifname="${BR}.${vlan_id}"
            ip link show "$ifname" >/dev/null 2>&1 \
                || ip link add link "$BR" name "$ifname" type vlan id "$vlan_id" 2>/dev/null
            ip link set "$ifname" up 2>/dev/null
            if [ -n "$gwip" ] && ! ip -4 addr show "$ifname" 2>/dev/null | grep -q "$gwip"; then
                ip addr add "${gwip}/24" dev "$ifname" 2>/dev/null
            fi
            # КРИТИЧНО: трафик VLAN-интерфейса надо пропускать в FORWARD (как br-lan),
            # иначе клиенты VLAN без интернета/туннеля. NAT (MASQUERADE -o WAN/awg0)
            # уже глобальный и покрывает любую src-подсеть.
            iptables -A "$FWD_CHAIN" -i "$ifname" -j ACCEPT
            iptables -A "$FWD_CHAIN" -o "$ifname" -j ACCEPT
            _log "L2-сегмент $id: $ifname (vlan $vlan_id) $subnet"
        elif [ -n "$vlan_id" ]; then
            _log "WARN сегмент $id просит vlan $vlan_id, но 8021q недоступен — L3-режим"
        fi

        case "$egress" in
            internet) iptables -t mangle -A "$MSEG_CHAIN" -s "$subnet" -j MARK --set-mark $MARK ;;
            local)    [ -n "$WAN" ] && iptables -A "$ISO_CHAIN" -s "$subnet" -o "$WAN" -j DROP
                      iptables -A "$ISO_CHAIN" -s "$subnet" -o awg0 -j DROP ;;
            *) : ;;
        esac
    done < "$SEG"
fi

# ── ПРОХОД 2: межсегментный доступ (reachable_from) + исходящая изоляция ──
# Дропаем только НОВЫЕ соединения (NEW) — established-ответы проходят дальше к
# обычному «RELATED,ESTABLISHED ACCEPT» в FORWARD. Так доступ односторонний, но
# не рвёт уже разрешённые сессии.
if [ -f "$SEG" ]; then
    while IFS='|' read -r sid sname ssub sgw sds sde sl seg svlan siso srf; do
        case "$sid" in ""|\#*) continue ;; esac
        [ -n "$ssub" ] || continue
        # 2a. вход В сегмент S: кто НЕ в reachable_from — DROP NEW O->S
        if [ "$srf" != "all" ]; then
            while IFS='|' read -r oid o2 osub orest; do
                case "$oid" in ""|\#*) continue ;; esac
                [ "$oid" = "$sid" ] && continue
                [ -n "$osub" ] || continue
                allowed=0
                case "$srf" in
                    none|"") allowed=0 ;;
                    *) case ",$srf," in *",$oid,"*) allowed=1 ;; esac ;;
                esac
                [ "$allowed" = "1" ] || iptables -A "$ISO_CHAIN" -m conntrack --ctstate NEW -s "$osub" -d "$ssub" -j DROP
            done < "$SEG"
        fi
        # 2b. выход ИЗ сегмента S к другим сегментам: если S изолирован — DROP NEW S->O
        if [ "$siso" = "1" ]; then
            while IFS='|' read -r oid2 o3 osub2 orest2; do
                case "$oid2" in ""|\#*) continue ;; esac
                [ "$oid2" = "$sid" ] && continue
                [ -n "$osub2" ] || continue
                iptables -A "$ISO_CHAIN" -m conntrack --ctstate NEW -s "$ssub" -d "$osub2" -j DROP
            done < "$SEG"
        fi
    done < "$SEG"
fi

_log "применено сегментов: $n (VLAN_CAP=$VLAN_CAP)"
exit 0
