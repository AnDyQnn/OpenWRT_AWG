import paramiko
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("127.0.0.1", port=2222, username="root", password="root", timeout=10)
def run(cmd, to=30):
    i, o, e = c.exec_command(cmd, timeout=to)
    return (o.read().decode("utf-8", "replace") + e.read().decode("utf-8", "replace")).rstrip()
print("block.conf в dnsmasq: " + run("docker exec gw-dnsmasq cat /etc/dnsmasq.d/filter/block.conf 2>&1"))
print("A example.com:  " + run("docker exec gw-dnsmasq nslookup example.com 127.0.0.1 2>&1 | grep -i 'address' | tail -1"))
print("direct.list: [" + run("cat /etc/awg-setup/filter/direct.list 2>/dev/null") + "]")
ips = run("getent ahostsv4 ya.ru | awk '{print $1}' | sort -u | head -2")
print("ya.ru ips: " + ips.replace("\n", " "))
for ip in ips.split():
    dev = run("ip route get " + ip + " 2>&1 | grep -oE 'dev [^ ]+' | head -1")
    print("  " + ip + " -> " + dev)
c.close()
