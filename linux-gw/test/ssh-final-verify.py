import paramiko, time
def connect():
    for _ in range(50):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8,banner_timeout=12,auth_timeout=12)
            return c
        except Exception: time.sleep(4)
    raise SystemExit("ssh failed")
def run(c,cmd,to=120):
    _,o,e=c.exec_command(cmd,timeout=to)
    return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')).encode('ascii','replace').decode('ascii')
c=connect()
print("[ssh OK] жду 3 контейнера...")
for _ in range(20):
    ps=run(c,"timeout 20 docker ps --format '{{.Names}} {{.Status}}' 2>&1")
    if ps.count("Up")>=3 and "gw-webui" in ps: print("[3 контейнера Up]"); break
    time.sleep(12)
print("\n===== контейнеры =====\n"+run(c,"docker ps -a --format '{{.Names}}\t{{.Status}}' 2>&1"))
print("\n===== wan-detect (выбор WAN/LAN) =====\n"+run(c,"grep wan-detect /var/log/awg-watchdog.log 2>&1 | tail -10"))
print("\n===== compose: НЕТ /proc? =====\n"+run(c,"grep -nE 'proc|sys/class' /opt/gateway/docker-compose.yml 2>&1 || echo 'OK: /proc монтирований нет'"))
print("\n===== панель =====\n"+run(c,"curl -sk -o /dev/null -w '/login -> %{http_code}\\n' https://127.0.0.1/login 2>&1; ss -tlnp 2>/dev/null | grep -cE ':80 |:443 ' | xargs echo 'слушателей 80/443:'"))
print("\n===== webui лог (неубиваемый entrypoint) =====\n"+run(c,"docker logs gw-webui --tail 6 2>&1"))
print("\n===== gateway-status (без ошибки leases?) =====\n"+run(c,"gateway-status 2>&1 | sed 's/\\x1b\\[[0-9;]*m//g' | grep -iE 'СЕТЬ|line 32|leases|WAN|LAN|КОНТЕЙ' | head -8"))
c.close()
