import paramiko, time
def connect():
    for _ in range(25):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="openwrt",timeout=8,banner_timeout=10,auth_timeout=10)
            return c
        except Exception: time.sleep(3)
    raise SystemExit("ssh failed")
def run(c,cmd):
    _,o,e=c.exec_command(cmd,timeout=60)
    s=o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')
    return s.encode('ascii','replace').decode('ascii')
c=connect()
cmds=[
 ("uptime/docker", "uptime; echo '--'; systemctl is-active docker; timeout 10 docker version --format '{{.Server.Version}}' 2>&1"),
 ("ps", "timeout 15 docker ps -a --format '{{.Names}} {{.Status}}' 2>&1"),
 ("webui logs", "timeout 15 docker logs gw-webui --tail 30 2>&1"),
 ("compose journal", "journalctl -u gateway-compose -n 8 --no-pager 2>&1 | tail -8"),
]
for t,cmd in cmds:
    print(f"===== {t} ====="); print(run(c,cmd)); print()
c.close()
