#!/bin/bash
# Первичная инициализация при первом старте.
# Запускается через gateway-init.service (OneShot).
set -e

LOG() { echo "$(date '+%Y-%m-%d %H:%M:%S') gateway-init: $*" | tee -a /var/log/awg-watchdog.log; }

LOG "=== Gateway Linux init start ==="

# Директории
mkdir -p /etc/awg-setup /etc/amnezia /run/awg-stats /var/log

# Лог неудачных входов в панель (его читает fail2ban). Должен существовать до старта.
[ -f /var/log/panel-auth.log ] || : > /var/log/panel-auth.log

# SSH-порт этой установки (состояние, не код). На свежей машине генерится
# случайный, на обновлённой — переносится из старого 10-gateway.conf.
if [ -x /usr/local/bin/gateway-ssh-port.sh ]; then
    LOG "SSH-порт: $(/usr/local/bin/gateway-ssh-port.sh ensure)"
fi

# Включаем IP-форвардинг
echo 1 > /proc/sys/net/ipv4/ip_forward
grep -q 'net.ipv4.ip_forward' /etc/sysctl.conf \
    || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf

# Загружаем TUN модуль (нужен для amneziawg-go)
modprobe tun 2>/dev/null || true

# Дефолтный user-mode: vpn
[ -f /etc/awg-setup/user-mode ] || echo 'vpn' > /etc/awg-setup/user-mode

# Развёрнутая версия (состояние, переживает ресинк кода). Сеем из вшитого образа.
if [ ! -f /etc/awg-setup/.version ] && [ -f /opt/gateway/VERSION ]; then
    tr -d ' \t\r\n' < /opt/gateway/VERSION > /etc/awg-setup/.version
    LOG "версия развёртывания: $(cat /etc/awg-setup/.version)"
fi

# Дефолтные настройки обновлений (§10): безопасный режим manual.
if [ ! -f /etc/awg-setup/update-config.json ]; then
    cat > /etc/awg-setup/update-config.json <<'EOF'
{"mode":"manual","scheduled_time":"04:30","auto_level":"all","channel":"upd-code","keep_backups":3}
EOF
    LOG "создан update-config.json (режим manual)"
fi

# Запускаем определение WAN-порта
LOG "Starting WAN detection..."
/usr/local/bin/wan-detect.sh && LOG "WAN: $(cat /run/awg-setup/wan-port 2>/dev/null)" \
    || LOG "WARN: WAN detection failed, using fallback"

# Убеждаемся что дефолтный nginx site выключен
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

LOG "=== Gateway init complete. Web: http://192.168.88.1/awg/ ==="
