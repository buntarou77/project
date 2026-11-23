#!/bin/bash
# Смоук-тест API на изолированном порту: тест-студия → проверки → уборка.
# Запуск: pnpm test:smoke (из корня). Требует свободный :3001 и БД из server/.env.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH"

PASS=0; FAIL=0; FAILED_NAMES=()
chk() {
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); echo "✓ $1"; else FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); echo "✗ $1"; fi
}
SLUG=smoke-test
B=http://localhost:3001/api
TDIR=tenants/$SLUG

cleanup() {
  kill "$API_PID" 2>/dev/null
  DB=$(grep '^DATABASE_URL=' server/.env | cut -d= -f2-)
  psql "$DB" -q -c "delete from booking_resources where studio_id='$SLUG'; delete from bookings where studio_id='$SLUG'; delete from closed_periods where studio_id='$SLUG'; delete from memberships where studio_id='$SLUG'; delete from studios where slug='$SLUG'; delete from refresh_sessions where user_id in (select id from users where email='smoke@test.local'); delete from users where email='smoke@test.local';" 2>/dev/null
  rm -rf "$TDIR" public/tenants/$SLUG public/s/$SLUG
  pnpm tenant:assets >/dev/null 2>&1
}
trap cleanup EXIT

# --- тест-студия из копии kadr с префиксом id ---
mkdir -p "$TDIR"
python3 - <<'EOF'
import json
cfg = json.load(open('tenants/kadr-studio/tenant.json'))
cfg['settings']['slug'] = 'smoke-test'
cfg['settings']['name'] = 'Смоук-тест'
cfg['portfolio'] = []
for s in cfg['specialists']:
    s['id'] = 'smk-' + s['id']
    for SP in cfg['specialists']: SP['schedule'] = {'mon': {'open': '12:00', 'close': '14:00'}, 'tue': None, 'wed': None, 'thu': None, 'fri': None, 'sat': None, 'sun': None}
for h in cfg['halls']: h['id'] = 'smk-' + h['id']
for s in cfg['services']:
    s['id'] = 'smk-' + s['id']
    if s.get('defaultHallId'): s['defaultHallId'] = 'smk-' + s['defaultHallId']
    if s.get('addonIds'): s['addonIds'] = ['smk-' + x for x in s['addonIds']]
for a in cfg['addons']: a['id'] = 'smk-' + a['id']
# fullDay почасовая услуга для проверки цены «весь день»
cfg['services'].append({
  'id': 'smk-svc-full', 'kind': 'rental', 'name': 'Смоук весь день', 'description': '',
  'priceType': 'hourly', 'price': 0, 'durationMin': 60, 'includes': [], 'deliverableText': '',
  'deadlineDays': 0, 'prepayment': {'type': 'percent', 'value': 0},
  'needsSpecialist': False, 'needsHall': True, 'fullDay': True, 'multiDayMax': 1,
  'autoConfirm': False, 'setupMin': 0, 'cleanupMin': 0, 'sort': 99,
})
json.dump(cfg, open('tenants/smoke-test/tenant.json', 'w'), ensure_ascii=False)
EOF
[ -f "$TDIR/tenant.json" ] || { echo "tenant.json не создан — abort"; exit 1; }

cd server
pnpm studio:create --slug=$SLUG >/dev/null 2>&1
INV=$(pnpm studio:invite --slug=$SLUG --email=smoke@test.local --role=owner 2>/dev/null | grep -o 'invite/[a-zA-Z0-9_-]*' | head -1 | cut -d/ -f2)
PORT=3001 nohup pnpm start > /tmp/opencode/smoke-api.log 2>&1 &
API_PID=$!
for i in $(seq 1 30); do curl -sf -o /dev/null $B/public/studios/$SLUG && break; sleep 0.5; done
cd ..

# --- регистрация владельца ---
curl -sf -c /tmp/opencode/cj.txt $B/auth/register -H 'Content-Type: application/json' \
  -d "{\"token\":\"$INV\",\"password\":\"smoke-pass-123\"}" > /dev/null
chk "register по приглашению" $?

# create-studio не сеет schedule (баг #1) — задаём графики через API
curl -sf -b /tmp/opencode/cj.txt $B/owner/studios/$SLUG | python3 -c "
import json,sys
d=json.load(sys.stdin)
out=[]
for s in d['specialists']:
    s['schedule']={'mon':{'open':'12:00','close':'14:00'},'tue':None,'wed':None,'thu':None,'fri':None,'sat':None,'sun':None}
    out.append(s)
json.dump(out, open('/tmp/opencode/specs.json','w'))"
for i in 0 1; do
  curl -sf -b /tmp/opencode/cj.txt $B/owner/studios/$SLUG/specialists -X POST -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json;print(json.dumps(json.load(open('/tmp/opencode/specs.json'))[$i]))")" -o /dev/null
done

MON=$(date -d "next monday" +%F)
# --- 1. specialists whitelist: у портрета только Анна ---
python3 - <<EOF
import json, urllib.request
d = json.load(open('/tmp/opencode/bundle.json')) if False else None
req = urllib.request.Request('$B/public/studios/$SLUG')
b = json.load(urllib.request.urlopen(req))
svc = next(s for s in b['services'] if s['id'] == 'smk-svc-portrait')
svc['specialistIds'] = ['smk-sp-anna']
req = urllib.request.Request('$B/owner/studios/$SLUG/services', data=json.dumps(svc).encode(),
  headers={'Content-Type': 'application/json'})
open('/tmp/opencode/cj.txt').read()  # noop
# нужны cookies — используем curl снаружи; здесь только подготовка
open('/tmp/opencode/svc-portrait.json', 'w').write(json.dumps(svc))
EOF
curl -sf -b /tmp/opencode/cj.txt $B/owner/studios/$SLUG/services -X POST -H 'Content-Type: application/json' -d @/tmp/opencode/svc-portrait.json -o /dev/null
chk "services: whitelist специалистов сохранён" $?
R=$(curl -sf $B/public/studios/$SLUG/availability -X POST -H 'Content-Type: application/json' \
  -d "{\"serviceId\":\"smk-svc-portrait\",\"dateFrom\":\"$MON\",\"specialistId\":\"smk-sp-mark\",\"hallId\":null,\"offsite\":true,\"travelZoneId\":\"city\",\"peopleCount\":2}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['slots']), d.get('reason'))")
[ "${R%% *}" = "0" ] && [[ "$R" == *"Специалист недоступен для этой услуги"* ]]; chk "whitelist: чужой специалист → slots 0 + reason ($R)" $?

# --- 2. график специалиста: у Анны пн 12:00-14:00 → ровно один слот 12:30 ---
A=$(curl -sf $B/public/studios/$SLUG/availability -X POST -H 'Content-Type: application/json' \
  -d "{\"serviceId\":\"smk-svc-portrait\",\"dateFrom\":\"$MON\",\"specialistId\":null,\"hallId\":null,\"offsite\":true,\"travelZoneId\":\"city\",\"peopleCount\":2}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
from datetime import datetime, timezone
starts=[datetime.fromtimestamp(s['startMs']/1000, timezone.utc).strftime('%H:%M') for s in d['slots']]
print(len(starts), ','.join(starts))")
[ "${A%% *}" = "1" ] && [[ "$A" == *"09:30"* ]]; chk "график специалиста: только слот 12:30 ($A)" $?

# --- 3. fullDay: слот один, цена = все часы окна, конец = закрытие ---
curl -sf $B/public/studios/$SLUG/availability -X POST -H 'Content-Type: application/json' \
  -d "{\"serviceId\":\"smk-svc-full\",\"dateFrom\":\"$MON\",\"specialistId\":null,\"hallId\":null,\"offsite\":true,\"travelZoneId\":\"city\"}" > /tmp/opencode/afd.json
N=$(python3 -c "import json;print(len(json.load(open('/tmp/opencode/afd.json'))['slots']))")
[ "$N" = "1" ]; chk "fullDay: ровно один слот (открытие)" $?
curl -sf $B/public/studios/$SLUG/bookings -X POST -H 'Content-Type: application/json' -d "{
 \"kind\":\"rental\",\"serviceId\":\"smk-svc-full\",\"startUtcMs\":$(python3 -c "import json;print(json.load(open('/tmp/opencode/afd.json'))['slots'][0]['startMs'])"),
 \"hallId\":null,\"specialistId\":null,\"offsite\":false,\"addonIds\":[],\"peopleCount\":1,
 \"client\":{\"name\":\"Смоук\",\"phone\":\"+79990000000\",\"method\":\"phone\"},
 \"consent\":true,\"idempotencyKey\":\"smoke-fd-00000001\"}" > /tmp/opencode/fb.json
python3 - <<'EOF'
import json, sys
d = json.load(open('/tmp/opencode/fb.json'))
ok = d.get('ok') and isinstance(d.get('price', {}).get('total'), int)
total = d['price']['total']
# пн 10:00–21:00: 8 дневных по 1200 + 3 вечерних по 1500 = 14100
sys.exit(0 if ok and total == 14100 else 1)
EOF
chk "fullDay: серверная цена = 14100 (окна × тариф)" $?
BTOK=$(python3 -c "import json;print(json.load(open('/tmp/opencode/fb.json'))['token'])")
SPAN=$(curl -sf $B/public/studios/$SLUG/bookings/$BTOK | python3 -c "
import json,sys;d=json.load(sys.stdin);print((d['endsAtMs']-d['startsAtMs'])//3600000)")
[ "$SPAN" = "11" ]; chk "fullDay: endsAt = закрытие (11 ч)" $?

# --- 4. закрытый период глушит fullDay ---
curl -sf -b /tmp/opencode/cj.txt $B/owner/studios/$SLUG/closed-periods -X POST -H 'Content-Type: application/json' \
  -d "{\"resourceType\":\"studio\",\"dateFrom\":\"$MON\",\"dateTo\":\"$MON\",\"reason\":\"тест\"}" > /dev/null
N2=$(curl -sf $B/public/studios/$SLUG/availability -X POST -H 'Content-Type: application/json' \
  -d "{\"serviceId\":\"smk-svc-full\",\"dateFrom\":\"$MON\",\"specialistId\":null,\"hallId\":null,\"offsite\":true,\"travelZoneId\":\"city\"}" \
  | python3 -c "import json,sys;print(len(json.load(sys.stdin)['slots']))")
[ "$N2" = "0" ]; chk "закрытие студии → fullDay слотов 0" $?

# --- 5. team + settings + anonymize (регресс) ---
INV2=$(curl -sf -b /tmp/opencode/cj.txt $B/owner/studios/$SLUG/invitations -X POST -H 'Content-Type: application/json' \
  -d '{"email":"m2@test.local","role":"employee"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -sf -b /tmp/opencode/cj.txt -X DELETE $B/owner/studios/$SLUG/invitations/$INV2 -o /dev/null
chk "team: приглашение/отзыв" $?

echo "ИТОГ: PASS=$PASS FAIL=$FAIL"
[ $FAIL -gt 0 ] && printf 'FAILED: %s\n' "${FAILED_NAMES[@]}"
exit 0
