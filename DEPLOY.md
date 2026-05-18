# 🚢 Omega Tracker — Online zetten

## Lokaal draaien (testen op je pc)

```bash
# 1. Installeer Node.js als je dat nog niet hebt: https://nodejs.org
# 2. Open een terminal in de omega-tracker map
npm install
node server.js
# Open in browser: http://localhost:3000
```

---

## Online zetten (gratis, overal bereikbaar via telefoon)

### Optie 1 — Railway (aanbevolen, makkelijkst)

1. Maak een gratis account op https://railway.app
2. Maak een nieuw project: **"Deploy from GitHub repo"**
3. Zet de code op GitHub:
   ```bash
   git init
   git add .
   git commit -m "Omega Tracker v2"
   # Maak een repo op github.com, kopieer de URL dan:
   git remote add origin https://github.com/JOUW-NAAM/omega-tracker.git
   git push -u origin main
   ```
4. In Railway → Settings → Variables, voeg toe:
   - `JWT_SECRET` = een lange willekeurige string (zie hieronder)
   - `PORT` = 3000
5. Railway geeft je automatisch een publieke URL zoals `omega-tracker.up.railway.app`

### Optie 2 — Render (ook gratis)

1. Maak een gratis account op https://render.com
2. New → Web Service → koppel je GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Voeg environment variable `JWT_SECRET` toe
6. Deploy → je krijgt een publieke URL

### Optie 3 — Fly.io

1. Installeer Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
2. ```bash
   fly launch
   fly secrets set JWT_SECRET="jouw-geheime-sleutel-hier"
   fly deploy
   ```

---

## JWT_SECRET genereren

Genereer een veilige geheime sleutel:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Kopieer de output en gebruik dat als `JWT_SECRET`. **Bewaar dit ergens veilig!**
Als je de JWT_SECRET verandert, worden alle bestaande sessies uitgelogd.

---

## Data back-up

- Klik op **💾 Backup** in de app om al je data als JSON te downloaden
- Klik op **📁 Herstel** om een backup terug te laden
- Op Railway/Render: de `data/` map bevat alles — zet een persistente volume in als je dat ondersteunt

---

## Beveiliging

- ✅ Wachtwoorden zijn versleuteld (bcrypt, 10 ronden)
- ✅ JWT tokens verlopen na 30 dagen
- ✅ Rate limiting op login/register (25 pogingen per 15 min)
- ✅ Elke gebruiker ziet enkel zijn eigen data
- ✅ HTTPS wordt automatisch geregeld door Railway/Render
- ✅ Geen databases te installeren — data zit in eenvoudige JSON bestanden

---

## Meerdere gebruikers

Iedereen die de link heeft kan een account aanmaken. Wil je registratie afsluiten?
Voeg dit toe aan server.js vóór de register-route:

```javascript
const ALLOWED_USERS = process.env.ALLOWED_USERS?.split(',') || null;
// Dan in de register route, vóór het aanmaken:
if (ALLOWED_USERS && !ALLOWED_USERS.includes(name.toLowerCase())) {
  return res.status(403).json({ error: 'Registratie is gesloten' });
}
```

En zet in je environment: `ALLOWED_USERS=sander,vriend1,vriend2`
