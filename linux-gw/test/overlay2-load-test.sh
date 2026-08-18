#!/bin/bash
# Тест docker load + compose up на overlay2 (как на железе, не vfs).
# /var/lib/docker на ext4-loop, daemon.json как в образе.
set -e
LOG() { echo ">>> $*"; }

LOG "Готовлю ext4-loop под /var/lib/docker (overlay2 требует реальную ФС)"
mkdir -p /var/lib/docker
dd if=/dev/zero of=/docker.ext4 bs=1M count=2000 status=none
mkfs.ext4 -q -F /docker.ext4
mount -o loop /docker.ext4 /var/lib/docker
LOG "ext4 смонтирован на /var/lib/docker"

LOG "daemon.json (overlay2, containerd-snapshotter off):"
cat /etc/docker/daemon.json | sed 's/^/  /'

LOG "Старт dockerd с overlay2"
dockerd --host=unix:///var/run/docker.sock --iptables=false > /var/log/dockerd.log 2>&1 &
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { LOG "dockerd НЕ поднялся"; tail -20 /var/log/dockerd.log; exit 1; }
LOG "Storage driver: $(docker info 2>/dev/null | grep -i 'Storage Driver')"

LOG "docker load -i /input/images.tar"
docker load -i /input/images.tar 2>&1 | tail -6
echo ""
LOG "docker images:"
docker images --format '  {{.Repository}}:{{.Tag}} {{.Size}}'

mkdir -p /etc/amnezia /etc/awg-setup /run/awg-setup
echo vpn > /etc/awg-setup/user-mode; echo eth0 > /run/awg-setup/wan-port
ip link add name br-lan type bridge 2>/dev/null || true
ip addr add 192.168.88.1/24 dev br-lan 2>/dev/null || true; ip link set br-lan up 2>/dev/null || true

LOG "docker compose up -d (как на железе)"
cd /opt/gateway
cp /input/images.tar /opt/gateway/images.tar 2>/dev/null || true
docker compose up -d
sleep 6
echo ""
LOG "docker ps:"
docker ps --format '  {{.Names}} {{.Status}}'
RUNNING=$(docker ps -q | wc -l)
echo ""
[ "$RUNNING" -eq 3 ] && LOG "✅ overlay2: ВСЕ 3 контейнера Up — load работает на overlay2" \
                     || { LOG "❌ overlay2: только $RUNNING/3"; docker compose logs --tail 15 2>&1 | tail -20; }

umount /var/lib/docker 2>/dev/null || true
