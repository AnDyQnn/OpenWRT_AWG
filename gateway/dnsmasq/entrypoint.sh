#!/bin/sh
# Ждём br-lan, потом стартуем dnsmasq
until ip link show br-lan >/dev/null 2>&1; do
    echo "Waiting for br-lan..."
    sleep 2
done
echo "br-lan found, starting dnsmasq"
exec dnsmasq --no-daemon --log-facility=- --conf-file=/etc/dnsmasq.conf
