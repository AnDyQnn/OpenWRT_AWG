#!/bin/bash
# Печатает на консоль баннер готовности, когда контейнеры подняты.
# Так пользователь видит, что система стартовала (а не просто "ждём").

CON=/dev/console

# Ждём до ~90с пока поднимутся все 3 контейнера
for i in $(seq 1 45); do
    UP=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -cE 'gw-awg|gw-dnsmasq|gw-webui')
    [ "$UP" -ge 3 ] && break
    sleep 2
done

LAN_IP=$(ip -4 -o addr show br-lan 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
[ -z "$LAN_IP" ] && LAN_IP="192.168.88.1"
WAN=$(cat /run/awg-setup/wan-port 2>/dev/null)

G=$'\033[1;32m'; C=$'\033[0;36m'; B=$'\033[1m'; N=$'\033[0m'
{
  echo ""
  echo "${G}${B}  ============================================================${N}"
  echo "${G}${B}   ✓  GATEWAY ГОТОВ К РАБОТЕ  /  GATEWAY READY${N}"
  echo "${G}${B}  ============================================================${N}"
  echo "   Веб-панель : ${C}https://${LAN_IP}${N}   (admin / admin)"
  echo "   SSH        : root@${LAN_IP}   (пароль: openwrt)"
  echo "   Статус     : gateway-status"
  [ -n "$WAN" ] && echo "   WAN-порт   : ${WAN}"
  echo "   Контейнеры : $(docker ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
  echo "  ============================================================"
  echo ""
} > "$CON" 2>/dev/null

# дублируем в журнал
echo "$(date '+%Y-%m-%d %H:%M:%S') OK Gateway ready — panel https://${LAN_IP}" >> /var/log/awg-watchdog.log
