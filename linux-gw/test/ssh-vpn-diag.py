import paramiko, time, sys
HOST="10.13.13.16"
creds=[("root","openwrt"),("root","root")]
c=None
for u,p in creds:
    try:
        cc=paramiko.SSHClient(); cc.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        cc.connect(HOST,port=22,username=u,password=p,timeout=12,banner_timeout=15,auth_timeout=15)
        c=cc; print(f"[ssh OK] {u}@{HOST}"); break
    except Exception as e:
        print(f"[fail {u}] {type(e).__name__}: {e}")
if not c: raise SystemExit("не удалось подключиться")
def run(cmd,to=40):
    try:
        _,o,e=c.exec_command(cmd,timeout=to)
        return (o.read().decode('utf-8','replace')+e.read().decode('utf-8','replace')).encode('ascii','replace').decode('ascii').rstrip()
    except Exception as ex:
        return f"<err: {ex}>"
items=[
 ("hostname/uptime", "hostname; uptime"),
 ("режим VPN", "cat /run/awg-mode 2>&1; echo; cat /run/awg-setup/wan-port /run/awg-setup/wan-gw 2>&1"),
 ("интерфейсы", "ip -4 -br addr"),
 ("маршрут default (main)", "ip route show default"),
 ("вся таблица маршрутов", "ip route show table all 2>&1 | grep -vE 'broadcast|local ' | head -40"),
 ("ip rule (policy routing wg)", "ip rule show"),
 ("awg show", "docker exec gw-awg awg show 2>&1 | head -25"),
 ("awg0 addr", "ip addr show awg0 2>&1 | grep -E 'inet|mtu'"),
 ("ip_forward", "sysctl net.ipv4.ip_forward 2>&1"),
 ("NAT POSTROUTING (на каком iface MASQUERADE?)", "iptables -t nat -S 2>&1"),
 ("FORWARD фильтр", "iptables -S FORWARD 2>&1"),
 ("filter INPUT/OUTPUT первые", "iptables -S 2>&1 | grep -E 'INPUT|OUTPUT|FORWARD' | head -10"),
 ("DHCP-аренды (есть клиент?)", "cat /var/lib/misc/dnsmasq.leases 2>&1"),
 ("dnsmasq upstream DNS", "docker exec gw-dnsmasq sh -c 'cat /etc/resolv.conf; grep -i server /etc/dnsmasq.d/*.conf /etc/dnsmasq.conf 2>/dev/null' 2>&1 | head -10"),
 ("--- ТЕСТ: шлюз сам в интернет (через VPN) ---", "ping -c2 -W3 1.1.1.1 2>&1 | tail -3"),
 ("--- ТЕСТ: трафик С СОРСОМ br-lan (как у клиента) ---", "ping -c2 -W3 -I 192.168.88.1 1.1.1.1 2>&1 | tail -3"),
 ("--- ТЕСТ: DNS со шлюза ---", "nslookup google.com 127.0.0.1 2>&1 | tail -4"),
 ("--- ТЕСТ: маршрут до 1.1.1.1 каким iface ---", "ip route get 1.1.1.1 2>&1; echo '-- из br-lan --'; ip route get 1.1.1.1 from 192.168.88.10 iif br-lan 2>&1"),
 ("conntrack пример (br-lan клиент)", "cat /proc/net/nf_conntrack 2>/dev/null | grep -E '192.168.88' | head -5 || echo 'нет записей/модуля'"),
 ("контейнеры", "docker ps --format '{{.Names}} {{.Status}}' 2>&1"),
]
for t,cmd in items:
    print(f"\n===== {t} =====\n"+run(cmd))
c.close()
