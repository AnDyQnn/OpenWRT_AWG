# Приветствие консоли шлюза (заменяет стандартный Debian MOTD).
# Печатается при интерактивном входе: баннер + быстрые команды + сводка статуса.
case "$-" in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
[ -n "$GW_NO_WELCOME" ] && { return 0 2>/dev/null || exit 0; }

printf '\n'
printf '  \033[1;35m╔════════════════════════════════════════════════╗\033[0m\n'
printf '  \033[1;35m║\033[0m   \033[1;36m▚ GATEWAY HUB\033[0m  ·  консоль шлюза              \033[1;35m║\033[0m\n'
printf '  \033[1;35m╚════════════════════════════════════════════════╝\033[0m\n'
printf '\n'
printf '  \033[1;32mБыстрые команды:\033[0m\n'
printf '    \033[36mgateway-status\033[0m     — статус: система, VPN, контейнеры, аренды\n'
printf '    \033[36mgateway-vpn-debug\033[0m  — диагностика VPN-туннеля\n'
printf '    \033[36mdocker ps\033[0m          — контейнеры (gw-awg / gw-dnsmasq / gw-webui)\n'
printf '    \033[36mip -br a\033[0m           — интерфейсы и адреса\n'
printf '    \033[36mtail -f /var/log/awg-watchdog.log\033[0m — журнал failover/VPN\n'
printf '\n'

# Краткая сводка статуса (если команда доступна на хосте)
if command -v gateway-status >/dev/null 2>&1; then
    printf '  \033[1;32mТекущий статус:\033[0m\n'
    gateway-status 2>/dev/null | sed 's/^/  /'
    printf '\n'
fi
