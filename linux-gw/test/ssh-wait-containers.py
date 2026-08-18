import paramiko, time
def connect():
    for _ in range(40):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8,banner_timeout=12,auth_timeout=12)
            return c
        except Exception: time.sleep(4)
    raise SystemExit("ssh failed")
def run(c,cmd,to=120):
    _,o,e=c.exec_command(cmd,timeout=to)
    s=o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')
    return s.encode('ascii','replace').decode('ascii')
c=connect()
print("[ssh OK] жду появления контейнеров...")
for attempt in range(20):
    ps=run(c,"timeout 20 docker ps -a --format '{{.Names}} {{.Status}}' 2>&1")
    if "gw-webui" in ps:
        print(f"[контейнеры появились на попытке {attempt}]"); print(ps); break
    time.sleep(12)
else:
    print("контейнеры так и не появились. Статус сервисов:")
    print(run(c,"systemctl is-active docker gateway-compose 2>&1"))
    print(run(c,"journalctl -u gateway-compose -n 20 --no-pager 2>&1 | tail -20"))
    c.close(); raise SystemExit

# даём webui пару циклов и снимаем логи
time.sleep(10)
print("\n===== docker ps =====\n"+run(c,"docker ps -a --format '{{.Names}}\t{{.Status}}' 2>&1"))
print("\n===== gw-webui ЛОГИ =====\n"+run(c,"docker logs gw-webui --tail 60 2>&1"))
print("\n===== inspect =====\n"+run(c,"docker inspect gw-webui --format 'ExitCode={{.State.ExitCode}} Error={{.State.Error}} OOM={{.State.OOMKilled}} Restarts={{.RestartCount}}' 2>&1"))
print("\n===== порты =====\n"+run(c,"ss -tlnp 2>/dev/null | grep -E ':80 |:443 ' || echo 'нет слушателей 80/443'"))
c.close()
