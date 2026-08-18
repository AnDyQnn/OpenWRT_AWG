import paramiko, socket, time

# 1) на шлюзе: добавить DNS-force DNAT + убедиться, что блок example.com на месте
c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("127.0.0.1", port=2222, username="root", password="root", timeout=10)
def run(cmd, to=40):
    i, o, e = c.exec_command(cmd, timeout=to)
    return (o.read().decode("utf-8", "replace") + e.read().decode("utf-8", "replace")).rstrip()
run("for p in udp tcp; do iptables -t nat -C PREROUTING -i br-lan -p $p --dport 53 ! -d 192.168.88.1 -j DNAT --to-destination 192.168.88.1 2>/dev/null || iptables -t nat -A PREROUTING -i br-lan -p $p --dport 53 ! -d 192.168.88.1 -j DNAT --to-destination 192.168.88.1; done")
print("DNAT 53 на шлюзе: " + run("iptables -t nat -S PREROUTING | grep -c 'dport 53'") + " правил")
print("блок example.com на месте: " + run("cat /etc/awg-setup/filter/block.conf | tr '\\n' ' '"))
c.close()

# 2) клиент cli1 через serial
def drive():
    s = None
    for _ in range(15):
        try: s = socket.create_connection(("127.0.0.1", 5023), timeout=5); break
        except Exception: time.sleep(2)
    if not s: return "НЕТ serial"
    s.settimeout(2); buf = [""]
    def read(t=3):
        end = time.time()+t; out=""
        while time.time()<end:
            try:
                d=s.recv(4096)
                if d: out+=d.decode("utf-8","replace")
                else: time.sleep(0.1)
            except socket.timeout: pass
            except Exception: break
        buf[0]+=out; return out
    def send(x): s.sendall((x+"\n").encode()); time.sleep(0.3)
    time.sleep(2); send(""); read(1)
    for _ in range(25):
        o=read(2)
        if "login:" in o or "login:" in buf[0][-150:]: send("root"); time.sleep(1); read(1); break
        if ":~#" in o: break
        send("")
    send("ip link set eth0 up; udhcpc -i eth0 -n -q 2>&1 | grep -o 'lease of [0-9.]*'"); read(7)
    send("echo BLK1; nslookup example.com 2>&1 | grep -i address | tail -1; echo BLK2"); read(6)
    send("echo W1; wget -T6 -qO- http://example.com 2>&1 | head -c 30; echo; echo W2"); read(8)
    send("echo OK1; wget -T8 -qO- https://kremlin.ru 2>&1 | head -c 30; echo; echo OK2"); read(9)
    read(2); s.close(); return buf[0]
out = drive()
# чистим ANSI и печатаем строки-результаты (не команды)
import re
clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", out)
for line in clean.splitlines():
    l = line.strip()
    if not l or l.startswith(("echo ", "ip link", "nslookup ", "wget ", "udhcpc")):
        continue
    if any(k in l for k in ("lease of", "Address", "0.0.0.0", "::", "DOCTYPE", "html", "<", "BLK", "W1", "W2", "OK1", "OK2", "Name:", "can't", "refused", "bad address")):
        print("  | " + l[:90])
