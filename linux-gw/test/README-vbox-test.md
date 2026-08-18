# Ручной тест образа в VirtualBox

Как самому прогнать образ `gateway.img.gz` в VirtualBox без записи на флешку.
Всё через консоль `VBoxManage` (GUI открывать не обязательно).

> `VBoxManage` лежит в `C:\Program Files\Oracle\VirtualBox\VBoxManage.exe`.
> Дальше я пишу его как `VBoxManage` — подставь полный путь или добавь папку в PATH.

---

## Вариант А — автоматический скрипт (проще)

В папке `linux-gw\test\` есть готовый скрипт `vbox-run.ps1`. Он сам
конвертирует образ, создаёт VM и запускает её.

```powershell
# 1. Распаковать + подготовить образ (добавляет serial-лог)
cd C:\Users\bropo\Documents\OpenWRT\openwrt-awg-setup\linux-gw
$out = ((Resolve-Path "output").Path) -replace '\\','/' -replace '^([A-Za-z]):','/$1'
$tst = ((Resolve-Path "test").Path)   -replace '\\','/' -replace '^([A-Za-z]):','/$1'
docker run --rm --privileged -v "${out}:/out" -v "${tst}:/insp" gateway-linux:latest sh /insp/prep-vbox-image.sh

# 2. Создать и запустить VM
powershell -ExecutionPolicy Bypass -File .\test\vbox-run.ps1
```

После этого:
- **Веб-панель:** https://127.0.0.1:8443 (`admin` / `admin`)
- **SSH:** `ssh root@127.0.0.1 -p 2222` (пароль `openwrt`)
- **Лог загрузки:** `linux-gw\output\serial.log`

Первый старт ~1–2 минуты (грузятся контейнеры). Панель ответит, когда
поднимутся `gw-awg`, `gw-dnsmasq`, `gw-webui`.

---

## Вариант Б — вручную по шагам

```powershell
$VBM  = "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe"
$base = "C:\Users\bropo\Documents\OpenWRT\openwrt-awg-setup\linux-gw\output"
$VM   = "gateway-test"

# 1. Распаковать .img.gz  (нужен 7-Zip или gunzip; либо через docker:)
#    docker run --rm -v "${base}:/o" debian sh -c "gunzip -kc /o/gateway.img.gz > /o/gateway.img"

# 2. Конвертировать raw -> VDI
& $VBM convertfromraw "$base\gateway.img" "$base\gateway-test.vdi" --format VDI

# 3. Создать VM (EFI, 2 ГБ, 2 ядра)
& $VBM createvm --name $VM --ostype Debian_64 --register
& $VBM modifyvm $VM --memory 2048 --cpus 2 --firmware efi --vram 16

# 4. Подключить диск
& $VBM storagectl $VM --name SATA --add sata --controller IntelAhci
& $VBM storageattach $VM --storagectl SATA --port 0 --device 0 --type hdd --medium "$base\gateway-test.vdi"

# 5. Сеть NAT + проброс портов (панель и SSH на localhost хоста)
& $VBM modifyvm $VM --nic1 nat
& $VBM modifyvm $VM --natpf1 "web,tcp,127.0.0.1,8443,,443"
& $VBM modifyvm $VM --natpf1 "ssh,tcp,127.0.0.1,2222,,22"

# 6. Запустить (без окна)
& $VBM startvm $VM --type headless
#    или с окном:  & $VBM startvm $VM --type gui
```

---

## Что проверять

```powershell
# Панель отвечает?
curl.exe -sk -o NUL -w "%{http_code}`n" https://127.0.0.1:8443/login   # ждём 200

# Зайти по SSH и посмотреть контейнеры:
ssh root@127.0.0.1 -p 2222           # пароль openwrt
#   docker ps                 -> gw-awg, gw-dnsmasq, gw-webui = Up
#   gateway-status            -> сводный дашборд
#   journalctl -u gateway-compose -n 20
```

Открыть панель в браузере: **https://127.0.0.1:8443** → предупреждение о
сертификате → «Дополнительно → Перейти» → логин `admin` / `admin`.

---

## Остановить / удалить VM

```powershell
& $VBM controlvm gateway-test poweroff        # выключить
& $VBM unregistervm gateway-test --delete      # удалить VM + диск
```

---

## Ограничение

В VM нет реального VPN-сервера, поэтому туннель покажет «Прямой/Нет конфига»
пока не загрузишь `.conf`. Проверяется **загрузка системы, контейнеры,
панель, сеть** — то есть весь стек кроме самого VPN-подключения (для него
нужен реальный AmneziaWG-сервер).
