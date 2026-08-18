# Linux Gateway — хост-образ (Debian 12 minimal + Docker)
#
# Что устанавливается здесь: ОС + Docker + сетевые утилиты.
# Что НЕ устанавливается: nginx, dnsmasq, amneziawg — всё это в Docker-контейнерах.
# При первом старте docker-compose собирает сервисы (нужен интернет ~10 мин).

FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive

# Включаем non-free-firmware репозиторий (нужен для блобов сетевых карт).
# Базовый debian:bookworm несёт источники в новом формате deb822
# (/etc/apt/sources.list.d/debian.sources). Если оставить его и дописать сверху
# классический sources.list, компонент main окажется описан ДВАЖДЫ, и apt на
# каждом вызове сыпет «Target Packages is configured multiple times». Убираем
# deb822-файл — ниже мы задаём полный набор компонентов сами.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && echo "deb http://deb.debian.org/debian bookworm main contrib non-free-firmware non-free" \
        > /etc/apt/sources.list \
    && echo "deb http://deb.debian.org/debian bookworm-updates main contrib non-free-firmware non-free" \
        >> /etc/apt/sources.list \
    && echo "deb http://deb.debian.org/debian-security bookworm-security main contrib non-free-firmware non-free" \
        >> /etc/apt/sources.list

# Требования к хосту — ЕДИНЫЙ источник правды (пакеты, юниты, файлы-предпосылки).
# Тот же файл читает gateway-update.sh при накате по каналу, поэтому списки здесь
# и «на железе» физически не могут разъехаться. Копируем ДО apt, чтобы им же и
# управлять установкой. Ниже (COPY gateway/) файл перекопируется целиком — ок.
COPY gateway/host-requirements.list /opt/gateway/host-requirements.list

# Базовые пакеты + Docker CE + firmware для сетевых карт — списки из требований
RUN apt-get update && apt-get install -y \
        $(sed -n 's/^pkg[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' /opt/gateway/host-requirements.list) \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y \
        $(sed -n 's/^pkg-docker[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' /opt/gateway/host-requirements.list) \
    && rm -rf /var/lib/apt/lists/*

# Overlay: скрипты, конфиги, сервисы
COPY rootfs-overlay/ /

# Docker Compose проект для сервисов
COPY gateway/ /opt/gateway/

# Права. Глобом, а не перечислением: перечисление уже отставало от факта (новый
# скрипт легко забыть дописать), и точно так же его делает gateway-update.sh.
RUN chmod +x /usr/local/bin/*.sh /usr/local/bin/gateway-status

# Короткие команды (видны в MOTD)
RUN ln -sf /usr/local/bin/gateway-installer.sh /usr/local/bin/gateway-install \
    && ln -sf /usr/local/bin/gateway-vpn-debug.sh /usr/local/bin/gateway-vpn-debug

# systemd ругается если .service исполняемые — снимаем +x
RUN chmod 644 /etc/systemd/system/*.service /etc/systemd/system/*.timer 2>/dev/null || true

# Часовой пояс по умолчанию — Москва (авто-определение через geo-IP при загрузке
# уточнит его, см. auto-timezone.service). Время ставит NTP (systemd-timesyncd).
RUN ln -sf /usr/share/zoneinfo/Europe/Moscow /etc/localtime && echo "Europe/Moscow" > /etc/timezone

# Локаль по умолчанию — чтобы pam_env не сыпал WARN «/etc/default/locale not found».
RUN echo 'LANG=C.UTF-8' > /etc/default/locale

# Пароль: openwrt
RUN printf '%s\n%s\n' 'openwrt' 'openwrt' | passwd root

# Кастомный MOTD: убираем стандартный Debian-баннер (uname + copyright),
# приветствие шлюза печатает /etc/profile.d/00-gateway-welcome.sh при входе.
RUN : > /etc/motd \
    && rm -f /etc/update-motd.d/* 2>/dev/null || true \
    && sed -i -E 's/^(session\s+optional\s+pam_motd\.so.*)/# \1/' /etc/pam.d/login 2>/dev/null || true \
    && sed -i -E 's/^(session\s+optional\s+pam_motd\.so.*)/# \1/' /etc/pam.d/sshd 2>/dev/null || true \
    && chmod 644 /etc/profile.d/00-gateway-welcome.sh

# Включаем сервисы — список из тех же требований, что читает gateway-update.sh
RUN systemctl enable \
    $(sed -n 's/^\(unit\|timer\)[[:space:]][[:space:]]*\([^[:space:]]*\).*/\2/p' \
        /opt/gateway/host-requirements.list) 2>/dev/null || true

# Создание образа диска (запускать в --privileged контейнере)
COPY create-image.sh /usr/local/sbin/create-image.sh
RUN chmod +x /usr/local/sbin/create-image.sh

CMD ["/usr/local/sbin/create-image.sh"]
