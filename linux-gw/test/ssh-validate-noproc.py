import paramiko, time
def connect():
    for _ in range(30):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8,banner_timeout=12,auth_timeout=12)
            return c
        except Exception: time.sleep(3)
    raise SystemExit("ssh failed")
def run(c,cmd,to=120):
    _,o,e=c.exec_command(cmd,timeout=to)
    return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')).encode('ascii','replace').decode('ascii')
c=connect()
# найти compose
comp=run(c,"ls /opt/gateway/docker-compose.yml /etc/gateway/docker-compose.yml 2>/dev/null; find / -name docker-compose.yml 2>/dev/null | grep -v proc | head -3").strip()
print("compose:",comp)
path=comp.split()[0] if comp else "/opt/gateway/docker-compose.yml"
# удалить строки с /proc и /sys/class/net
print(run(c, f"sed -i '/\\/proc:\\/proc:ro/d; /\\/sys\\/class\\/net:\\/sys\\/class\\/net:ro/d' {path} && echo 'строки убраны'; grep -nE 'proc|sys/class' {path} || echo 'нет /proc монтирований -> OK'"))
print("=== пересоздаю webui ===")
print(run(c, f"cd $(dirname {path}) && docker compose up -d --force-recreate webui 2>&1 | tail -4", to=120))
time.sleep(8)
print("=== статус ===\n"+run(c,"docker ps --format '{{.Names}} {{.Status}}' | grep webui"))
print("=== /api/system (RAM/CPU хоста) ===\n"+run(c,"curl -s http://127.0.0.1:8000/api/system 2>&1 | head -c 500; echo"))
print("=== /api/network (интерфейсы) ===\n"+run(c,"curl -s http://127.0.0.1:8000/api/network 2>&1 | head -c 700; echo"))
print("=== панель ===\n"+run(c,"curl -sk -o /dev/null -w 'https /login -> %{http_code}\\n' https://127.0.0.1/login"))
c.close()
