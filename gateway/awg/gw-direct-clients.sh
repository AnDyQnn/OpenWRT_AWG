#!/bin/sh
# Политика по устройству (расширённая Ф3). Для каждого MAC задаётся ВЫХОД и ИЗОЛЯЦИЯ:
#   egress=vpn      — трафик идёт в VPN-туннель (по умолчанию);
#   egress=internet — напрямую мимо VPN (метка -> таблица main, WAN);
#   egress=local    — только локальная сеть: выход в интернет И в туннель закрыт;
#   isolated=1      — устройство не видит другие устройства локалки (но шлюз/DHCP/DNS
#                     и свой выход в интернет/VPN работают).
# Источник — плоский файл /etc/awg-setup/filter/device-policy.txt: строки
#   MAC|egress|isolated  (генерит webui из rules.json). Совместимость: если его нет,
# берём старый direct-clients.txt (там MAC = egress internet). Идемпотентен.
POL=/etc/awg-setup/filter/device-policy.txt
OLD=/etc/awg-setup/filter/direct-clients.txt
WLOG=/var/log/awg-watchdog.log
MARK=0x1
PREF=32763                 # < 32765 (туннельное правило) → метка побеждает туннель
MCHAIN=GW_DIRECT           # mangle PREROUTING: метки egress=internet
FCHAIN=GW_DEVPOL           # filter FORWARD: local-блок + изоляция
_log() { printf '%s gw-direct: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG" 2>/dev/null || true; }

command -v iptables >/dev/null 2>&1 || { _log "ERR нет iptables"; exit 1; }

WAN=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)
LAN_NET=$(ip -4 route show dev br-lan 2>/dev/null | grep -oE '^[0-9.]+/[0-9]+' | head -1)

# ip rule (идемпотентно): маркированное → main (WAN), раньше туннельного правила.
ip rule list 2>/dev/null | grep -q "fwmark $MARK lookup main" \
    || ip rule add fwmark $MARK lookup main pref $PREF 2>/dev/null

# Пересобираем цепочки с нуля.
iptables -t mangle -N "$MCHAIN" 2>/dev/null; iptables -t mangle -F "$MCHAIN" 2>/dev/null
iptables -t mangle -C PREROUTING -j "$MCHAIN" 2>/dev/null || iptables -t mangle -I PREROUTING 1 -j "$MCHAIN" 2>/dev/null
iptables -N "$FCHAIN" 2>/dev/null; iptables -F "$FCHAIN" 2>/dev/null
iptables -C FORWARD -j "$FCHAIN" 2>/dev/null || iptables -I FORWARD 1 -j "$FCHAIN" 2>/dev/null

_valid_mac() { case "$1" in [0-9A-Fa-f][0-9A-Fa-f]:*:*:*:*:*) return 0 ;; *) return 1 ;; esac; }

n=0; marked=0
if [ -f "$POL" ]; then
    while IFS='|' read -r mac egress isolated; do
        mac=$(printf '%s' "$mac" | tr -d ' \t\r')
        case "$mac" in ""|\#*) continue ;; esac
        _valid_mac "$mac" || continue
        n=$((n+1))
        case "$egress" in
            internet)
                iptables -t mangle -A "$MCHAIN" -m mac --mac-source "$mac" -j MARK --set-mark $MARK 2>/dev/null
                marked=$((marked+1)) ;;
            local)
                [ -n "$WAN" ] && iptables -A "$FCHAIN" -m mac --mac-source "$mac" -o "$WAN" -j DROP 2>/dev/null
                iptables -A "$FCHAIN" -m mac --mac-source "$mac" -o awg0 -j DROP 2>/dev/null ;;
            *) : ;;   # vpn — по умолчанию в туннель
        esac
        # изоляция: устройство не форвардит к другим в локалке (шлюз/INPUT не задет).
        if [ "$isolated" = "1" ] && [ -n "$LAN_NET" ]; then
            iptables -A "$FCHAIN" -m mac --mac-source "$mac" -d "$LAN_NET" -j DROP 2>/dev/null
        fi
    done < "$POL"
elif [ -f "$OLD" ]; then
    # старый формат (только «мимо VPN»): каждая MAC = egress internet
    while IFS= read -r mac; do
        mac=$(printf '%s' "$mac" | tr -d ' \t\r'); _valid_mac "$mac" || continue
        iptables -t mangle -A "$MCHAIN" -m mac --mac-source "$mac" -j MARK --set-mark $MARK 2>/dev/null
        n=$((n+1)); marked=$((marked+1))
    done < "$OLD"
fi

# Никто не метится в main → снять ip rule (не держим лишнее).
[ "$marked" -eq 0 ] && ip rule del fwmark $MARK lookup main pref $PREF 2>/dev/null

_log "OK gw-direct: устройств с политикой = $n (мимо VPN: $marked)"
exit 0
