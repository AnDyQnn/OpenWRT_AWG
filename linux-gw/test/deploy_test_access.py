import paramiko, base64, time
L = "C:/Users/bropo/Documents/OpenWRT/openwrt-awg-setup/linux-gw/"
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("127.0.0.1", port=2222, username="root", password="root", timeout=10)
def run(cmd, to=60):
    i, o, e = c.exec_command(cmd, timeout=to)
    return (o.read().decode("utf-8", "replace") + e.read().decode("utf-8", "replace")).rstrip()
# deploy main.py
mp = open(L + "gateway/webui/app/main.py", encoding="utf-8").read()
b64 = base64.b64encode(mp.encode()).decode()
run("echo " + b64 + " | base64 -d | docker exec -i gw-webui sh -c 'cat > /app/app/main.py'")
run("docker restart gw-webui >/dev/null 2>&1")
time.sleep(7)
# ensure VPN up
run("docker exec gw-awg awg-up /config/awg0.conf >/dev/null 2>&1; sleep 3")
# clear previous rules
run("rm -f /etc/awg-setup/filter/*.conf /etc/awg-setup/filter/*.list /etc/awg-setup/filter/rules.json")
# login + add
run("curl -sk -c /tmp/cj -X POST -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"admin\"}' https://127.0.0.1/api/login -o /dev/null")
t0 = time.time()
print("POST block: " + run("curl -sk -b /tmp/cj -m 20 -X POST -H 'Content-Type: application/json' -d '{\"action\":\"add\",\"kind\":\"block\",\"domain\":\"example.com\"}' https://127.0.0.1/api/access -w ' (%{time_total}s)' 2>&1 | tail -c 120"))
print("POST direct: " + run("curl -sk -b /tmp/cj -m 20 -X POST -H 'Content-Type: application/json' -d '{\"action\":\"add\",\"kind\":\"direct\",\"domain\":\"ya.ru\"}' https://127.0.0.1/api/access -w ' (%{time_total}s)' 2>&1 | tail -c 140"))
time.sleep(3)
print("\nblock.conf:\n" + run("cat /etc/awg-setup/filter/block.conf"))
print("direct.list: [" + run("cat /etc/awg-setup/filter/direct.list") + "]")
print("\n=== БЛОК example.com (A и AAAA) ===")
print("A:    " + run("docker exec gw-dnsmasq nslookup -type=A example.com 127.0.0.1 2>&1 | grep -i address | tail -1"))
print("AAAA: " + run("docker exec gw-dnsmasq nslookup -type=AAAA example.com 127.0.0.1 2>&1 | grep -i address | tail -1"))
print("не-блок kremlin.ru: " + run("docker exec gw-dnsmasq nslookup kremlin.ru 127.0.0.1 2>&1 | grep -i address | tail -1"))
print("\n=== ya.ru НАПРЯМУЮ (мимо VPN)? ===")
ips = run("getent ahostsv4 ya.ru | awk '{print $1}' | sort -u | head -2")
for ip in ips.split():
    print("  " + ip + " -> " + run("ip route get " + ip + " 2>&1 | grep -oE 'dev [^ ]+' | head -1"))
c.close()
