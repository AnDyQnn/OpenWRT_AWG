#!/bin/bash
# Устойчивый запуск: каждый шаг логируется в stdout (docker logs gw-webui),
# падение одного компонента не роняет весь контейнер молча.
log(){ echo "[webui $(date +%H:%M:%S)] $*"; }

log "start, kernel=$(uname -r) arch=$(uname -m)"
mkdir -p /var/log/nginx /etc/nginx/ssl || log "WARN: mkdir /var/log/nginx failed"

# --- self-signed сертификат (если openssl упадёт — не валим контейнер, идём в HTTP-only) ---
SSL_OK=1
if [ ! -f /etc/nginx/ssl/gateway.crt ]; then
    log "generating self-signed cert..."
    if openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
        -keyout /etc/nginx/ssl/gateway.key \
        -out /etc/nginx/ssl/gateway.crt \
        -subj "/C=RU/O=Gateway Hub/CN=gateway.local" \
        -addext "subjectAltName=IP:192.168.88.1,DNS:gateway.local" 2>/tmp/ssl.err; then
        chmod 600 /etc/nginx/ssl/gateway.key
        log "cert OK"
    else
        SSL_OK=0
        log "ERROR: openssl failed -> HTTP-only fallback:"; sed 's/^/  /' /tmp/ssl.err
    fi
fi
[ -f /etc/nginx/ssl/gateway.crt ] || SSL_OK=0

# Если SSL недоступен — переключаем nginx на HTTP-only (панель будет на http://, не https)
if [ "$SSL_OK" = 0 ]; then
    log "WARN: serving plain HTTP on :80 (no TLS)"
    cat > /etc/nginx/sites-available/gateway <<'EOF'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 2M;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
    }
}
EOF
fi

# --- FastAPI/uvicorn в фоне с авто-перезапуском (краш зависимости не убивает панель навсегда) ---
(
    cd /app
    n=0
    while true; do
        n=$((n+1))
        log "uvicorn start (attempt $n)"
        uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
        rc=$?
        log "uvicorn exited rc=$rc — restart in 3s"
        sleep 3
    done
) &

# Ждём, пока uvicorn ответит (до 25с)
for i in $(seq 1 25); do
    curl -sf http://127.0.0.1:8000/login >/dev/null 2>&1 && { log "uvicorn ready"; break; }
    [ "$i" = 25 ] && log "WARN: uvicorn not ready after 25s (панель статикой/502 для /api)"
    sleep 1
done

# --- nginx под супервизором: даже если упадёт, контейнер НЕ умирает ---
log "nginx config test:"
nginx -t 2>&1 | sed 's/^/  /'
n=0
while true; do
    n=$((n+1))
    log "starting nginx (attempt $n)"
    nginx -g 'daemon off;'
    rc=$?
    log "ERROR: nginx exited rc=$rc — панель временно недоступна, перезапуск через 3с"
    sleep 3
done
