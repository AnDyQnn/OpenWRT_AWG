#!/bin/sh
# Устойчивость WAN к коротким «морганиям» кабеля (dhcpcd).
#
# Что было (шлюз отца, 2026-11-27: 16 морганий линка по ~2 с за рабочий день):
#   * на потере carrier dhcpcd сразу удалял маршруты WAN (default и подсеть);
#   * а IPv4LL (169.254.x на LAN-порту моста) подставлял default route ЧЕРЕЗ
#     LAN-ПОРТ — трафик всего офиса уходил в никуда;
#   * после возврата линка — ARP-проба адреса и rebind аренды, ещё ~6 с.
#   Итог: каждое 2-секундное моргание = ~8 с без интернета у всех.
#
# Что делаем (управляемый блок в /etc/dhcpcd.conf):
#   noipv4ll           — никаких 169.254 и ложных маршрутов через порты моста;
#   interface <WAN>
#     nolink           — не реагировать на кратковременную потерю carrier: адрес
#                        и маршруты остаются, после возврата линка трафик идёт
#                        сразу (TCP и VPN-туннель переживают паузу). Аренда при
#                        этом продлевается как обычно; реальную смену сети
#                        (кабель в другой роутер) по-прежнему ловит wan-detect
#                        при загрузке.
# Идемпотентно. Без аргументов — WAN берётся из /run/awg-setup/wan-port.
# --apply-live — дополнительно применить к работающему dhcpcd (rebind WAN без
# сброса адреса) и убрать уже выданные 169.254 с портов моста.

CONF=/etc/dhcpcd.conf
WAN="${1:-}"
[ "$WAN" = "--apply-live" ] && WAN=""
[ -n "$WAN" ] || WAN=$(cat /run/awg-setup/wan-port 2>/dev/null || cat /etc/awg-setup/wan-port 2>/dev/null)
LIVE=0; for a in "$@"; do [ "$a" = "--apply-live" ] && LIVE=1; done
WLOG=/var/log/awg-watchdog.log
_log(){ printf '%s gateway-dhcpcd-tune: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$WLOG"; }

[ -f "$CONF" ] || exit 0
case "$WAN" in ""|*[!A-Za-z0-9._-]*) _log "WAN не определён — пропуск"; exit 0 ;; esac

BEGIN="# >>> gateway-managed (gateway-dhcpcd-tune.sh) — не править руками"
END="# <<< gateway-managed"
block=$(printf '%s\nnoipv4ll\ninterface %s\n    nolink\n%s\n' "$BEGIN" "$WAN" "$END")

cur=$(sed -n "/^# >>> gateway-managed/,/^# <<< gateway-managed/p" "$CONF")
if [ "$cur" != "$block" ]; then
    tmp="$CONF.tmp.$$"
    # убрать старый блок (если был) и дописать актуальный В КОНЕЦ: блок
    # «interface …» действует до конца файла, поэтому он обязан быть последним.
    if ! { sed "/^# >>> gateway-managed/,/^# <<< gateway-managed/d" "$CONF" > "$tmp" \
           && printf '%s\n' "$block" >> "$tmp" && mv -f "$tmp" "$CONF"; }; then
        rm -f "$tmp"; _log "ERR не удалось записать $CONF"; exit 1
    fi
    changed=1
    _log "dhcpcd: noipv4ll + nolink на $WAN (моргание кабеля больше не рвёт интернет)"
else
    changed=0
fi

if [ "$LIVE" = 1 ]; then
    # Работающий демон глобальные/интерфейсные опции (noipv4ll, nolink) берёт
    # только при старте: `dhcpcd -n` их не применяет (проверено на стенде).
    # В /etc/dhcpcd.conf стоит `persistent` — при перезапуске адреса и маршруты
    # НЕ снимаются (стенд: 0% потерь пинга во время рестарта).
    if [ "$changed" = 1 ] && systemctl is-active -q dhcpcd 2>/dev/null; then
        grep -q '^persistent' "$CONF" && systemctl restart dhcpcd 2>/dev/null \
            && _log "dhcpcd перезапущен с новым конфигом (адреса сохранены — persistent)"
    fi
    # 169.254 на портах моста — артефакт IPv4LL, на работу LAN не влияет (адрес
    # шлюза в LAN живёт на br-lan). Снимаем ПОСЛЕ рестарта, чтобы не вернулся.
    for p in /sys/class/net/br-lan/brif/*; do
        [ -e "$p" ] || continue; p=${p##*/}
        for a in $(ip -4 -o addr show dev "$p" 2>/dev/null | awk '$4 ~ /^169\.254\./{print $4}'); do
            ip addr del "$a" dev "$p" 2>/dev/null && _log "снят IPv4LL $a с порта моста $p"
        done
    done
fi
exit 0
