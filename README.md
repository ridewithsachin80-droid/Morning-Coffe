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
On **Add Items**, tap the mic and just say it — English, Kannada or Hindi, mixed is fine:
- *"Two coffee and one maddur vada"*
- *"Eradu kaapi, ondu tea for Ravi"* — adds the tea to **Ravi's** tab (shows "added by you")
- *"Twenty rupees coffee"* — a spoken price picks the right variant
- *"My usual"* / *"same as yesterday"* — repeats your last order

Recording stops by itself when you stop talking. You always get a confirmation sheet
(edit item / person / qty) before anything is saved. Lines the AI wasn't sure about are
highlighted. Ambiguous items (e.g. two Coffee rates) resolve to what that person usually orders.

How it works: `audio → Groq Whisper → Groq LLM → validated against menu & members → confirm → /api/tab`.
Fallback chain: Groq → Gemini → built-in rules. AI output is never written directly to the DB.
Each tab line records `added_by` and `source` (tap / voice / text). Limit: 20 AI requests/min per member.

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
