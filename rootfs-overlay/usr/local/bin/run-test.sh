#!/bin/bash
# Запуск gateway в тестовом режиме (Docker-in-Docker).
# Поднимает Docker daemon, настраивает сеть, запускает docker-compose.

set -e
LOG() { echo "$(date '+%H:%M:%S') [gateway] $*"; }

LOG "=== Gateway Linux (test mode, DinD) ==="

# TUN + IP forwarding
modprobe tun 2>/dev/null || true
echo 1 > /proc/sys/net/ipv4/ip_forward

mkdir -p /etc/awg-setup /etc/amnezia /run/awg-setup /run/awg-stats /var/log

# Запускаем Docker daemon
LOG "Starting Docker daemon..."
dockerd --host=unix:///var/run/docker.sock \
        --storage-driver=vfs \
        --iptables=false \
        > /var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!

# Ждём Docker
for i in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
done
docker info >/dev/null 2>&1 || { LOG "ERR: Docker daemon failed to start"; cat /var/log/dockerd.log; exit 1; }
LOG "Docker daemon ready"

# Настраиваем сеть (WAN и LAN из env или авто)
WAN="${WAN_IFACE:-eth0}"
LAN="${LAN_IFACE:-eth1}"
LOG "WAN=$WAN  LAN=$LAN"

echo "$WAN" > /run/awg-setup/wan-port
echo "$LAN"  > /run/awg-setup/lan-ports
echo "$WAN"  > /etc/awg-setup/wan-port

# LAN bridge
ip link add name br-lan type bridge 2>/dev/null || true
ip link set "$LAN" master br-lan 2>/dev/null || ip link set br-lan up
ip link set br-lan up
ip addr flush dev br-lan 2>/dev/null || true
ip addr add 192.168.88.1/24 dev br-lan 2>/dev/null || true

# NAT
iptables -t nat -F POSTROUTING 2>/dev/null || true
iptables -t nat -A POSTROUTING -o "$WAN" -j MASQUERADE
iptables -F FORWARD 2>/dev/null || true
iptables -A FORWARD -i br-lan -j ACCEPT
iptables -A FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT

# Дефолтный user-mode
[ -f /etc/awg-setup/user-mode ] || echo 'vpn' > /etc/awg-setup/user-mode

# Запускаем сервисы через docker-compose
LOG "Starting gateway services via docker-compose..."
cd /opt/gateway
docker compose up -d --build 2>&1 | while IFS= read -r line; do LOG "$line"; done

LOG "=== Gateway ready! ==="
LOG "Web UI:  http://192.168.88.1/awg/"
LOG "SSH:     root@192.168.88.1  (password: openwrt)"
LOG "Status:  gateway-status"

# Держим живым, показываем логи
wait $DOCKERD_PID
