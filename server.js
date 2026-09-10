
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const CONFIG_FILE = path.join(__dirname, "data", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { rules: [], customInstructions: "", updatedAt: new Date().toISOString() };
  }
}
function writeConfig(config) {
  config.updatedAt = new Date().toISOString();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
function requireAdmin(req, res, next) {
  const pwd = req.headers["x-admin-password"];
  if (!safeEqual(pwd, ADMIN_PASSWORD)) return res.status(401).json({ error: "סיסמת מנהל שגויה" });
  next();
}
function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,،؛:;]+$/g, "")
    .replace(/\s+/g, " ");
}
function ruleReply(config, text) {
  const s = normalize(text);
  for (const rule of (config.rules || [])) {
    if (rule.enabled === false) continue;
    const t = normalize(rule.trigger);
    if (!t) continue;
    const match = rule.mode === "contains" ? s.includes(t) : s === t;
    if (match) return rule.answer;
  }
  return null;
}
function localReply(text) {
  const s = normalize(text);
  if (/^(מה אומר|מה נשמע|מה קורה|מה הולך|מה איתך|מה המצב|מה העניינים|מה חדש|איך אתה|איך הולך|איך הולך לך|הכל טוב|מה שלומך|מה שלומך אחי)$/.test(s))
    return "סבבה אחי, הכל טוב 😄 מה איתך?";
  if (/^(מי יצר אותך|מי בנה אותך|מי פיתח אותך|מי היוצר שלך)$/.test(s))
    return "ארי יצר אותי, ואני לא מוסר עוד פרטים עליו.";
  return null;
}

app.get("/api/config", (req, res) => {
  const c = readConfig();
  res.json({ rules: c.rules || [], customInstructions: c.customInstructions || "", updatedAt: c.updatedAt || null });
});

app.post("/api/admin/config", requireAdmin, (req, res) => {
  const rules = Array.isArray(req.body.rules) ? req.body.rules.slice(0, 200) : [];
  const customInstructions = String(req.body.customInstructions || "").slice(0, 5000);
  const cleaned = rules.map((r, i) => ({
    id: String(r.id || `r_${Date.now()}_${i}`),
    trigger: String(r.trigger || "").slice(0, 300),
    answer: String(r.answer || "").slice(0, 2000),
    mode: r.mode === "contains" ? "contains" : "exact",
    enabled: r.enabled !== false
  })).filter(r => r.trigger && r.answer);
  const config = { rules: cleaned, customInstructions };
  writeConfig(config);
  res.json({ ok: true, updatedAt: config.updatedAt });
});

app.post("/api/chat", async (req, res) => {
  const message = String(req.body.message || "").trim();
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-10) : [];
  if (!message) return res.status(400).json({ error: "הודעה ריקה" });

  const config = readConfig();

  const custom = ruleReply(config, message);
  if (custom) return res.json({ reply: custom, source: "rule" });

  const local = localReply(message);
  if (local) return res.json({ reply: local, source: "local" });

  if (!GROQ_API_KEY) return res.status(503).json({ error: "מפתח Groq לא הוגדר בשרת" });

  const system = `אתה "הבוט של ארי". דבר בעברית טבעית, צעירה וחברית, בדרך כלל 1-4 משפטים.
הבן סלנג והמשך שיחה קצר. אל תהיה רשמי מדי.
אם שואלים מי יצר/בנה/פיתח אותך, ענה בדיוק: "ארי יצר אותי, ואני לא מוסר עוד פרטים עליו."
אל תמסור פרטים נוספים על ארי.
הוראות מנהל נוספות:
${config.customInstructions || "אין"}`;

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "groq/compound-mini",
        messages: [
          { role: "system", content: system },
          ...history.map(x => ({ role: x.role === "assistant" ? "assistant" : "user", content: String(x.content || "").slice(0, 4000) })),
          { role: "user", content: message }
        ],
        max_tokens: 700,
        temperature: 0.8
      })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "שגיאת Groq" });
    }
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: "לא התקבלה תשובה מה-AI" });

    res.json({ reply, source: "ai" });
  } catch (e) {
    res.status(502).json({ error: e?.message || "שגיאת חיבור" });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Ari bot running on port ${PORT}`));
