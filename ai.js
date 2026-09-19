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

RULES
- Output ONLY JSON: {"lines":[{"item_id":<int>,"qty":<int>,"member_id":<int>,"sure":<bool>,"heard":"<words you matched>"}],"unmatched":["<phrase>"]}
- item_id MUST be an id from MENU. Never invent items. If something ordered is not on the menu, put the phrase in "unmatched".
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

function ruleParse(text, ctx) {
  const lines = [], unmatched = [];
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
      const score = shared * 10 - Math.abs(it.length - shared)
        + (rateHint !== null && parseFloat(item.rate) === rateHint ? 5 : 0)
        + (speakerUsual.includes(item.id) ? 0.5 : 0);
      if (score > bestScore) { best = item; bestScore = score; tie = false; }
      else if (score === bestScore) tie = true;
    }
    if (!best) { unmatched.push(chunk); continue; }

    const existing = lines.find(l => l.item_id === best.id && l.member_id === memberId);
    if (existing) existing.qty += qty;
    else lines.push({ item_id: best.id, qty, member_id: memberId, sure: !tie && memberSure, heard: chunk });
  }
  return { lines, unmatched };
}

// ── validation: never trust model output ────────────────────────
function validate(raw, ctx) {
  const itemById   = new Map(ctx.items.map(i => [Number(i.id), i]));
  const memberById = new Map(ctx.members.map(m => [Number(m.id), m]));
  const merged = new Map();
  const unmatched = Array.isArray(raw?.unmatched) ? raw.unmatched.map(String).filter(Boolean).slice(0, 10) : [];

  for (const l of Array.isArray(raw?.lines) ? raw.lines : []) {
    const item = itemById.get(Number(l.item_id));
    if (!item) { if (l.heard) unmatched.push(String(l.heard)); continue; }
    let qty = parseInt(l.qty, 10);
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    let sure = l.sure !== false;
    if (qty > MAX_QTY) { qty = MAX_QTY; sure = false; }
    let member = memberById.get(Number(l.member_id));
    if (!member) { member = memberById.get(Number(ctx.speaker.id)) || ctx.speaker; if (l.member_id != null) sure = false; }

    const key = `${item.id}:${member.id}`;
    if (merged.has(key)) { merged.get(key).qty = Math.min(MAX_QTY, merged.get(key).qty + qty); continue; }
    merged.set(key, {
      item_id: item.id, item_name: item.name, rate: parseFloat(item.rate), qty,
      member_id: member.id, member_name: member.name, sure, heard: String(l.heard || '').slice(0, 80),
    });
  }
  return { lines: [...merged.values()], unmatched };
}

// ── public API ──────────────────────────────────────────────────
async function parseText(text, ctx) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) return { transcript: '', lines: [], unmatched: [], engine: 'none' };
  const errors = [];
  if (GROQ_KEY) {
    try { return { transcript: text, ...validate(await groqParse(text, ctx), ctx), engine: 'groq' }; }
    catch (e) { errors.push(e.message); }
  }
  if (GEMINI_KEY) {
    try { return { transcript: text, ...validate(await geminiParse(text, ctx), ctx), engine: 'gemini' }; }
    catch (e) { errors.push(e.message); }
  }
  if (errors.length) console.warn('AI parse fell back to rules:', errors.join(' | '));
  return { transcript: text, ...validate(ruleParse(text, ctx), ctx), engine: 'rules' };
}

async function parseAudio(buffer, mime, ctx, lang) {
  const errors = [];
  if (GROQ_KEY) {
    try {
      const transcript = await groqTranscribe(buffer, mime, ctx, lang);
      if (!transcript) return { transcript: '', lines: [], unmatched: [], engine: 'groq' };
      return await parseText(transcript, ctx);
    } catch (e) { errors.push(e.message); }
  }
  if (GEMINI_KEY) {
    try {
      const raw = await geminiAudio(buffer, mime, ctx);
      return { transcript: String(raw.transcript || '').slice(0, 500), ...validate(raw, ctx), engine: 'gemini' };
    } catch (e) { errors.push(e.message); }
  }
  const err = new Error(errors.length ? 'Voice service is unavailable right now' : 'Voice AI is not configured on the server');
  err.detail = errors.join(' | ');
  err.code = 'NO_STT';
  throw err;
}

module.exports = { status, parseText, parseAudio, _ruleParse: ruleParse, _validate: validate };
