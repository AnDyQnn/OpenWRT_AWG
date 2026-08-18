import paramiko, time, sys
def connect():
    for _ in range(40):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8,banner_timeout=12,auth_timeout=12)
            return c
        except Exception as e:
            time.sleep(4)
    raise SystemExit("ssh failed")
def run(c,cmd,to=90):
    _,o,e=c.exec_command(cmd,timeout=to)
    s=o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')
    return s.encode('ascii','replace').decode('ascii')
c=connect()
print("[ssh OK]")
items=[
 ("WAN/LAN адреса", "ip -4 -br addr 2>&1; echo '-- default route --'; ip route | grep default"),
 ("internet?", "timeout 6 curl -s -o /dev/null -w '%{http_code}' http://1.1.1.1 2>&1; echo"),
 ("docker ps", "timeout 20 docker ps -a --format '{{.Names}}\t{{.Status}}' 2>&1"),
 ("gw-webui ЛОГИ", "timeout 20 docker logs gw-webui --tail 50 2>&1"),
 ("gw-webui inspect exit", "timeout 15 docker inspect gw-webui --format 'ExitCode={{.State.ExitCode}} Error={{.State.Error}} OOM={{.State.OOMKilled}} Restarts={{.RestartCount}}' 2>&1"),
 ("порты 80/443", "ss -tlnp 2>/dev/null | grep -E ':80 |:443 ' || echo 'никто не слушает 80/443'"),
]
for t,cmd in items:
    print(f"\n===== {t} =====")
    print(run(c,cmd))
c.close()
