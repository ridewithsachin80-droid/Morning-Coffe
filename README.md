# ☕ Morning Accounts PWA

Office canteen daily order tracking with member login, admin review, and payment workflow.

---

## 🚀 Deploy to Railway (Step-by-Step)

### 1. Push to GitHub
```bash
cd morning-accounts
git init
git add .
git commit -m "initial commit"
# Create a new GitHub repo, then:
git remote add origin https://github.com/YOUR_USERNAME/morning-accounts.git
git push -u origin main
```

### 2. Create Railway Project
1. Go to [railway.app](https://railway.app) → New Project
2. Select **Deploy from GitHub repo** → pick `morning-accounts`
3. Railway will auto-detect Node.js

### 3. Add PostgreSQL
1. In Railway project → **+ New** → **Database** → **PostgreSQL**
2. Railway auto-sets `DATABASE_URL` as an environment variable — no action needed

### 4. Set Environment Variable
In Railway → your service → **Variables**:
```
NODE_ENV = production
```

### 4b. Turn on AI voice ordering
In Railway → your service → **Variables**, add the same keys used in FitLife:
```
GROQ_API_KEY   = gsk_...     (primary: Whisper speech-to-text + LLM order parsing)
GEMINI_API_KEY = ...         (automatic fallback if Groq is down / rate-limited)
```
No keys? The app still works — it falls back to the browser's own dictation (Chrome/Android)
plus a built-in rule parser, and typed orders always work.

### 5. Deploy
Railway deploys automatically on every push. First deploy runs the schema and seeds items.

---

## 📱 Install as an app (own icon, no Chrome badge)

The app ships a web manifest, icon set (`public/icons/`, from `icon.svg`) and a service worker, so Chrome
installs it as a real app instead of a bookmark-style shortcut.

1. Remove any old home-screen shortcut (the grey "U" with a Chrome badge) — old shortcuts never update.
2. Open the site in Chrome → ⋮ → **Install app** (not "Add shortcut" / "Create shortcut").
3. iPhone: Safari → Share → **Add to Home Screen**.

To change the icon later: replace `public/icons/icon.svg`, regenerate the PNGs, and bump `CACHE` in `public/sw.js`.

---

## 🔑 First Login (Setup)

On first visit, you'll see the **Setup screen**:
1. Enter **Admin Name** (e.g. your name)
2. Enter **Admin PIN** (4 digits — remember this!)
3. Click **Create Admin Account**

Then log in as admin and start adding members.

---

## 👥 Workflow

### Admin does once:
1. Go to **Members** → Add each person with a unique 4-digit PIN
2. Go to **Items** → Confirm rates or edit them

### Every morning:
1. Each **member** logs in → enters what they ordered → hits **Submit Order**
2. **Admin** logs in → goes to **Dashboard** → reviews pending orders
3. Admin clicks each order → **Approve** it
4. At end of day/month → select approved orders → **Mark as Paid** (records payment to coffee shop)

### ✨ AI order (voice or typed)
The AI mic is the front door: it sits at the top of the home screen (Live Board for admin, Add Items for members).
Tap it and just say it — English, Kannada or Hindi, mixed is fine:
- *"Two coffee and one maddur vada"*
- *"Eradu kaapi, ondu tea for Ravi"* — adds the tea to **Ravi's** tab (shows "added by you")
- *"Twenty rupees coffee"* — a spoken price picks the right variant
- *"Masala dosa, fifty rupees"* — **not on the menu?** It shows as a 🆕 NEW line: confirm the name, enter the
  rate (pre-filled if you said it), and it's added to the menu for everyone and to your tab in one tap.
  Near-miss spellings ("Masalah dosa") match the existing item instead of creating a duplicate.
- *"My usual"* / *"same as yesterday"* — repeats your last order

Recording stops by itself when you stop talking. You always get a confirmation sheet
(edit item / person / qty) before anything is saved. Lines the AI wasn't sure about are
highlighted. Ambiguous items (e.g. two Coffee rates) resolve to what that person usually orders.

How it works: `audio → Groq Whisper → Groq LLM → validated against menu & members → confirm → /api/tab`.
Fallback chain: Groq → Gemini → built-in rules. AI output is never written directly to the DB.
Any member can *add* a missing item this way (`POST /api/items/quick`, max 15/day, records `created_by`);
editing rates and removing items stays admin-only under **Items**. Each tab line records `added_by` and `source` (tap / voice / text). Limit: 20 AI requests/min per member.

### ✏️ Fixing mistakes
- **Live Board is home for everyone** (members and admin), with the AI mic on top.
- Any line can be fixed while the round is **open**: tap ✏️ to change qty, swap the item, move it to another
  member, or 🗑️ delete it. Members can fix their own lines and lines they entered for others; **admin can fix
  any line**. Available on Live Board, Add Items ("Added this round") and My Tab.
- Once payment has started the round is locked — admin taps **Reopen This Round** first.
- **Menu mistakes (admin → Items):** rename, re-rate or remove any item; items added by members show
  "🆕 added by …". Correcting a name/rate also updates that item's lines on rounds that are still open;
  partial/paid rounds keep their original snapshot so settled bills never change.

### Reports:
- Go to **Report** tab → pick date range → Generate
- Export CSV or Print/PDF

---

## 🗄️ Database Tables

| Table | Purpose |
|-------|---------|
| `members` | Login accounts with bcrypt PINs |
| `items` | Menu items with rates |
| `orders` | One order per member per day |
| `order_items` | Line items with rate snapshot |
| `sessions` | 12-hour login sessions |

---

## 🛠 Local Development

```bash
npm install
cp .env.example .env
# Fill in DATABASE_URL with your local postgres or Railway connection string
npm run dev
```

Visit `http://localhost:3000`
