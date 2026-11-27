#!/bin/bash
# Загружает предсобранные образы контейнеров в Docker.
# Вызывается из gateway-compose.service ПЕРЕД 'docker compose up'.
#
# Логика:
#   1. Если образы уже загружены (gateway-awg/dnsmasq/webui) — выходим.
#   2. Если есть /opt/gateway/images.tar — docker load (быстро, без интернета).
#   3. Если tar нет — собираем из исходников (fallback, нужен интернет).

set -e
LOG() { echo "$(date '+%Y-%m-%d %H:%M:%S') gateway-load: $*" | tee -a /var/log/awg-watchdog.log; }

cd /opt/gateway

# КРИТИЧНО: ждём готовности Docker daemon (иначе load падает → fallback-сборка).
LOG "Жду готовности Docker daemon..."
for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
done
if ! docker info >/dev/null 2>&1; then
    LOG "ERR Docker daemon не готов за 120с"
    exit 1
fi
LOG "Docker готов (storage: $(docker info 2>/dev/null | awk -F': ' '/Storage Driver/{print $2}'))"

# Уже загружены?
if docker image inspect gateway-awg:latest >/dev/null 2>&1 \
   && docker image inspect gateway-dnsmasq:latest >/dev/null 2>&1 \
   && docker image inspect gateway-webui:latest >/dev/null 2>&1; then
    LOG "Образы уже загружены — пропускаем"
    exit 0
fi

# Предсобранный tar?
if [ -f /opt/gateway/images.tar ]; then
    LOG "Загружаю предсобранные образы из images.tar..."
    if docker load -i /opt/gateway/images.tar 2>&1 | tee -a /var/log/awg-watchdog.log; then
        LOG "OK Образы загружены (без сборки)"
        # Освобождаем место: tar больше не нужен (образы уже в Docker-хранилище).
        # Если Docker-хранилище когда-нибудь обнулится — сработает fallback-сборка.
        sz=$(du -m /opt/gateway/images.tar 2>/dev/null | cut -f1)
        rm -f /opt/gateway/images.tar && LOG "Очищен images.tar (освобождено ~${sz} МБ)"
        exit 0
    fi
    LOG "WARN docker load не удался — пробуем сборку"
fi

# Fallback: сборка из исходников (нужен интернет)
LOG "Предсобранных образов нет — собираю из исходников (нужен интернет, ~15 мин)..."
docker compose build 2>&1 | tee -a /var/log/awg-build.log
LOG "Сборка завершена"
