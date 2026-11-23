# План тестирования и деплой с нуля

Этот документ разделяет проверку приложения на три этапа:

1. **Локальный демо-режим** — проверить интерфейс и витрину без сервера и БД.
2. **Автоматические тесты** — проверить ядро, API, брони и регрессии.
3. **Боевой сервер** — полный ручной приём и запуск для клиентов.

Подробные ручные сценарии остаются в `TESTING.md`. Этот файл — маршрут: что
тестировать в каком режиме и как поднять прод с нуля.

---

## 1. Этап A: демо-режим, без сервера

Демо-режим работает на `localStorage`. Он нужен для быстрой проверки UI и
витрины, а не для приёмки продакшена.

### Как запустить

```bash
pnpm install
pnpm dev
```

Открой сайт Vite, обычно:

```text
http://localhost:5173
```

Чтобы сбросить локальное демо-состояние, открой DevTools → Application → Local
Storage и удали ключи вида `pf_demo_<slug>`. Проще тестировать в новом окне
инкогнито.

### Что тестировать в демо

Можно и нужно проверять интерфейсные сценарии:

| Что проверяем | Где смотреть в `TESTING.md` |
|---|---|
| Витрина, навигация, карточки, галерея | 6.1 частично, 6.27 |
| Форма записи, выбор услуги/специалиста/зала | 6.3 без серверных проверок |
| Русские даты, ночные слоты, «до следующего дня» | 6.37, 6.38 |
| Редакторы услуг, залов, специалистов в кабинете | 6.18–6.24, 6.32–6.34 |
| Предоплата: `2000%` запрещена, `100%` работает | 6.40 |
| Зоны выезда и их редактор | 6.41 |
| Услуга со специалистом без зала: только зона выезда | 6.42 |
| «Мои записи» на этом устройстве | 6.20 |
| Мобильный вид браузера | визуально |

### Что НЕ тестировать в демо как продовое

Демо не проверяет сервер и БД. Поэтому эти сценарии в демо не приёмка:

- приглашения и вкладка «Команда»;
- роли owner / manager / employee;
- настоящая авторизация и refresh-токены;
- серверная валидация и защита от гонок;
- приватные референсы через API;
- письма и SMTP;
- история заявок на другом устройстве;
- напоминания и notify-воркер;
- бэкапы и миграции;
- настоящая двойная бронь двумя разными клиентами.

Если раздел требует вкладки «Команда», писем, `notify_outbox`, миграций или
реального входа — переходи к этапу B/C.

---

## 2. Этап B: автоматические тесты перед ручной приёмкой

Эти тесты не заменяют ручную приёмку, но ловят большинство регрессий.

Из корня проекта:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

Сервер:

```bash
cd server
pnpm typecheck
pnpm test:integration
cd ..
```

Смок на живом стеке — он сам создаёт временную студию, а после теста удаляет её:

```bash
pnpm test:smoke
```

Ожидаемый текущий ориентир:

```text
unit:        75/75
integration: 47/47
e2e:         18/18
smoke:       9/9
```

Если автоматика красная — сначала чини её. Не переходи к боевому серверу.

---

## 3. Этап C: полный стек локально или на сервере

Полный режим нужен для приёмки бизнес-логики.

### Минимальный локальный полный стек

1. Подними Postgres.

Локально удобнее Docker/Podman:

```bash
docker compose -f docker-compose.dev.yml up -d
```

2. Настрой `server/.env`:

```env
DATABASE_URL=postgres://postgres:test@localhost:5432/photo_booking
PORT=3000
NODE_ENV=development
WEB_ORIGIN=http://localhost:5173
PUBLIC_BASE_URL=http://localhost:3000
UPLOADS_DIR=./uploads
TRUST_PROXY=false
JWT_SECRET=<случайная строка минимум 32 символа>
```

3. Примени миграции:

```bash
cd server
pnpm db:migrate
cd ..
```

4. Запусти API:

```bash
cd server
pnpm dev
cd ..
```

5. Чтобы фронт ходил в Express, а не в демо, создай `.env.local` в корне:

```env
VITE_API_URL=http://localhost:3000
```

6. Перезапусти фронт:

```bash
pnpm dev
```

7. Проверь, что кабинет работает с API: вкладка «Команда» больше не пишет
   «доступно в режиме боевого API».

### Полный ручной тест перед продом

Прогони ключевые блоки из `TESTING.md`:

| Приоритет | Сценарий | Раздел |
|---|---|---|
| Блокер | онбординг владельца | 6.1 |
| Блокер | каталог: зал, услуга, специалист | 6.2 |
| Блокер | бронь с витрины | 6.3 |
| Блокер | двойная бронь / конфликт | 6.4 |
| Блокер | «Моя запись», отмена, ре-открытие | 6.5 |
| Блокер | жизненный цикл заявки до `completed` | 6.6 |
| Блокер | роли и приглашения | 6.7 |
| Блокер | LAST_OWNER | 6.8 |
| Высокий | iCal | 6.10 |
| Высокий | PWA на телефоне по HTTPS | 7.4 (старая 6.11) |
| Высокий | сброс пароля / SMTP | 6.13 |
| Высокий | уведомления | 6.14 |
| Высокий | закрытые периоды и отпуска | 6.17 |
| Высокий | удаление залов и специалистов | 6.25 |
| Высокий | приватные референсы | 6.31 |
| Высокий | зоны выезда и обязательный выезд специалиста | 6.41, 6.42 |
| Средний | push | 7.5 (старая 6.30) |
| Средний | бэкап/восстановление | 7.6 (старая 6.16) |

Правило: если падают 6.3, 6.4, 6.6 или 6.7 — клиентам сайт не показываем.

---

# 4. Деплой на пустой VPS с нуля

Ниже — путь для чистого Ubuntu 22.04/24.04. Для Fedora отличия в пакетном
менеджере и SELinux — в конце раздела.

## 4.1 Что нужно до начала

- VPS: минимум 1 vCPU / 1 ГБ RAM / 10 ГБ диска; комфортно 2 vCPU / 2 ГБ.
- Домен, A-запись которого указывает на IP сервера.
- SSH-доступ под пользователем с sudo.
- Репозиторий проекта: git или архив с кодом.
- SMTP-аккаунт для реальных писем.
- Для клиентов из РФ: сервер и хранение персональных данных в РФ, проверенная
  политика обработки ПД и согласия.

## 4.2 Обнови сервер и установи базовый софт

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx postgresql postgresql-contrib certbot python3-certbot-nginx ufw
```

Установи Node.js 20 LTS и pnpm:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm
```

Проверь:

```bash
node -v
pnpm -v
```

Открой только нужные порты:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Postgres наружу не открывай. Он должен слушать только `127.0.0.1`.

## 4.3 Создай базу PostgreSQL

Включи Postgres:

```bash
sudo systemctl enable --now postgresql
```

Создай пользователя и базу. Замени пароль на свой длинный случайный:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE booking_app LOGIN PASSWORD 'ЗАМЕНИ_НА_ДЛИННЫЙ_ПАРОЛЬ';
CREATE DATABASE photo_booking OWNER booking_app;
SQL
```

Проверь, что Postgres слушает локально:

```bash
ss -lntp | grep 5432
```

Ожидаемо адрес `127.0.0.1:5432`, а не `0.0.0.0:5432`.

## 4.4 Загрузи проект

Создай служебного пользователя и каталог приложения:

```bash
sudo adduser --system --group --home /var/www/app --shell /bin/bash booking
sudo -u booking mkdir -p /var/www/app
```

Клонируй репозиторий:

```bash
sudo -u booking git clone <URL_ТВОЕГО_РЕПОЗИТОРИЯ> /var/www/app
cd /var/www/app
```

Если репозиторий приватный, заранее добавь deploy key или клонируй архивом.

Установи зависимости фронтенда и сервера:

```bash
sudo -u booking pnpm install
cd server
sudo -u booking pnpm install --prod=false
cd ..
```

`--prod=false` нужен, потому что сервер запускается через `tsx`.

## 4.5 Настрой переменные сервера

Создай `server/.env`:

```bash
cd /var/www/app
sudo -u booking cp server/.env.example server/.env
sudo -u booking nano server/.env
```

Пример боевого файла:

```env
DATABASE_URL=postgres://booking_app:ПАРОЛЬ@127.0.0.1:5432/photo_booking

PORT=3000
NODE_ENV=production
WEB_ORIGIN=https://example.ru
PUBLIC_BASE_URL=https://example.ru
UPLOADS_DIR=/var/www/app/server/uploads
TRUST_PROXY=true

JWT_SECRET=<openssl rand -base64 48>

# Реальный SMTP-провайдер. Спецсимволы пароля URL-кодируй.
SMTP_URL=smtps://login:password@smtp.provider.ru:465
MAIL_FROM=noreply@example.ru

# Опционально:
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=gpt-4o-mini
DAILY_MODEL_BUDGET_RUB=50

VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.ru
```

Сгенерируй JWT-секрет:

```bash
openssl rand -base64 48
```

Закрой файл `.env` от чужих пользователей:

```bash
sudo chown booking:booking /var/www/app/server/.env
sudo chmod 600 /var/www/app/server/.env
```

Важно:

- `WEB_ORIGIN` — точный фронтовый адрес, без слэша в конце.
- `PUBLIC_BASE_URL` — тот же домен, из него строятся ссылки приглашений и URL
  файлов.
- `TRUST_PROXY=true` обязателен, потому что API стоит за nginx.
- Пароль БД и SMTP URL-кодируй, если содержит `@`, `:`, `/`, `%` и другие
  специальные символы.

## 4.6 Создай/проверь студию-тенанта

Каждая студия описывается файлом:

```text
tenants/<slug>/tenant.json
```

Если студии ещё нет, удобно создать заготовку локально:

```bash
pnpm tenant:new --slug=my-studio --name="Название студии" --city="Москва"
```

Отредактируй:

```text
tenants/my-studio/tenant.json
```

Для боевой студии поставь:

```json
"status": "active"
```

`demo` — это витрина-образец с плашкой «ОБРАЗЕЦ».

Проверь конфиг:

```bash
pnpm tenant:validate
```

Если менял ассеты/конфиги, пересобери PWA и tenant-файлы:

```bash
pnpm tenant:assets
pnpm build
```

Залей студию в PostgreSQL:

```bash
cd server
pnpm studio:create --slug=my-studio
cd ..
```

⚠️ Не запускай `studio:create --force` у живой студии без понимания
последствий: он перезаписывает seed-каталог и может удалить/перезаписать
сущности, отредактированные владельцем.

## 4.7 Примени миграции и создай владельца

Миграции:

```bash
cd /var/www/app/server
pnpm db:migrate
```

Создай приглашение первому владельцу:

```bash
pnpm studio:invite --slug=my-studio --email=owner@example.ru --role=owner
```

Если SMTP уже настроен, письмо уйдёт провайдеру. Если SMTP нет, CLI напечатает
одноразовую ссылку. Открой её на своём домене:

```text
https://example.ru/invite/<token>
```

Задай пароль и войди в кабинет:

```text
https://example.ru/owner
```

## 4.8 Собери и поставь фронтенд

В корне проекта создай `.env.production`:

```bash
cd /var/www/app
sudo -u booking nano .env.production
```

Пример:

```env
VITE_API_URL=https://example.ru
```

Собери:

```bash
sudo -u booking pnpm build
```

Готовый фронт будет в:

```text
/var/www/app/dist
```

Права на uploads и dist:

```bash
sudo mkdir -p /var/www/app/server/uploads
sudo chown -R booking:booking /var/www/app/server/uploads /var/www/app/dist
sudo chmod 750 /var/www/app/server/uploads
```

## 4.9 Настрой systemd для API

Скопируй готовый юнит:

```bash
sudo cp /var/www/app/server/deploy/photo-booking.service /etc/systemd/system/photo-booking.service
sudo systemctl daemon-reload
sudo systemctl enable --now photo-booking
```

Проверь:

```bash
systemctl status photo-booking
journalctl -u photo-booking -f
curl http://127.0.0.1:3000/api/health
```

Ожидаемый ответ:

```json
{"ok":true}
```

## 4.10 Настрой nginx и HTTPS

До выпуска сертификата создай временный HTTP-конфиг:

```bash
sudo nano /etc/nginx/sites-available/photo-booking
```

Временный конфиг:

```nginx
server {
    listen 80;
    server_name example.ru;

    root /var/www/app/dist;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 12m;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:3000;
    }

    location /sw.js {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }
}
```

Включи:

```bash
sudo ln -sf /etc/nginx/sites-available/photo-booking /etc/nginx/sites-enabled/photo-booking
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Получи сертификат:

```bash
sudo certbot --nginx -d example.ru
```

После этого можно сверить финальный конфиг с шаблоном:

```text
server/deploy/nginx.conf.example
```

Он добавляет HTTPS, кэширование и корректные SPA/PWA-роуты.

Проверь:

```bash
curl -I https://example.ru
curl https://example.ru/api/health
curl -I https://example.ru/s/my-studio
```

## 4.11 Настрой бэкапы

Создай каталог:

```bash
sudo mkdir -p /var/backups/photo-booking
```

Простой ежедневный бэкап БД и файлов. Открой root-cron:

```bash
sudo crontab -e
```

Добавь:

```cron
0 3 * * * sudo -u postgres pg_dump -Fc photo_booking > /var/backups/photo-booking/db-$(date +\%F).dump && tar -czf /var/backups/photo-booking/uploads-$(date +\%F).tar.gz -C /var/www/app/server uploads && find /var/backups/photo-booking -type f -mtime +14 -delete
```

Обязательно один раз проверь восстановление на тестовой базе или копии:

```bash
sudo -u postgres pg_restore --clean --if-exists -d photo_booking /path/to/db.dump
tar -xzf uploads.tar.gz -C /var/www/app/server
sudo chown -R booking:booking /var/www/app/server/uploads
sudo systemctl restart photo-booking
```

Бэкап без проверенного восстановления — это не бэкап.

---

# 5. Обновление боевого сервера

Стандартный порядок:

```bash
cd /var/www/app
sudo -u booking git pull
sudo -u booking pnpm install
cd server
sudo -u booking pnpm install --prod=false
sudo -u booking pnpm db:migrate
cd ..
sudo -u booking pnpm tenant:assets
sudo -u booking pnpm build
sudo systemctl restart photo-booking
```

Если менялись только фронтовые файлы, миграции и рестарт API не обязательны,
но такой единый порядок безопаснее.

После обновления проверь:

```bash
curl https://example.ru/api/health
```

и ключевые сценарии: бронь, кабинет, вход, PWA.

---

# 6. Боевой чек-лист перед клиентами

## Инфраструктура

- [ ] Домен открывается только по HTTPS, HTTP редиректит.
- [ ] `JWT_SECRET` уникальный, минимум 32 символа, не из примера.
- [ ] `server/.env` имеет права `600` и не попал в git.
- [ ] Postgres слушает только localhost.
- [ ] Файрвол открывает только SSH, HTTP, HTTPS.
- [ ] `TRUST_PROXY=true`, потому что API за nginx.
- [ ] `WEB_ORIGIN` и `PUBLIC_BASE_URL` совпадают с реальным доменом.
- [ ] systemd перезапускает API автоматически.
- [ ] Бэкапы БД и uploads настроены.
- [ ] Восстановление из бэкапа проверено.

## Приложение

- [ ] `pnpm typecheck` корня и server зелёные.
- [ ] `pnpm test`, `pnpm e2e` зелёные.
- [ ] `pnpm --dir server test:integration` зелёный.
- [ ] `pnpm test:smoke` зелёный.
- [ ] Миграции применены на проде.
- [ ] Тенант-конфиг валиден: `pnpm tenant:validate`.
- [ ] Студия в БД имеет `status = active`, если она не образец.
- [ ] Владелец создал реальный каталог: залы, услуги, специалисты.
- [ ] Зоны выезда настроены.
- [ ] Предоплаты и цены проверены.
- [ ] Референсы и приватные файлы не открываются без доступа.
- [ ] SMTP работает, письма не попадают в спам.
- [ ] Сброс пароля проверен.
- [ ] PWA открывается на телефоне по HTTPS.
- [ ] Календарь владельца и отмена брони проверены.
- [ ] Роли manager/employee проверены.
- [ ] В логах API нет повторяющихся ошибок.

## Юридическое

- [ ] Политика обработки ПД доступна клиенту.
- [ ] Согласие на обработку ПД в форме записи включено и проверено.
- [ ] Сервер/хранилище соответствует требованиям для твоих клиентов.
- [ ] Указаны реальные реквизиты и контакты студии/платформы.

---

# 7. Fedora: отличия

Вместо apt:

```bash
sudo dnf install nginx postgresql-server postgresql-contrib certbot python3-certbot-nginx
```

Инициализация Postgres:

```bash
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

Firewall:

```bash
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

SELinux:

```bash
sudo setsebool -P httpd_can_network_connect on
sudo dnf install policycoreutils-python-utils
sudo semanage fcontext -a -t httpd_sys_content_t "/var/www/app/dist(/.*)?"
sudo restorecon -R /var/www/app/dist
```

Остальные шаги те же.

---

# 8. Типовые проблемы

## Фронт показывает демо, хотя API запущен

Значит фронт собран без `VITE_API_URL`.

Проверь в `.env.production` или `.env.local`:

```env
VITE_API_URL=https://example.ru
```

Пересобери фронт и сделай жёсткое обновление браузера.

## Вкладки «Команда» нет

Проверь:

- ты вошёл как `owner`, а не manager/employee;
- фронт работает с Express;
- домен в `WEB_ORIGIN` совпадает с адресом кабинета.

## API возвращает 502

```bash
systemctl status photo-booking
journalctl -u photo-booking -n 100
curl http://127.0.0.1:3000/api/health
```

Обычно причина — сервер упал, неверный `.env` или нет зависимостей.

## Письма не уходят

Проверь:

```bash
cd /var/www/app/server
pnpm smtp:test
journalctl -u photo-booking -n 100
```

- `SMTP_URL` должен указывать на реального провайдера.
- `MAIL_FROM` обычно должен принадлежать проверенному домену/аккаунту.
- Провайдер может требовать подтверждённого домена и SPF/DKIM.

## PWA не обновляется

Service worker кэширует старую сборку. Сделай жёсткое обновление или очисти
данные сайта. `/sw.js` в nginx должен быть без кэша.

## Загрузка фото падает

Проверь:

- существует `/var/www/app/server/uploads`;
- владелец каталога `booking`;
- nginx `client_max_body_size 12m`;
- сервер в `.env` использует тот же `UPLOADS_DIR`.
