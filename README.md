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

## 🎨 Theme — "Ceramic & Gold"
Dark, warm-black UI whose palette comes from the app icon: ceramic off-white text, vintage-gold amounts and
primary actions, jade/amber/rose for paid/partial/errors. The UpScale gradient appears in one place only —
around the AI mic. All colours are CSS variables at the top of `public/index.html` (`--gold`, `--surface`, …).
Fonts: Instrument Serif (titles, amounts) + Hanken Grotesk (UI). Printing falls back to a light scheme.

## 🔄 Updates — phones can't stay on an old version
The server fingerprints everything it ships (`APP_VERSION`), stamps it into the page and sends it on every API
reply (`X-App-Version`). A phone running an older page notices on its next tap, on returning to the app, or within
5 minutes, and shows **"A new version is ready → Update now"** with no way to dismiss it. It waits politely if the
person is mid-recording or has a sheet open. Update clears caches, reloads, and keeps them signed in. The reload
also re-reads the manifest, which is what lets Android pick up a new app icon (Chrome asks the user to confirm
icon changes once — see below).

## 🎙️ Listening
The mic waits up to 12 s for the first word, then keeps listening until **3.5 s of silence** (with an
"Anything else? Searching in 3…" countdown), so people can think mid-sentence. Tap the button to finish sooner.
Tune `AI_SILENCE_MS` / `AI_FIRST_WORD_MS` / `AI_MAX_MS` at the top of the AI section in `public/index.html`.

## 📱 Install as an app (own icon, no Chrome badge)

The app ships a web manifest, icon set (`public/icons/`, from `icon.svg`) and a service worker, so Chrome
installs it as a real app instead of a bookmark-style shortcut.

1. Remove any old home-screen shortcut (the grey "U" with a Chrome badge) — old shortcuts never update.
2. Open the site in Chrome → ⋮ → **Install app** (not "Add shortcut" / "Create shortcut").
3. iPhone: Safari → Share → **Add to Home Screen**.

**Changing the icon later:** replace the PNGs in `public/icons/` (and `icon.svg`) and deploy. The server stamps
every manifest icon URL with a hash of the file (`?v=…`), which is what makes Chrome notice the change.

**How installed phones get it (Android/Chrome):** the next time the app is opened Chrome re-reads the manifest,
sees new icon URLs and queues the update. Because an icon is part of the app's identity, Chrome asks the user to
confirm it once ("Review app update" / update dialog) — a website cannot skip that step. It is applied after the
app is closed. Old *shortcuts* (grey letter icon with a Chrome badge) are bookmarks, not installs — they never
update and must be removed and re-installed. iPhone never refreshes a home-screen icon; remove and re-add.
The app's code and screens need none of this — they are always the latest version on every open.

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

### 📷 Item photos
Admin → **Items** → tap the 📷 square beside an item → choose or take a photo. The phone crops and shrinks it
(480×360 JPEG, ~25 KB) before upload; it is stored in Postgres (`items.image`) — no bucket to configure — and
served with a versioned, cache-forever URL. Photos show on the Add Items cards and beside lines on the Live Board.

### 💼 Accounts — collect from members, close the month
**Accounts** tab (everyone can read; only admin records money).

- **How the bill is shared** is a per-month setting (admin), because whoever walks to the shop usually enters
  the whole group's order, so lines under a member's name are not a reliable record of who consumed what:
  - **Equal split** *(default)* — the month's bill ÷ the members ticked as sharing that month (whole rupees;
    the odd rupee rotates). Untick anyone who was away.
  - **As entered** — each member is charged the lines recorded against their name.
  - **Kitty only** — nobody is charged individually; you just track money in, money out and the balance in hand.
  The choice applies to that month and onward until changed. Earlier months keep their own setting, so
  brought-forward balances don't shift when you change the method later.
- **Member balance = money they put in − their share.** "Put in" = cash/UPI you received from them
  (**＋ Receive money**) + anything they paid the shop from their own pocket. Negative = to pay, positive = credit.
  Balances carry forward month to month ("brought forward").
- **＋ Add what each paid** opens one sheet listing every member with an amount box: type what each gave, or use
  *Same amount for all* / *Fill dues*, pick mode and date once, and save them all together. *One member / refund*
  (under the month's list) is there for single entries and refunds.
- **Kitty in hand = everything collected − payments to the shop made from the kitty.**
- When paying the shop, **Paid from** now asks the source: 💼 *Kitty* (collected money), a *member's own pocket*
  (credited to their account), or *someone else* (recorded, credited to nobody). Older payments are matched to
  members by payer name automatically.
- Tap a member → day-by-day **statement** with running balance → **Share** (WhatsApp) or **Receive ₹due** in one tap.
- Month end: pick the month → **Share month summary**, **CSV**, or **Print / PDF**.
- Voice: "Ravi gave 500", "collected 300 from Kiran by UPI", "refund 100 to Ravi", "show accounts",
  "how much does Ravi owe?", "August accounts".
- Sanity check built in: *still to collect from members* = *unpaid at the shop* − *kitty in hand* (when no one is in credit).

### 🗣️ Voice commands (not just orders)
The mic is on every screen and understands commands as well as orders — say it or type it:

| Say | What happens |
|---|---|
| "What's outstanding?" / "how much is pending" | Total still owed to the shop across all unpaid rounds, each with View/Pay |
| "Show the bill" / "yesterday's bill" | Opens that round's bill |
| "Pay the bill" / "pay half" / "pay 200" / "Ravi paid 300" / "settle using advance" | Opens the bill with payer and amount pre-filled — **you still tap Confirm Payment** |
| "How much do I owe?" / "What did Ravi have?" | My Tab / that member's lines and total |
| "Remove my vada" / "undo that" / "make my coffee two" | Finds the line on the open round and asks to confirm |
| "Report for this month" / "how much did we spend last week" | Opens the report for that range |
| "How much advance do we have?" | Advance credit ledger |
| "Open history / members / items" | Goes there |
| Admin: "change tea rate to 12", "add samosa to the menu at 15", "remove samosa from the menu", "reopen the round" | Each asks to confirm |
| "What can you do?" | Tappable list of examples |

The AI only *classifies* what was said (`intent` + `args`, validated server-side). The action then runs through the
same screens, permissions and confirmations as tapping — voice never moves money or deletes anything on its own.
Without AI keys a keyword fallback covers the common commands.

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
