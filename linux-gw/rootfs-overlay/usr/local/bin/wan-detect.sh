#!/bin/bash
# Определяет WAN-порт среди физических интерфейсов.
# Адаптировано для стандартного Linux (без UCI).

LOG="/var/log/awg-watchdog.log"
LAN_IP="192.168.88.1"
RUN_DIR="/run/awg-setup"
mkdir -p "$RUN_DIR"

_log() { printf '%s wan-detect: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

# Физические Ethernet-интерфейсы.
# Исключаем виртуальные по имени, требуем type=1 (ARPHRD_ETHER).
# На реальном железе у физ. NIC есть /device (PCI/USB) — это надёжнее всего,
# но фильтра по типу + имени достаточно и для железа, и для тестов.
get_ifaces() {
    for iface in $(ls /sys/class/net/ 2>/dev/null | sort); do
        case "$iface" in
            lo|br-*|awg*|sit*|tun*|tap*|wlan*|docker*|veth*|virbr*|dummy*|bond*|team*|gre*|ip6*) continue ;;
        esac
        # type 1 = Ethernet
        [ "$(cat /sys/class/net/$iface/type 2>/dev/null)" = "1" ] || continue
        echo "$iface"
    done
}

has_carrier() {
    [ "$(cat /sys/class/net/$1/carrier 2>/dev/null)" = "1" ]
}

probe_iface() {
    local iface="$1"
    ip link set "$iface" up 2>/dev/null || true
    sleep 1
    # Если IP уже есть (статический WAN / уже поднят) — используем его,
    # иначе запрашиваем DHCP.
    if ! ip addr show "$iface" | grep -q 'inet '; then
        # --noipv4ll: не назначать 169.254.x при отсутствии DHCP-сервера
        # (иначе link-local ломает маршрут по умолчанию)
        dhcpcd -1 -t 8 --noipv4ll "$iface" 2>/dev/null \
            || dhclient -1 -timeout 8 "$iface" 2>/dev/null || true
    fi
    ip addr show "$iface" | grep -q 'inet ' || return 1
    # Есть ли через этот порт выход в интернет? Проверяем ПО НЕСКОЛЬКИМ
    # адресам, включая российские — 8.8.8.8/1.1.1.1 у нас часто блокируют,
    # и тогда рабочий интернет ложно считается отсутствующим.
    for t in 8.8.8.8 1.1.1.1 77.88.8.8 77.88.8.1 213.180.193.1 87.250.250.242; do
        ping -c1 -W2 -I "$iface" "$t" >/dev/null 2>&1 && return 0
    done
    # ICMP мог быть заблокирован — пробуем TCP (порты 80/443) через curl.
    for u in https://ya.ru https://mail.ru https://dns.yandex.ru http://77.88.8.8; do
        curl -s -m 5 --interface "$iface" -o /dev/null "$u" 2>/dev/null && return 0
    done
    return 1
}

cleanup_iface() {
    ip addr flush dev "$1" 2>/dev/null || true
    ip route flush dev "$1" 2>/dev/null || true
    dhcpcd --release "$1" 2>/dev/null || dhclient -r "$1" 2>/dev/null || true
}

apply_config() {
    local wan="$1"; shift
    local lan_devs="$*"
    _log "Applying: WAN=$wan  LAN=$lan_devs  LAN-IP=$LAN_IP"

    # Сохраняем конфигурацию
    echo "$wan"       > "$RUN_DIR/wan-port"
    echo "$lan_devs"  > "$RUN_DIR/lan-ports"
    echo "$wan"       > /etc/awg-setup/wan-port   # персистентно

    # WAN: поднимаем и ГАРАНТИРУЕМ дефолт-маршрут + шлюз.
    # Критично: бывает, что IP получен, а дефолт-маршрут потерян — тогда нет
    # интернета И awg-up не может исключить endpoint из туннеля -> петля
    # (трафик к VPN-серверу уходит в сам туннель). Поэтому если маршрута нет —
    # перезапрашиваем DHCP, пока шлюз не появится.
    ip link set "$wan" up 2>/dev/null || true
    WAN_GW=$(ip route show default dev "$wan" 2>/dev/null | awk '/default/{print $3; exit}')
    if [ -z "$WAN_GW" ] || ! ip addr show "$wan" | grep -q 'inet '; then
        _log "WAN $wan без шлюза/адреса — (пере)запрашиваю DHCP"
        dhcpcd -1 -t 10 --noipv4ll "$wan" 2>/dev/null || dhclient "$wan" 2>/dev/null || true
        sleep 2
        WAN_GW=$(ip route show default dev "$wan" 2>/dev/null | awk '/default/{print $3; exit}')
    fi
    # резерв: любой via-шлюз на этом устройстве
    [ -z "$WAN_GW" ] && WAN_GW=$(ip route show dev "$wan" 2>/dev/null | awk '/^default via/{print $3; exit}')

    if [ -n "$WAN_GW" ]; then
        echo "$WAN_GW" > "$RUN_DIR/wan-gw"
        echo "$WAN_GW" > /etc/awg-setup/wan-gw
        _log "WAN-шлюз: $WAN_GW"
    else
        _log "WARN: не удалось определить WAN-шлюз для $wan (endpoint-исключение может не сработать)"
    fi

    # LAN: bridge br-lan
    ip link add name br-lan type bridge 2>/dev/null || true
    for dev in $lan_devs; do
        [ -n "$dev" ] || continue
        ip link set "$dev" up 2>/dev/null || true
        ip link set "$dev" master br-lan 2>/dev/null || true
    done
    ip link set br-lan up 2>/dev/null || true
    ip addr flush dev br-lan 2>/dev/null || true
    ip addr add "${LAN_IP}/24" dev br-lan 2>/dev/null || true

    # IP форвардинг
    echo 1 > /proc/sys/net/ipv4/ip_forward

    # NAT masquerade
    iptables -t nat -F POSTROUTING 2>/dev/null || true
    iptables -t nat -A POSTROUTING -o "$wan" -j MASQUERADE
    iptables -F FORWARD 2>/dev/null || true
    iptables -A FORWARD -i br-lan -j ACCEPT
    iptables -A FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT

    # Принудительно гоним ВЕСЬ клиентский DNS (порт 53) через наш dnsmasq —
    # чтобы фильтр доступа/блокировка работали, даже если клиент вручную
    # прописал 8.8.8.8. (DoH-перехват — отдельная история, вне v1.)
    for proto in udp tcp; do
        iptables -t nat -A PREROUTING -i br-lan -p "$proto" --dport 53 \
            ! -d "$LAN_IP" -j DNAT --to-destination "$LAN_IP" 2>/dev/null || true
    done

    # Перезапускаем dnsmasq с правильным интерфейсом
    sed -i "s/^interface=.*/interface=br-lan/" /etc/dnsmasq.d/10-gateway.conf 2>/dev/null || true
    systemctl restart dnsmasq 2>/dev/null || true

    # Перезапускаем nginx/fcgiwrap
    systemctl restart nginx fcgiwrap 2>/dev/null || true

    # Хостовый фаервол на вход (С2): закрыть шлюз со стороны WAN. Вызываем после
    # того, как WAN определён и NAT настроен. Идемпотентно.
    /usr/local/bin/gw-firewall.sh 2>/dev/null || true
}

main() {
    local ifaces
    ifaces=$(get_ifaces)
    _log "Scanning: $ifaces"

    # Шаг 1: поднимаем ВСЕ интерфейсы заранее, чтобы линк успел согласоваться.
    # Иначе onboard-сетевую, которая на старте ещё "down", можно ошибочно
    # счесть пустой. Пустые PCI-сетевые (без кабеля) останутся без carrier.
    for iface in $ifaces; do
        ip link set "$iface" up 2>/dev/null || true
    done

    # Шаг 2: ждём согласования линка (до ~6с), но выходим раньше,
    # как только появился хотя бы один порт с carrier.
    local s
    for s in 1 2 3 4 5 6; do
        for iface in $ifaces; do
            has_carrier "$iface" && break 2
        done
        sleep 1
    done

    # Шаг 3: WAN = первый порт С КАБЕЛЕМ, через который реально есть интернет.
    # Пустые PCI-сетевые (без carrier) не пробуем — не тратим время.
    local wan=""
    for iface in $ifaces; do
        has_carrier "$iface" || { _log "  $iface — нет линка, пропуск"; continue; }
        _log "  $iface — есть линк, проверяю интернет..."
        if probe_iface "$iface"; then
            _log "  $iface → WAN (есть интернет)"
            wan="$iface"; break
        fi
        _log "  $iface — интернета нет, в LAN"
    done

    # Fallback: интернет не нашли — WAN'ом берём первый порт С КАБЕЛЕМ
    # (а не пустой PCI), иначе вообще первый.
    if [ -z "$wan" ]; then
        _log "WARN: интернет не найден ни на одном порту, fallback"
        for iface in $ifaces; do has_carrier "$iface" && { wan="$iface"; break; }; done
        [ -z "$wan" ] && wan=$(echo "$ifaces" | awk '{print $1}')
        [ -z "$wan" ] && wan="eth0"
    fi

    # Шаг 4: LAN = ВСЕ остальные физические порты (включая сейчас пустые PCI).
    # Так клиента можно воткнуть в любой свободный порт в любой момент —
    # порт уже в мосту, заработает сразу как появится линк.
    local lan_list=""
    for iface in $ifaces; do
        [ "$iface" = "$wan" ] && continue
        lan_list="$lan_list $iface"
        cleanup_iface "$iface"   # снять link-local/мусор перед мостом
    done

    _log "Итог: WAN=$wan  LAN=$lan_list"
    apply_config "$wan" $lan_list
}

main
