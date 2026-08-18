#!/bin/sh
# Хостовый фаервол на ВХОД (С2). Защищает САМ шлюз (цепочка INPUT):
#   - из LAN / сегментов / VPN-туннеля — полный доступ к сервисам шлюза;
#   - с WAN — глухо: новые соединения к шлюзу дропаются (панель, SSH, DHCP-сервер
#     и т.п. снаружи не видны), проходят только ОТВЕТЫ на исходящие самого шлюза
#     (VPN-туннель, DNS-резолв, обновления) + получение WAN-аренды (DHCP-клиент).
#
# ВАЖНО: трогаем ТОЛЬКО INPUT (трафик К шлюзу). Клиентский трафик идёт через
# FORWARD — его не касаемся, поэтому VPN/интернет/сеть клиентов НЕ задеваются.
# Идемпотентен: каждый запуск пересобирает свою цепочку. Политику INPUT оставляем
# ACCEPT (безопасно: режем только WAN явным правилом, другие интерфейсы не трогаем).
WAN=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)
CHAIN=GW_INPUT
ALLOW_MARK=/etc/awg-setup/.fw-allow-wan   # стенд: список TCP-портов оставить на WAN
WLOG=/var/log/awg-watchdog.log
_log(){ printf '%s gw-firewall: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

# Хардненинг ядра: анти-спуфинг (reverse-path), лог «марсиан», syn-cookies.
sysctl -qw net.ipv4.conf.all.rp_filter=1 2>/dev/null
sysctl -qw net.ipv4.tcp_syncookies=1 2>/dev/null
[ -n "$WAN" ] && {
    sysctl -qw "net.ipv4.conf.$WAN.rp_filter=1" 2>/dev/null
    sysctl -qw "net.ipv4.conf.$WAN.log_martians=1" 2>/dev/null
}

if [ -z "$WAN" ]; then
    _log "WAN не определён — фаервол вход не применяю (защищать не от чего)"
    exit 0
fi

iptables -N "$CHAIN" 2>/dev/null; iptables -F "$CHAIN"
iptables -A "$CHAIN" -i lo -j ACCEPT
# ответы на исходящие самого шлюза (VPN, DNS, NTP, обновления) — пропускаем
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A "$CHAIN" -m conntrack --ctstate INVALID -j DROP
# доверенные интерфейсы: LAN-мост, VLAN-сегменты, VPN-туннель — полный доступ
iptables -A "$CHAIN" -i br-lan -j ACCEPT
for ifc in $(ls /sys/class/net 2>/dev/null | grep '^br-lan\.'); do
    iptables -A "$CHAIN" -i "$ifc" -j ACCEPT
done
iptables -A "$CHAIN" -i awg0 -j ACCEPT
# WAN: получение/продление аренды самим шлюзом (DHCP-клиент) — нужно оставить
iptables -A "$CHAIN" -i "$WAN" -p udp --sport 67 --dport 68 -j ACCEPT
# тестовая щель (ТОЛЬКО при наличии маркера — на стенде, чтобы не закрыть доступ
# через NAT-проброс). На реальном шлюзе маркера нет → WAN закрыт полностью.
if [ -f "$ALLOW_MARK" ]; then
    for p in $(cat "$ALLOW_MARK" 2>/dev/null); do
        case "$p" in [0-9]*) iptables -A "$CHAIN" -i "$WAN" -p tcp --dport "$p" -j ACCEPT ;; esac
    done
fi
# всё остальное с WAN к шлюзу — дроп (с лимит-логом для статистики безопасности)
iptables -A "$CHAIN" -i "$WAN" -m limit --limit 5/min --limit-burst 10 -j LOG --log-prefix "GW_FW_WAN_DROP " --log-level 4
iptables -A "$CHAIN" -i "$WAN" -j DROP

# Вешаем цепочку в INPUT через APPEND (а не -I 1): fail2ban вставляет свои
# бан-правила в начало INPUT, и они должны проверяться ДО наших ACCEPT (иначе
# забаненный LAN/VPN-источник был бы принят раньше бана). Идемпотентно — при
# наличии не пересоздаём, чтобы не перепрыгнуть выше f2b на рефрешах.
iptables -C INPUT -j "$CHAIN" 2>/dev/null || iptables -A INPUT -j "$CHAIN"
_log "вход-фаервол применён (WAN=$WAN закрыт; LAN/сегменты/туннель открыты)"
exit 0
