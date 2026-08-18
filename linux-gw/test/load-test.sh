#!/bin/bash
# Тест: грузятся ли вшитые образы и поднимается ли compose.
# Имитирует первый старт на железе (docker load + compose up, БЕЗ сборки).
set -e
LOG() { echo ">>> $*"; }

LOG "Старт dockerd (vfs — overlay2 не работает вложенно в Docker Desktop)"
dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs \
        --iptables=false > /var/log/dockerd.log 2>&1 &
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { LOG "dockerd не поднялся"; cat /var/log/dockerd.log; exit 1; }
LOG "dockerd готов"

LOG "docker load из /input/images.tar"
docker load -i /input/images.tar
echo ""
LOG "docker images:"
docker images --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'

# Готовим окружение для compose
mkdir -p /etc/amnezia /etc/awg-setup /run/awg-setup /var/log
echo vpn > /etc/awg-setup/user-mode
echo eth0 > /run/awg-setup/wan-port
ip link add name br-lan type bridge 2>/dev/null || true
ip addr add 192.168.88.1/24 dev br-lan 2>/dev/null || true
ip link set br-lan up 2>/dev/null || true

LOG "docker compose up -d (БЕЗ --build)"
cd /opt/gateway
docker compose up -d
echo ""
sleep 5
LOG "docker ps — должны быть gw-awg, gw-dnsmasq, gw-webui:"
docker ps --format '  {{.Names}}  {{.Status}}'
echo ""
RUNNING=$(docker ps -q | wc -l)
LOG "Запущено контейнеров: $RUNNING из 3"
[ "$RUNNING" -eq 3 ] && LOG "✅ ВСЕ ТРИ ПОДНЯЛИСЬ — фикс работает" || { LOG "❌ не все поднялись"; docker compose logs --tail 10; }
