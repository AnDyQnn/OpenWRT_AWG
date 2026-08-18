#!/bin/bash
# VPN tunnel diagnostics. Run on the gateway, send a photo of the output.
echo "===== GATEWAY VPN DEBUG ====="
echo "date: $(date)"
echo ""

echo "--- WAN / LAN ---"
WAN=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)
echo "WAN port: $WAN   IP: $(ip -4 -o addr show "$WAN" 2>/dev/null | awk '{print $4}')"
echo "br-lan IP: $(ip -4 -o addr show br-lan 2>/dev/null | awk '{print $4}')"
echo "default route: $(ip route | grep '^default')"
echo ""

echo "--- Internet from gateway (WAN) ---"
ping -c2 -W3 8.8.8.8 >/dev/null 2>&1 && echo "  8.8.8.8: OK" || echo "  8.8.8.8: FAIL"
echo ""

echo "--- Config endpoint ---"
CONF=/etc/amnezia/awg0.conf
EP=$(grep -E '^Endpoint' "$CONF" 2>/dev/null | awk -F'[=]+' '{gsub(/ /,"",$2);print $2}')
EP_HOST=$(echo "$EP" | cut -d: -f1)
EP_PORT=$(echo "$EP" | cut -d: -f2)
echo "Endpoint: $EP   (host=$EP_HOST port=$EP_PORT)"
EP_IP=$(getent hosts "$EP_HOST" 2>/dev/null | awk '{print $1}' | head -1)
[ -z "$EP_IP" ] && EP_IP="$EP_HOST"
echo "Resolved IP: $EP_IP"
echo "Route to endpoint: $(ip route get "$EP_IP" 2>/dev/null | head -1)"
echo "Ping endpoint: $(ping -c2 -W3 "$EP_IP" >/dev/null 2>&1 && echo OK || echo FAIL/blocked)"
echo ""

echo "--- Path MTU to endpoint (DF, no fragment) ---"
echo "  WAN MTU: $(cat /sys/class/net/$WAN/mtu 2>/dev/null)   awg0 MTU: $(cat /sys/class/net/awg0/mtu 2>/dev/null)"
for sz in 1200 1300 1380 1420 1460; do
    if ping -c1 -W2 -M do -s "$sz" "$EP_IP" >/dev/null 2>&1; then
        echo "  size $sz (+28=$(($sz+28))B): OK"
    else
        echo "  size $sz (+28=$(($sz+28))B): DROP (path MTU below $(($sz+28)))"
    fi
done
echo ""

echo "--- awg0 interface ---"
ip -br addr show awg0 2>/dev/null || echo "  awg0 NOT present"
echo ""

echo "--- awg show (handshake/transfer) ---"
docker exec gw-awg awg show awg0 2>/dev/null || awg show awg0 2>/dev/null || echo "  awg show failed"
echo ""

echo "--- policy routing (fwmark table) ---"
ip rule 2>/dev/null | grep -iE 'fwmark|51820' | sed 's/^/  /'
echo "  table 51820 default: $(ip route show table 51820 2>/dev/null | grep default)"
echo ""

echo "--- nat / firewall ---"
iptables -t nat -S POSTROUTING 2>/dev/null | grep -iE 'MASQUERADE' | sed 's/^/  /'
echo ""

echo "--- containers ---"
docker ps --format '  {{.Names}} {{.Status}}' 2>/dev/null
echo ""
echo "--- mode ---"
echo "  runtime: $(cat /run/awg-mode 2>/dev/null)   user: $(cat /etc/awg-setup/user-mode 2>/dev/null)"
echo "===== END ====="
