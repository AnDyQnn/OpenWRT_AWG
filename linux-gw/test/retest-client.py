import socket, time
s=socket.create_connection(("127.0.0.1",5023),timeout=5); s.settimeout(2)
buf=""
def read(t=3):
    global buf
    end=time.time()+t; out=""
    while time.time()<end:
        try:
            d=s.recv(4096)
            if d: out+=d.decode('utf-8','replace')
            else: time.sleep(0.1)
        except socket.timeout: pass
        except Exception: break
    buf+=out; return out
def send(c): s.sendall((c+"\n").encode()); time.sleep(0.3)
send(""); read(1)
cmds=[
 "echo MARK",
 "echo '== renew dhcp =='; udhcpc -i eth0 -n -q 2>&1 | tail -2",
 "echo '== ping gw =='; ping -c3 -W2 192.168.88.1 | tail -2",
 "echo '== ping inet =='; ping -c3 -W2 1.1.1.1 | tail -2",
 "echo '== dns =='; nslookup ya.ru 192.168.88.1 2>&1 | tail -3",
 "echo '== panel =='; wget -S -O /dev/null http://192.168.88.1/ 2>&1 | grep -iE 'HTTP/|location' | head -2",
 "echo END",
]
for c in cmds:
    send(c); read(5 if any(k in c for k in("ping","wget","dhcp","nslookup"))else 2)
read(3); s.close()
i=buf.find("== renew")
print(buf[i:] if i>=0 else buf[-2500:])
