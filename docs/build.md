# Сборка образа

[← К содержанию](README.md)

Два пути: **скачать готовый** образ или **собрать из исходников**. Большинству
нужен первый.

---

## Вариант A — скачать готовый образ (рекомендуется)

Готовые образы публикуются в [GitHub Releases](https://github.com/AnDyQnn/OpenWRT_AWG/releases).

| Что | Где |
|-----|-----|
| Файл | `gateway.img.gz` (~820 МБ) |
| Релизы | https://github.com/AnDyQnn/OpenWRT_AWG/releases |
| Последний | тег вида `linux-gw-vX.Y.Z` |

Распаковывать `.gz` **не нужно** — Rufus разожмёт сам при записи (см. [Установка](install.md)).

> Каждый релиз — отдельный тег. Старые версии не удаляются, всегда можно откатиться.

---

## Вариант B — собрать из исходников

### Требования

| Требование | Зачем |
|-----------|-------|
| **Docker Desktop** (с поддержкой `--privileged`) | сборка образов и `.img` |
| **~8 ГБ** свободного места | промежуточные слои + готовый образ |
| **Windows / Linux / macOS** | сборка кросс‑платформенная |
| Интернет | тянет базовые образы и исходники AmneziaWG |

### Команда

```powershell
cd linux-gw
.\build.ps1
```

(на Linux/macOS — эквивалентные шаги в `build.ps1` легко повторить вручную, см. ниже).

### Что происходит (4 шага, ~15–25 мин, 1 раз)

| Шаг | Действие | Время |
|-----|----------|-------|
| 1/4 | Хост‑образ (Debian + Docker + firmware NIC) | ~3–5 мин |
| 2/4 | Образы контейнеров — **здесь компилируется AmneziaWG из Go** | ~10–15 мин |
| 3/4 | `docker save` контейнеров → `images.tar` | ~1 мин |
| 4/4 | `--privileged` контейнер создаёт загрузочный `.img` (GPT + EFI + BIOS) | ~3–5 мин |

**Результат:** `linux-gw/output/gateway.img.gz`

> **Важно:** AmneziaWG и все контейнеры собираются **на машине сборки** и
> вшиваются в образ. На целевом ПК **ничего не компилируется** — первый старт
> просто `docker load` (секунды). Это решает проблему медленной/падающей сборки
> на слабом железе.

### Структура исходников

```
linux-gw/
├── Dockerfile              ← хост-образ (Debian + Docker + firmware)
├── build.ps1               ← сборка: образ + контейнеры → вшивает в .img
├── create-image.sh         ← создание .img (GPT + EFI + BIOS, static grub)
├── rootfs-overlay/         ← файлы на хост-систему
│   ├── etc/systemd/system/ ← сервисы (installer, growroot, swap, init, …)
│   ├── etc/awg-setup/      ← split-default.json (шаблон обхода)
│   └── usr/local/bin/      ← gateway-* скрипты
├── gateway/                ← Docker-проект сервисов
│   ├── docker-compose.yml
│   ├── awg/                ← VPN-контейнер + хелперы маршрутов/ACL
│   ├── dnsmasq/            ← DHCP/DNS-контейнер
│   └── webui/              ← FastAPI-панель + nginx
└── test/                   ← скрипты тестов (VBox, e2e)
```

### Если Docker Desktop отвалился

Сборка step 4 требует `--privileged` (loop‑устройства). Если движок упал —
перезапусти `Docker Desktop.exe`, дождись готовности движка и запусти `build.ps1`
заново (кэш слоёв сохранится, повтор быстрый).

---

## Проверка собранного образа (без записи на флешку)

В `linux-gw/test/` есть скрипты запуска в VirtualBox — см.
[README‑vbox‑test](../linux-gw/test/README-vbox-test.md). Коротко:

```powershell
# 1. подготовить образ (serial-лог, отключить инсталлер)
docker run --rm --privileged -v "<out>:/out" -v "<test>:/insp" gateway-linux:latest sh /insp/prep-vbox-diag.sh
# 2. создать и запустить VM
.\test\make-topology.ps1
```

Панель будет на `https://127.0.0.1:8443`, SSH — `127.0.0.1:2222`.

[← К содержанию](README.md) · [Установка →](install.md)
