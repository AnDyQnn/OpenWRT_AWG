#!/bin/sh
CONF="/config/awg0.conf"
WLOG="/var/log/awg-watchdog.log"
_log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; echo "$*"; }

modprobe tun 2>/dev/null || true
export WG_QUICK_USERSPACE_IMPLEMENTATION=amneziawg-go

# resolvconf не работает без init system в контейнере — заглушка
cat > /usr/local/bin/resolvconf << 'RESOLVEOF'
#!/bin/sh
exit 0
RESOLVEOF
chmod +x /usr/local/bin/resolvconf

USER_MODE=$(cat /etc/awg-setup/user-mode 2>/dev/null || echo "vpn")
if [ "$USER_MODE" = "off" ]; then
    _log "INFO AWG: user mode=off, not starting tunnel"
    printf 'manual_off\n' > /run/awg-mode
    exec sleep infinity
fi

if [ ! -f "$CONF" ]; then
    _log "INFO AWG: no config yet. Upload at http://192.168.88.1/awg/"
    printf 'no_config\n' > /run/awg-mode
    # Ждём появления конфига
    while [ ! -f "$CONF" ]; do sleep 5; done
    _log "INFO AWG: config appeared, starting tunnel"
fi

_log "INFO AWG: starting tunnel"
# awg-up = awg-quick up + ВСЕГДА исключить endpoint из туннеля (любой AllowedIPs)
awg-up "$CONF"

# Ждём хэндшейк до ~15с
HS=0
for i in 1 2 3 4 5 6 7; do
    HS=$(awg show awg0 latest-handshakes 2>/dev/null | awk '{print $2; exit}')
    [ -n "$HS" ] && [ "$HS" -gt 0 ] 2>/dev/null && break
    sleep 2
done

if ip link show awg0 >/dev/null 2>&1; then
    if [ -n "$HS" ] && [ "$HS" -gt 0 ] 2>/dev/null; then
        _log "OK AWG: tunnel up, handshake OK"
    else
        _log "WARN AWG: tunnel up, хэндшейка пока нет (gateway-vpn-debug для диагностики)"
    fi
    printf 'vpn\n' > /run/awg-mode
else
    _log "ERR AWG: tunnel failed to come up (см. /var/log/awg-quick.log)"
    printf 'fallback\n' > /run/awg-mode
fi

# Ф4: поднять сегменты сети (VLAN-интерфейсы + egress + изоляция). Интерфейсы не
# переживают перезагрузку — пересоздаём при старте. Без сегментов (только default)
# это быстрый no-op. Идемпотентно.
gw-network-apply 2>/dev/null || true

# Политики панели применяем СРАЗУ при старте, не дожидаясь первого тика watchdog
# (awg-watchdog.timer: OnBootSec=2min). Иначе после перезагрузки настройки из
# /etc/awg-setup/filter (device-policy: egress/изоляция; блокировки/группы -> ipset;
# egress-маршруты) до ~2 минут НЕ действуют — выглядит как «настройки отвалились»,
# плюс окно без изоляции недоверенных устройств. Идемпотентно.
gw-access-apply 2>/dev/null || true
gw-direct-clients 2>/dev/null || true
gw-access-routes 2>/dev/null || true
# Маршруты «напрямую» (split-tunnel исключения) требуют WAN-шлюз, который пишет
# сервис wan-detect — на старте awg-контейнера его может ещё не быть, тогда первый
# вызов gw-access-routes выше — no-op. Фоновый ретрай ждёт появления WAN-шлюза
# (до ~45с) и применяет исключения СРАЗУ как только поднимется WAN, не дожидаясь
# тика watchdog. Иначе после ребута до ~минуты трафик к «исключённым» ресурсам
# идёт через VPN вместо «напрямую».
(
    i=0
    while [ ! -s /run/awg-setup/wan-gw ] && [ "$i" -lt 15 ]; do sleep 3; i=$((i+1)); done
    gw-access-routes 2>/dev/null || true
    gw-access-apply 2>/dev/null || true
    gw-direct-clients 2>/dev/null || true
) &

exec sleep infinity
