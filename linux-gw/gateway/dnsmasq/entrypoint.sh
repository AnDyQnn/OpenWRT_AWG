#!/bin/sh
# Ждём br-lan, потом стартуем dnsmasq
until ip link show br-lan >/dev/null 2>&1; do
    echo "Waiting for br-lan..."
    sleep 2
done

CONF=/etc/dnsmasq.conf
# Срок аренды DHCP основной сети задаётся в панели (Сеть → Подключённые
# устройства): плоский файл filter/dhcp-lease.txt (НЕ .conf — conf-dir читает
# только *.conf, а это не опция dnsmasq). Формат dnsmasq: <число>m|h|d|w.
# Подставляем его в dhcp-range копии конфига; кривое значение — игнорируем.
LEASE=$(tr -d ' \r\n' < /etc/dnsmasq.d/filter/dhcp-lease.txt 2>/dev/null)
case "$LEASE" in
    [0-9]*[mhdw])
        num=${LEASE%?}
        case "$num" in *[!0-9]*) LEASE="" ;; esac
        ;;
    *) LEASE="" ;;
esac
if [ -n "$LEASE" ]; then
    sed "s/^\(dhcp-range=[^,]*,[^,]*,\).*/\1$LEASE/" "$CONF" > /tmp/dnsmasq.conf && CONF=/tmp/dnsmasq.conf
    echo "DHCP lease time: $LEASE"
fi
echo "br-lan found, starting dnsmasq"
exec dnsmasq --no-daemon --log-facility=- --conf-file="$CONF"
