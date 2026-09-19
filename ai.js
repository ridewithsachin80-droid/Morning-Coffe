// ════════════════════════════════════════════════════════════════
// Morning Accounts — AI order understanding
//
//   audio ──► speech-to-text ──► order parser ──► validated lines
//
// Speech-to-text : Groq Whisper  → (fallback) Gemini audio
// Order parser   : Groq LLM      → (fallback) Gemini → (fallback) built-in rules
//
// The built-in rule parser needs no API key, so typed / browser-dictated
// orders keep working even if every AI provider is down or unconfigured.
// Nothing here ever writes to the DB — it only returns *suggestions* that
// the user confirms on screen before /api/tab is called.
// ════════════════════════════════════════════════════════════════

const GROQ_KEY   = process.env.GROQ_API_KEY   || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3';
const GROQ_LLM_MODEL = process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile';
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || 'gemini-2.5-flash';

const MAX_QTY = 50;

function status() {
  return {
    stt: !!(GROQ_KEY || GEMINI_KEY),   // server can transcribe audio
    llm: !!(GROQ_KEY || GEMINI_KEY),   // server has an LLM (else rule parser)
  };
}

// ── helpers ─────────────────────────────────────────────────────
const cleanItemName = n => String(n).replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg'))  return 'ogg';
  if (m.includes('wav'))  return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  return 'webm';
}

function extractJson(text) {
  if (!text) throw new Error('Empty AI response');
  const clean = String(text).replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (_) {}
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(clean.slice(a, b + 1));
  throw new Error('AI did not return JSON');
}

// ── prompt ──────────────────────────────────────────────────────
function buildSystemPrompt(ctx) {
  const items   = ctx.items.map(i => `${i.id} | ${i.name} | ₹${parseFloat(i.rate)}`).join('\n');
  const members = ctx.members.map(m => {
    const usual = ctx.usuals[m.id];
    return `${m.id} | ${m.name}${usual && usual.length ? ' | usually: ' + usual.map(u => u.item_id).join(',') : ''}`;
  }).join('\n');
  const last = ctx.lastOrder && ctx.lastOrder.length
    ? ctx.lastOrder.map(l => `${l.item_id} x${l.qty}`).join(', ')
    : 'none';

  return `You turn a spoken office-canteen order into JSON. The speaker is in Karnataka, India and may mix English, Kannada and Hindi (any script). Speech-to-text may have misheard words — use the menu to guess what was meant.

MENU (id | name | rate):
${items}

MEMBERS (id | name | usual item ids, most frequent first):
${members}

SPEAKER: id ${ctx.speaker.id} (${ctx.speaker.name})
SPEAKER'S LAST ORDER: ${last}

STEP 1 — decide the INTENT. The speaker is either ordering food/drink or giving the app a command.
TODAY is ${ctx.today}. Resolve spoken dates ("yesterday", "on the 15th", "last Friday") to YYYY-MM-DD; omit/null when no date was said.
The speaker ${ctx.speaker.is_admin ? 'IS' : 'is NOT'} the admin.

Output ONLY JSON: {"intent":"<one of below>","args":{...},"lines":[],"new_items":[],"unmatched":[]}

INTENTS and their args (use null for anything not said):
- "order"            they had / want food or drink → fill lines / new_items per ORDER RULES. args {}
- "show_bill"        see the bill, total, how much is pending/outstanding/due/unpaid/baaki. args {"scope":"outstanding"|"round","date":null}
                     scope "outstanding" when they say outstanding / pending / due / unpaid / baaki / "how much do we owe"; else "round".
- "pay"              pay / settle / clear the bill, or record that someone paid ("Ravi paid 300", "I gave 200 to the shop", "pay half", "settle using advance").
                     args {"amount":<number|null>,"fraction":"full"|"half"|null,"payer_member_id":<id|null>,"payer_name":<string|null>,"use_advance":<bool>,"date":null}
- "my_tab"           what did I have today / my tab for this round. args {"date":null}  ("how much do I owe" overall is intent "accounts" with the speaker's member_id)
- "member_tab"       what did <member> have / <member>'s total. args {"member_id":<id>,"date":null}
- "remove_entry"     undo / cancel / remove / delete something already added to the tab ("remove my vada", "undo that", "cancel last one", "delete Ravi's tea").
                     args {"item_id":<id|null>,"member_id":<id|null>,"which":"last"|"all"|null}
- "change_qty"       correct a quantity already on the tab ("make my coffee two", "change vada to 3"). args {"item_id":<id>,"qty":<int>,"member_id":<id|null>}
- "navigate"         open a screen. args {"page":"liveBoard"|"addItems"|"myTab"|"history"|"report"|"accounts"|"members"|"adminItems"}
- "report"           spending report / how much did we spend over a period. args {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} ("this month", "last week", "September" → real dates)
- "advance"          advance / credit balance with the shop. args {}
- "collect"          money RECEIVED FROM a member into the group kitty ("Ravi gave 500", "collected 300 from Kiran by UPI", "received 200 from Ravi", "refund 100 to Ravi").
                     args {"member_id":<id>,"amount":<number>,"mode":"cash"|"upi"|null,"kind":"receive"|"refund"}
                     NOTE: "<member> paid the shop / paid the bill" is intent "pay"; "<member> gave / gave me / deposited / contributed" is "collect".
- "accounts"         accounts, balances, who owes, monthly statement ("show accounts", "how much does Ravi owe", "August accounts", "my balance").
                     args {"month":"YYYY-MM"|null,"member_id":<id|null>}  (member_id = the speaker for "my balance")
- "set_rate"         change a MENU price ("make tea 12 rupees", "coffee rate 25"). args {"item_id":<id>,"rate":<number>}
- "add_menu_item"    add something to the MENU without ordering it ("add samosa to the menu at 15"). args {"name":"<Title Case>","rate":<number|null>}
- "remove_menu_item" take something off the MENU. args {"item_id":<id>}
- "reopen_round"     reopen a paid/locked round. args {"date":null}
- "help"             what can you do / how does this work. args {}
- "logout"           sign out / log out. args {}
- "unknown"          none of the above; put what you heard in "unmatched".
"Pay the bill" is ALWAYS intent "pay", "see the outstanding bill" is ALWAYS "show_bill" — never an order, never unknown.
Removing from the TAB (remove_entry) ≠ removing from the MENU (remove_menu_item): "remove my coffee" is the tab; "remove coffee from the menu" is the menu.

STEP 2 — only for intent "order", follow the ORDER RULES.
ORDER RULES
- lines / new_items / unmatched shapes: {"lines":[{"item_id":<int>,"qty":<int>,"member_id":<int>,"sure":<bool>,"heard":"<words you matched>"}],"new_items":[{"name":"<Clean Item Name>","qty":<int>,"member_id":<int>,"rate":<number|null>}],"unmatched":["<phrase>"]}
- First SEARCH the MENU carefully: match by meaning, spelling variants and mishearings ("masalah dosa" = "Masala Dosa", "idly" = "Idli", "wada" = "Vada"). item_id MUST be an id from MENU — never invent ids.
- If a real food or drink was ordered that is genuinely NOT on the MENU, put it in "new_items" so it can be added to the menu: give a clean, correctly spelled, Title Case name (e.g. "Masala Dosa", "Lemon Tea"), its qty and member_id, and "rate" ONLY if the speaker said a price ("masala dosa fifty rupees" → 50), else null. Never guess a rate.
- "unmatched" is only for words you could not understand at all. Not for food items.
- qty defaults to 1. Understand number words: one/two/three, ondu/eradu/mooru/naalku/aidu, ek/do/teen/chaar/paanch, "a couple" = 2.
- member_id: the speaker, unless they clearly order for someone else ("one tea for Ravi", "Ravi ge ondu tea", "Kiran ke liye coffee"). Match names loosely to MEMBERS. If a named person is not in MEMBERS, use the speaker and set sure=false.
- Synonyms: kaapi/kapi/coffee; chai/chaha/tea/tee; neeru/paani/water; idly/idli; vade/vada/wada; "black"/"decoction" = black coffee.
- A spoken price picks the variant: "twenty rupees coffee" / "15 coffee" → the Coffee whose rate matches. Do not treat a price as a quantity.
- If several menu items fit (e.g. two different "Coffee" rates), prefer that member's usual item; if there is no usual, pick the first in MENU order and set sure=false.
- "my usual", "same as yesterday", "same again", "maamooli", "repeat" → copy SPEAKER'S LAST ORDER (if none, return empty lines and put the phrase in unmatched).
- Merge duplicates (same item + same member) into one line.
- Set sure=false whenever you guessed. Ignore chit-chat and filler.`;
}

// ── providers ───────────────────────────────────────────────────
async function groqTranscribe(buffer, mime, ctx, lang) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/webm' }), `order.${extFromMime(mime)}`);
  form.append('model', GROQ_STT_MODEL);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (lang && lang !== 'auto') form.append('language', lang);
  // Biasing prompt: menu words + member names massively improve accuracy on short clips
  const hint = `Canteen order. ${ctx.items.map(i => cleanItemName(i.name)).join(', ')}. ${ctx.members.map(m => m.name).join(', ')}.`;
  form.append('prompt', hint.slice(0, 600));

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Groq STT ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.text || '').trim();
}

async function groqParse(text, ctx) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_LLM_MODEL,
      temperature: 0,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(ctx) },
        { role: 'user',   content: `ORDER: """${text}"""` },
      ],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Groq LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return extractJson(d.choices?.[0]?.message?.content);
}

async function geminiCall(parts, ctx) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buildSystemPrompt(ctx) }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1000 },
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const out = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return extractJson(out);
}

const geminiParse = (text, ctx) => geminiCall([{ text: `ORDER: """${text}"""` }], ctx);

// Gemini hears the audio directly and returns transcript + lines in one shot
const geminiAudio = (buffer, mime, ctx) => geminiCall([
  { inlineData: { mimeType: (mime || 'audio/webm').split(';')[0], data: buffer.toString('base64') } },
  { text: 'Listen to this spoken order. Return the same JSON as specified, plus a top-level "transcript" string with what was said.' },
], ctx);

// ── built-in rule parser (no API key needed) ────────────────────
const NUM_WORDS = {
  a: 1, an: 1, one: 1, single: 1, ondu: 1, ond: 1, ek: 1, vandu: 1,
  two: 2, couple: 2, eradu: 2, yeradu: 2, erdu: 2, do: 2, double: 2,
  three: 3, mooru: 3, muru: 3, teen: 3, tin: 3,
  four: 4, naalku: 4, nalku: 4, chaar: 4, char: 4,
  five: 5, aidu: 5, aydu: 5, paanch: 5, panch: 5,
  six: 6, aaru: 6, aru: 6, chhe: 6, che: 6,
  seven: 7, elu: 7, yelu: 7, saat: 7, sat: 7,
  eight: 8, entu: 8, aath: 8, nine: 9, ombattu: 9, nau: 9, ten: 10, hattu: 10, das: 10,
};
const SYNONYMS = {
  kaapi: 'coffee', kapi: 'coffee', kaffi: 'coffee', kofi: 'coffee', cofee: 'coffee', coffe: 'coffee', coffees: 'coffee',
  chai: 'tea', chaha: 'tea', chaa: 'tea', tee: 'tea', teas: 'tea',
  neeru: 'water', niru: 'water', paani: 'water', pani: 'water',
  idly: 'idli', idlis: 'idli', iddli: 'idli', thatte: 'thare', tatte: 'thare',
  vade: 'vada', wada: 'vada', vadai: 'vada', vadas: 'vada', vades: 'vada',
  bondas: 'bonda', decoction: 'black',
};
const USUAL_RE = /\b(my usual|the usual|usual|same as (yesterday|last time|before)|same again|repeat( my)?( last)?( order)?|maamooli|mamooli|mamuli)\b/i;

function tokenize(s) {
  return String(s).toLowerCase()
    .replace(/₹\s*\d+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map(t => SYNONYMS[t] || t);
}

const RULE_FILLER = new Set(['for','ge','ke','liye','ko','to','please','pls','i','had','took','want','give','me','my','kodi','beku','get','add','of','the','plate','cup','glass']);

function ruleParse(text, ctx) {
  const lines = [], unmatched = [], newItems = [];
  if (USUAL_RE.test(text)) {
    (ctx.lastOrder || []).forEach(l => lines.push({ item_id: l.item_id, qty: l.qty, member_id: ctx.speaker.id, sure: true, heard: 'usual' }));
    if (!lines.length) unmatched.push('usual (no earlier order found)');
    return { lines, unmatched };
  }

  const itemTokens = ctx.items.map(i => ({ item: i, toks: tokenize(cleanItemName(i.name)) }));
  const speakerUsual = (ctx.usuals[ctx.speaker.id] || []).map(u => u.item_id);

  const chunks = String(text).toLowerCase()
    .split(/,|;|\.|\band\b|\bmattu\b|\baur\b|\bplus\b|\bthen\b|\n/).map(s => s.trim()).filter(Boolean);

  for (const chunk of chunks) {
    // a spoken price ("20 rupees coffee", "rs 15 coffee") selects a variant — it is not a quantity
    let rateHint = null, c2 = chunk;
    const pm = c2.match(/(?:rs\.?|₹|rupees?)\s*(\d+)|(\d+)\s*(?:rs\b|rupees?|rupayi|bucks)/);
    if (pm) { rateHint = parseFloat(pm[1] || pm[2]); c2 = c2.replace(pm[0], ' '); }
    let toks = tokenize(c2);
    if (!toks.length) continue;

    // who is it for?
    let memberId = ctx.speaker.id, memberSure = true;
    for (const m of ctx.members) {
      const first = m.name.toLowerCase().split(/\s+/)[0];
      const idx = toks.indexOf(first);
      if (idx >= 0 && first.length > 1) {
        memberId = m.id;
        toks = toks.filter((t, k) => k !== idx && !['for', 'ge', 'ke', 'liye', 'ko', 'to'].includes(t));
        break;
      }
    }

    // quantity
    let qty = 1;
    const numIdx = toks.findIndex(t => /^\d+$/.test(t) || NUM_WORDS[t] !== undefined);
    if (numIdx >= 0) {
      const t = toks[numIdx];
      qty = /^\d+$/.test(t) ? parseInt(t, 10) : NUM_WORDS[t];
      toks = toks.filter((_, k) => k !== numIdx);
    }

    // best menu match = most shared tokens, ties broken by (a) exact length, (b) speaker's usual, (c) menu order
    let best = null, bestScore = 0, tie = false;
    for (const { item, toks: it } of itemTokens) {
      const shared = it.filter(t => toks.includes(t)).length;
      if (!shared) continue;
      // "set dosa" must not become "Masala Dosa": if BOTH sides have words the other lacks, it's a different item
      const chunkExtra = toks.filter(t => !it.includes(t) && !RULE_FILLER.has(t)).length;
      if (chunkExtra > 0 && it.length - shared > 0) continue;
      const score = shared * 10 - Math.abs(it.length - shared)
        + (rateHint !== null && parseFloat(item.rate) === rateHint ? 5 : 0)
        + (speakerUsual.includes(item.id) ? 0.5 : 0);
      if (score > bestScore) { best = item; bestScore = score; tie = false; }
      else if (score === bestScore) tie = true;
    }
    if (!best) {
      // Not on the menu → offer it as a new menu item (user supplies / confirms the rate)
      const FILLER = new Set(['for','ge','ke','liye','ko','to','please','pls','i','had','took','want','give','me','my','kodi','beku','get','add','of','plate','rupees','rs','the']);
      const name = toks.filter(t => !FILLER.has(t) || t === 'plate').join(' ').trim();
      if (name.length >= 3 && /[a-z]/.test(name)) newItems.push({ name, qty, member_id: memberId, rate: rateHint });
      else unmatched.push(chunk);
      continue;
    }

    const existing = lines.find(l => l.item_id === best.id && l.member_id === memberId);
    if (existing) existing.qty += qty;
    else lines.push({ item_id: best.id, qty, member_id: memberId, sure: !tie && memberSure, heard: chunk });
  }
  return { lines, unmatched, new_items: newItems };
}

// ── validation: never trust model output ────────────────────────
const normName = n => cleanItemName(n).toLowerCase().replace(/[^a-z0-9]/g, '');
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}
function tidyName(n) {
  let s = String(n || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/[.,;:!?"“”]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (s && s === s.toLowerCase()) s = s.replace(/\b[a-z]/g, c => c.toUpperCase());   // title-case if all lower
  return s;
}

function validate(raw, ctx) {
  const itemById   = new Map(ctx.items.map(i => [Number(i.id), i]));
  const itemByNorm = new Map(ctx.items.map(i => [normName(i.name), i]));
  const memberById = new Map(ctx.members.map(m => [Number(m.id), m]));
  const self = memberById.get(Number(ctx.speaker.id)) || ctx.speaker;
  const merged = new Map(), newMerged = new Map();
  const unmatched = Array.isArray(raw?.unmatched) ? raw.unmatched.map(String).filter(Boolean).slice(0, 10) : [];

  const qtyOf = q => { let n = parseInt(q, 10); if (!Number.isFinite(n) || n < 1) n = 1; return Math.min(MAX_QTY, n); };
  const addLine = (item, qty, member, sure, heard) => {
    const key = `${item.id}:${member.id}`;
    if (merged.has(key)) { merged.get(key).qty = Math.min(MAX_QTY, merged.get(key).qty + qty); return; }
    merged.set(key, { item_id: item.id, item_name: item.name, rate: parseFloat(item.rate), qty,
      member_id: member.id, member_name: member.name, sure, heard: String(heard || '').slice(0, 80) });
  };
  const addNew = (name, qty, member, rate) => {
    name = tidyName(name);
    if (name.length < 2) return;
    const nn = normName(name);
    const existing = itemByNorm.get(nn);                      // the model missed a menu item → treat as a normal line
    if (existing) return addLine(existing, qty, member, true, name);
    // near-miss spelling ("Masalah Dosa" vs "Masala Dosa") → use the menu item, but flag it for a glance
    if (nn.length >= 6) for (const [k, it] of itemByNorm) {
      if (Math.abs(k.length - nn.length) <= 2 && lev(k, nn) <= 2) return addLine(it, qty, member, false, name);
    }
    const key = `${normName(name)}:${member.id}`;
    if (newMerged.has(key)) { newMerged.get(key).qty = Math.min(MAX_QTY, newMerged.get(key).qty + qty); return; }
    let r = parseFloat(rate); if (!Number.isFinite(r) || r <= 0 || r > 5000) r = null;
    newMerged.set(key, { is_new: true, item_name: name, rate: r, qty, member_id: member.id, member_name: member.name });
  };

  for (const l of Array.isArray(raw?.lines) ? raw.lines : []) {
    const item = itemById.get(Number(l.item_id));
    let sure = l.sure !== false;
    let member = memberById.get(Number(l.member_id));
    if (!member) { member = self; if (l.member_id != null) sure = false; }
    if (!item) { if (l.heard) addNew(l.heard, qtyOf(l.qty), member, null); continue; }
    if (parseInt(l.qty, 10) > MAX_QTY) sure = false;
    addLine(item, qtyOf(l.qty), member, sure, l.heard);
  }
  for (const n of (Array.isArray(raw?.new_items) ? raw.new_items : []).slice(0, 8)) {
    if (!n || !n.name) continue;
    addNew(n.name, qtyOf(n.qty), memberById.get(Number(n.member_id)) || self, n.rate);
  }
  return { lines: [...merged.values()], new_items: [...newMerged.values()], unmatched };
}


// ── commands (everything that is not an order) ──────────────────
const INTENTS = new Set(['order','show_bill','pay','my_tab','member_tab','remove_entry','change_qty','navigate','report',
  'advance','collect','accounts','set_rate','add_menu_item','remove_menu_item','reopen_round','help','logout','unknown']);
const PAGES = new Set(['liveBoard','addItems','myTab','history','report','accounts','members','adminItems']);
const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

function validateCommand(raw, ctx) {
  let intent = INTENTS.has(raw?.intent) ? raw.intent : 'order';
  const a = (raw && typeof raw.args === 'object' && raw.args) || {};
  const itemIds = new Set(ctx.items.map(i => Number(i.id))), memIds = new Set(ctx.members.map(m => Number(m.id)));
  const item = v => itemIds.has(Number(v)) ? Number(v) : null;
  const mem  = v => memIds.has(Number(v)) ? Number(v) : null;
  const num  = (v, max) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : null; };
  const date = v => isDate(v) ? v : null;
  let args = {};
  switch (intent) {
    case 'show_bill':   args = { scope: a.scope === 'outstanding' ? 'outstanding' : 'round', date: date(a.date) }; break;
    case 'pay':         args = { amount: num(a.amount, 1e6), fraction: ['full','half'].includes(a.fraction) ? a.fraction : null,
                                 payer_member_id: mem(a.payer_member_id), payer_name: a.payer_name ? tidyName(a.payer_name).slice(0, 40) : null,
                                 use_advance: a.use_advance === true, date: date(a.date) };
                        if (args.payer_member_id) args.payer_name = ctx.members.find(m => Number(m.id) === args.payer_member_id).name;
                        break;
    case 'my_tab':      args = { date: date(a.date) }; break;
    case 'member_tab':  args = { member_id: mem(a.member_id), date: date(a.date) }; if (!args.member_id) intent = 'my_tab'; break;
    case 'remove_entry':args = { item_id: item(a.item_id), member_id: mem(a.member_id), which: ['last','all'].includes(a.which) ? a.which : null }; break;
    case 'change_qty':  { const q = parseInt(a.qty, 10); args = { item_id: item(a.item_id), qty: q >= 1 && q <= MAX_QTY ? q : null, member_id: mem(a.member_id) };
                          if (!args.item_id || !args.qty) intent = 'unknown'; } break;
    case 'navigate':    args = { page: PAGES.has(a.page) ? a.page : null }; if (!args.page) intent = 'unknown'; break;
    case 'report':      args = { from: date(a.from), to: date(a.to) }; if (args.from && args.to && args.from > args.to) [args.from, args.to] = [args.to, args.from]; break;
    case 'collect':     args = { member_id: mem(a.member_id), amount: num(a.amount, 1e6), mode: ['cash','upi'].includes(a.mode) ? a.mode : null, kind: a.kind === 'refund' ? 'refund' : 'receive' }; break;
    case 'accounts':    args = { month: /^\d{4}-\d{2}$/.test(a.month || '') ? a.month : null, member_id: mem(a.member_id) }; break;
    case 'set_rate':    args = { item_id: item(a.item_id), rate: num(a.rate, 5000) }; if (!args.item_id || !args.rate) intent = 'unknown'; break;
    case 'add_menu_item': args = { name: tidyName(a.name), rate: num(a.rate, 5000) }; if (args.name.length < 2) intent = 'unknown'; break;
    case 'remove_menu_item': args = { item_id: item(a.item_id) }; if (!args.item_id) intent = 'unknown'; break;
    case 'reopen_round': args = { date: date(a.date) }; break;
    default: args = {};
  }
  return { intent, args };
}

// Keyword intent detection for when no LLM is reachable. Conservative: anything unsure stays an order.
function ruleIntent(text, ctx) {
  const t = ' ' + String(text).toLowerCase().replace(/[^a-z0-9₹\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const has = re => re.test(t);
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = isDate(ctx.today) ? new Date(ctx.today + 'T12:00:00') : new Date();
  const day = has(/ yesterday | nenne | kal /) ? ymd(new Date(today.getTime() - 864e5)) : null;
  const member = () => { for (const m of ctx.members) { const f = m.name.toLowerCase().split(/\s+/)[0]; if (f.length > 1 && t.includes(' ' + f + ' ')) return m; } return null; };
  const itemIn = () => { let best = null, n = 0; for (const i of ctx.items) { const tk = tokenize(cleanItemName(i.name)); const sh = tk.filter(x => tokenize(t).includes(x)).length; if (sh > n || (sh === n && sh && tk.length === sh)) { best = i; n = sh; } } return best; };
  const amt = () => { const m = t.match(/(?:₹|rs|rupees)?\s*(\d+(?:\.\d+)?)\s*(?:rs|rupees|rupee|bucks)?/); return m ? parseFloat(m[1]) : null; };

  if (has(/ (what can you do|help|how (do|does) (i|this|it) )/)) return { intent: 'help', args: {} };
  if (has(/ (sign|log) ?out /)) return { intent: 'logout', args: {} };
  if (has(/ reopen /)) return { intent: 'reopen_round', args: { date: day } };
  if (has(/ (advance|credit) /) && !has(/ (pay|settle|use|using|apply) /)) return { intent: 'advance', args: {} };
  if (has(/ menu /) && has(/ (remove|delete|take off) /)) { const i = itemIn(); if (i) return { intent: 'remove_menu_item', args: { item_id: i.id } }; }
  if (has(/ (rate|price) /) && has(/ (change|make|set|update|to) /)) { const i = itemIn(), r = amt(); if (i && r) return { intent: 'set_rate', args: { item_id: i.id, rate: r } }; }
  if (has(/ (gave|given|collected?|received?|deposit(ed)?|contribut(ed|ion)|refund(ed)?) /)) {
    const m = member(); return { intent: 'collect', args: { member_id: m ? m.id : null, amount: amt(), mode: has(/ (upi|gpay|phonepe|paytm|online) /) ? 'upi' : has(/ cash /) ? 'cash' : null, kind: has(/ refund/) ? 'refund' : 'receive' } };
  }
  if (has(/ (accounts?|balances?|statement|who owes|owes?) /)) { const m = member(); return { intent: 'accounts', args: { month: null, member_id: m ? m.id : (has(/ (my|i|mine) /) ? ctx.speaker.id : null) } }; }
  if (has(/ (paid|pay|settle|clear|payment) /)) {
    const m = member();
    return { intent: 'pay', args: { amount: amt(), fraction: has(/ half /) ? 'half' : has(/ (full|fully|everything|all) /) ? 'full' : null,
      payer_member_id: m ? m.id : null, payer_name: m ? m.name : null, use_advance: has(/ (advance|credit) /), date: day } };
  }
  if (has(/ (outstanding|pending|due|dues|unpaid|baaki|baki|owe) /) && !has(/ (i|my|mine) /)) return { intent: 'show_bill', args: { scope: 'outstanding', date: null } };
  if (has(/ (my tab|my total|my bill|mine|did i (have|take|order)) /)) return { intent: 'my_tab', args: { date: day } };
  if (has(/ (bill|total|tab) /)) { const m = member(); return m && has(/ (s|his|her|have|had|total|tab) /) && !has(/ (the bill|show bill|see bill) /) ? { intent: 'member_tab', args: { member_id: m.id, date: day } } : { intent: 'show_bill', args: { scope: 'round', date: day } }; }
  if (has(/ what (did|has|have) /)) { const m = member(); return m ? { intent: 'member_tab', args: { member_id: m.id, date: day } } : { intent: 'my_tab', args: { date: day } }; }
  if (has(/ (undo|remove|delete|cancel|scratch) /)) { const i = itemIn(), m = member(); return { intent: 'remove_entry', args: { item_id: i ? i.id : null, member_id: m ? m.id : null, which: has(/ all /) ? 'all' : 'last' } }; }
  if (has(/ (report|spent|spend|spending|expense|expenses) /)) {
    let from = null, to = ymd(today);
    if (has(/ this month /)) from = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
    else if (has(/ last month /)) { from = ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)); to = ymd(new Date(today.getFullYear(), today.getMonth(), 0)); }
    else if (has(/ (this|last|past) week /)) from = ymd(new Date(today.getTime() - 6 * 864e5));
    else if (has(/ today /)) from = to;
    return { intent: 'report', args: { from, to: from ? to : null } };
  }
  const nav = [[/ (history|past (rounds|sessions)) /, 'history'], [/ members? /, 'members'], [/ (menu|items page|rates) /, 'adminItems'], [/ live board /, 'liveBoard'], [/ add items? /, 'addItems']];
  if (has(/ (open|show|go to|goto|take me|see) /)) for (const [re, page] of nav) if (has(re)) return { intent: 'navigate', args: { page } };
  if (has(/ (what|how|who|when|why|which) /)) return { intent: 'unknown', args: {}, unmatched: [String(text).trim()] };
  return null;
}

// ── public API ──────────────────────────────────────────────────
// Shape every engine's raw output the same way: an order (lines/new_items) or a command (intent/args)
function finish(text, raw, ctx, engine) {
  const cmd = validateCommand(raw, ctx);
  const order = validate(raw, ctx);
  // a model that said "unknown"/"order" but clearly produced order lines → it's an order
  if ((cmd.intent === 'unknown') && (order.lines.length || order.new_items.length)) cmd.intent = 'order';
  if (cmd.intent !== 'order' && cmd.intent !== 'unknown') return { transcript: text, intent: cmd.intent, args: cmd.args, lines: [], new_items: [], unmatched: [], engine };
  return { transcript: text, intent: cmd.intent, args: {}, ...order, engine };
}

async function parseText(text, ctx) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) return { transcript: '', intent: 'unknown', args: {}, lines: [], new_items: [], unmatched: [], engine: 'none' };
  const errors = [];
  if (GROQ_KEY) {
    try { return finish(text, await groqParse(text, ctx), ctx, 'groq'); }
    catch (e) { errors.push(e.message); }
  }
  if (GEMINI_KEY) {
    try { return finish(text, await geminiParse(text, ctx), ctx, 'gemini'); }
    catch (e) { errors.push(e.message); }
  }
  if (errors.length) console.warn('AI parse fell back to rules:', errors.join(' | '));
  const cmd = ruleIntent(text, ctx);
  return finish(text, cmd ? { ...cmd } : { intent: 'order', ...ruleParse(text, ctx) }, ctx, 'rules');
}

async function parseAudio(buffer, mime, ctx, lang) {
  const errors = [];
  if (GROQ_KEY) {
    try {
      const transcript = await groqTranscribe(buffer, mime, ctx, lang);
      if (!transcript) return { transcript: '', intent: 'unknown', args: {}, lines: [], new_items: [], unmatched: [], engine: 'groq' };
      return await parseText(transcript, ctx);
    } catch (e) { errors.push(e.message); }
  }
  if (GEMINI_KEY) {
    try {
      const raw = await geminiAudio(buffer, mime, ctx);
      return finish(String(raw.transcript || '').slice(0, 500), raw, ctx, 'gemini');
    } catch (e) { errors.push(e.message); }
  }
  const err = new Error(errors.length ? 'Voice service is unavailable right now' : 'Voice AI is not configured on the server');
  err.detail = errors.join(' | ');
  err.code = 'NO_STT';
  throw err;
}

module.exports = { status, parseText, parseAudio, _ruleParse: ruleParse, _validate: validate, _ruleIntent: ruleIntent };
