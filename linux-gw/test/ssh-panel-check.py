import paramiko, time
def connect():
    for _ in range(40):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8,banner_timeout=12,auth_timeout=12)
            return c
        except Exception: time.sleep(4)
    raise SystemExit("ssh failed")
def run(c,cmd,to=60):
    _,o,e=c.exec_command(cmd,timeout=to)
    return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')).encode('ascii','replace').decode('ascii')
c=connect()
items=[
 ("docker ps", "docker ps --format '{{.Names}}\t{{.Status}}' 2>&1"),
 ("панель https изнутри", "curl -sk -o /dev/null -w 'HTTP %{http_code}\\n' https://127.0.0.1/ 2>&1; curl -sk -o /dev/null -w 'login HTTP %{http_code}\\n' https://127.0.0.1/login 2>&1"),
 ("панель http изнутри", "curl -s -o /dev/null -w 'HTTP %{http_code}\\n' http://127.0.0.1/ 2>&1"),
 ("слушатели 80/443", "ss -tlnp 2>/dev/null | grep -E ':80 |:443 '"),
 ("webui логи (здоровые)", "docker logs gw-webui --tail 15 2>&1"),
 ("dnsmasq для клиента", "docker logs gw-dnsmasq --tail 12 2>&1"),
 ("NAT/forward", "sysctl net.ipv4.ip_forward 2>&1; iptables -t nat -S POSTROUTING 2>&1 | grep -iE 'masq|MASQ' | head -3"),
]
for t,cmd in items:
    print(f"\n===== {t} =====\n"+run(c,cmd))
c.close()
