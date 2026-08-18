import paramiko, time
def connect():
    for _ in range(30):
        try:
            c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect("127.0.0.1",port=2222,username="root",password="root",timeout=8,banner_timeout=12,auth_timeout=12)
            return c
        except Exception: time.sleep(3)
    raise SystemExit("ssh failed")
def run(c,cmd,to=60):
    _,o,e=c.exec_command(cmd,timeout=to)
    return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')).encode('ascii','replace').decode('ascii')
c=connect()
items=[
 ("интерфейсы", "ip -br link 2>&1; echo '--'; ip -4 -br addr 2>&1"),
 ("br-lan члены (master)", "ip link show master br-lan 2>&1"),
 ("bridge link/STP", "bridge link show 2>&1; echo '-- stp --'; cat /sys/class/net/br-lan/bridge/stp_state 2>&1; echo 'forward_delay:'; cat /sys/class/net/br-lan/bridge/forward_delay 2>&1"),
 ("ARP/соседи на br-lan", "ip neigh show dev br-lan 2>&1"),
 ("пинг клиента со шлюза", "ping -c2 -W2 192.168.88.178 2>&1 | tail -3"),
 ("dnsmasq leases", "docker exec gw-dnsmasq cat /var/lib/misc/dnsmasq.leases 2>&1 || cat /var/lib/misc/dnsmasq.leases 2>&1"),
 ("как создаётся br-lan", "ls -la /etc/systemd/network/ 2>&1; echo '--scripts--'; grep -rl br-lan /usr/local/bin/ /etc/systemd/ 2>/dev/null"),
]
for t,cmd in items:
    print(f"\n===== {t} =====\n"+run(c,cmd))
c.close()
