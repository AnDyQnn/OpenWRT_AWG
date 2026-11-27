FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx iproute2 procps openssl \
        curl ca-certificates gnupg \
        util-linux bash \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

RUN pip install --no-cache-dir fastapi "uvicorn[standard]" psutil python-multipart

# Пароль root в контейнере (для fallback-консоли, если контейнер НЕ в pid:host).
# На реальном образе консоль через nsenter заходит в host-login (root/openwrt хоста).
RUN echo 'root:openwrt' | chpasswd

# FastAPI приложение + статика
COPY app/    /app/app/
COPY static/ /app/static/

# nginx как реверс-прокси на uvicorn
COPY nginx.conf /etc/nginx/sites-available/gateway
RUN rm -f /etc/nginx/sites-enabled/default && \
    ln -sf /etc/nginx/sites-available/gateway /etc/nginx/sites-enabled/gateway

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /app
ENTRYPOINT ["/entrypoint.sh"]
