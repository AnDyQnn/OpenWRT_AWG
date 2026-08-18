import paramiko, time
def connect():
    for _ in range(25):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="openwrt",timeout=8,banner_timeout=10,auth_timeout=10)
            return c
        except Exception: time.sleep(3)
    raise SystemExit("ssh failed")
def run(c,cmd,to=120):
    _,o,e=c.exec_command(cmd,timeout=to)
    s=o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')
    return s.encode('ascii','replace').decode('ascii')
c=connect()
print("===== failed units ====="); print(run(c,"systemctl --failed --no-pager 2>&1 | head -15"))
print("===== list-jobs ====="); print(run(c,"systemctl list-jobs --no-pager 2>&1 | head -15"))
print("===== manual start compose ====="); print(run(c,"systemctl start gateway-compose 2>&1; echo done", to=180))
time.sleep(8)
print("===== docker ps ====="); print(run(c,"timeout 15 docker ps -a --format '{{.Names}} {{.Status}}' 2>&1"))
print("===== gw-webui logs ====="); print(run(c,"timeout 15 docker logs gw-webui --tail 30 2>&1"))
c.close()
