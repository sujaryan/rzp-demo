require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const USE_REAL_CHECKFRONT = !!(process.env.CHECKFRONT_HOST && process.env.CHECKFRONT_TOKEN_ID);
const CONFIG = {
  port:          process.env.PORT             || 3001,
  razorpayKeyId: process.env.RAZORPAY_KEY_ID  || "rzp_test_DEMO",
};

const MOCK = {
  items: {
    "101": { item_id:"101", name:"Forest Skirmish — Standard", teaser:"Classic woodland paintball. Up to 20 players.", status:"A", price:"35.00", stock:20, image:{"1":{url_small:"https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=200&h=200&fit=crop"}} },
    "102": { item_id:"102", name:"Urban Combat — Pro",          teaser:"High-intensity urban warfare with bunkers.",  status:"A", price:"55.00", stock:15, image:{"1":{url_small:"https://images.unsplash.com/photo-1511795409834-ef04bbd61622?w=200&h=200&fit=crop"}} },
    "103": { item_id:"103", name:"Birthday Battle Package",     teaser:"Full session + private arena for 2 hours.",   status:"A", price:"280.00",stock:5,  image:{"1":{url_small:"https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=200&h=200&fit=crop"}} },
  },
  rate(id, g) {
    const item = this.items[id]; if (!item) return null;
    const total = (parseFloat(item.price) * g).toFixed(2);
    return { ...item, rated:1, total, sub_total:total, slip:`${id}.${Date.now()}X8-guests.${g}` };
  },
  form() {
    return { booking_form_ui: {
      customer_name:  { value:"", define:{required:1, type:"text",  lbl:"Full Name",                    layout:{customer:{form:1,required:1}}} },
      customer_email: { value:"", define:{required:1, type:"email", lbl:"Email Address",                layout:{customer:{form:1,required:1}}} },
      customer_phone: { value:"", define:{required:1, type:"tel",   lbl:"Phone Number",                 layout:{customer:{form:1,required:1}}} },
      customer_note:  { value:"", define:{required:0, type:"text",  lbl:"Special Requests (optional)",  layout:{customer:{form:1}}} },
    }};
  },
};

const sessions = {};
const widgetFile = ["razorpay-checkfront.js","razorpay checkfront.js"].find(f => fs.existsSync(path.join(__dirname,f)));

// ── Serve the full page with widget embedded ──────────────────────
app.get("/", (_, res) => res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Red Dynasty Paintball — Book Now</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#080810;color:#e8e8f0;min-height:100vh}
.banner{background:#e6394615;border-bottom:1px solid #e6394630;padding:10px 48px;display:flex;align-items:center;gap:10px;font-size:13px;color:#e63946cc}
.badge{background:#e63946;color:#fff;font-size:10px;font-weight:700;border-radius:4px;padding:2px 7px}
.banner a{color:#e63946;margin-left:auto;font-size:12px;text-decoration:none}
nav{display:flex;align-items:center;justify-content:space-between;padding:20px 48px;border-bottom:1px solid #1a1a28;position:sticky;top:0;z-index:10;background:#080810cc;backdrop-filter:blur(12px)}
.logo{font-family:'Syne',sans-serif;font-weight:800;font-size:20px;color:#fff;display:flex;align-items:center;gap:10px}
.logo span{width:32px;height:32px;background:#e63946;border-radius:8px;display:flex;align-items:center;justify-content:center}
nav ul{display:flex;list-style:none;gap:32px}
nav a{color:#888;text-decoration:none;font-size:14px}
.cta{background:#e63946!important;color:#fff!important;padding:8px 18px;border-radius:8px;font-weight:600!important}
.hero{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;max-width:1200px;margin:0 auto;padding:80px 48px}
.tag{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#e63946;background:#e6394618;border:1px solid #e6394630;border-radius:20px;padding:5px 14px;margin-bottom:20px}
h1{font-family:'Syne',sans-serif;font-size:52px;font-weight:800;line-height:1.05;color:#fff;margin-bottom:18px}
h1 em{font-style:normal;color:#e63946}
.desc{font-size:15px;line-height:1.7;color:#888;margin-bottom:28px}
.stats{display:flex;gap:32px}
.sn{font-family:'Syne',sans-serif;font-size:26px;font-weight:800;color:#fff}
.sl{font-size:12px;color:#666;margin-top:2px}
.booking{display:flex;justify-content:center}
.features{max-width:1200px;margin:0 auto;padding:64px 48px;border-top:1px solid #1a1a28}
.features h2{font-family:'Syne',sans-serif;font-size:30px;font-weight:700;text-align:center;color:#fff;margin-bottom:40px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.card{background:#10101a;border:1px solid #1a1a28;border-radius:14px;padding:24px;transition:border-color .2s}
.card:hover{border-color:#e63946}
.ci{font-size:28px;margin-bottom:12px}
.ct{font-weight:700;font-size:15px;color:#fff;margin-bottom:6px}
.cd{font-size:13px;color:#666;line-height:1.6}
#mode{position:fixed;bottom:16px;right:16px;font-size:11px;font-family:monospace;background:#10101a;border:1px solid #e6394640;border-radius:8px;padding:6px 12px;color:#e63946aa}
@media(max-width:860px){.hero{grid-template-columns:1fr;padding:40px 20px}h1{font-size:38px}.grid{grid-template-columns:1fr}nav{padding:14px 20px}nav ul{display:none}.banner{padding:10px 20px}}
</style></head><body>
<div class="banner"><span class="badge">DEMO</span>Razorpay × Checkfront — booking widget via single script tag.<a href="/health" target="_blank">Server health →</a></div>
<nav>
  <div class="logo"><span>🎯</span>Red Dynasty</div>
  <ul><li><a href="#">Sessions</a></li><li><a href="#">Gallery</a></li><li><a href="#">Groups</a></li><li><a href="#book" class="cta">Book Now</a></li></ul>
</nav>
<section class="hero" id="book">
  <div>
    <div class="tag">Now open for bookings</div>
    <h1>Feel the<br/><em>adrenaline</em><br/>rush.</h1>
    <p class="desc">Singapore's premier paintball experience. Corporate events, birthday parties, team-building — book in under 2 minutes.</p>
    <div class="stats">
      <div><div class="sn">12+</div><div class="sl">Battle Scenarios</div></div>
      <div><div class="sn">5★</div><div class="sl">Google Rating</div></div>
      <div><div class="sn">10k+</div><div class="sl">Happy Players</div></div>
    </div>
  </div>
  <div class="booking"><div id="razorpay-booking" style="width:100%;max-width:480px;"></div></div>
</section>
<section class="features">
  <h2>Why Red Dynasty?</h2>
  <div class="grid">
    <div class="card"><div class="ci">⚡</div><div class="ct">Instant Confirmation</div><div class="cd">Book and pay online. Confirmed immediately.</div></div>
    <div class="card"><div class="ci">🎯</div><div class="ct">Multiple Scenarios</div><div class="cd">Forest Skirmish to Urban Combat. 5 to 100+ players.</div></div>
    <div class="card"><div class="ci">🏢</div><div class="ct">Corporate Packages</div><div class="cd">Team-building with catering and tournament formats.</div></div>
  </div>
</section>
<div id="mode">🟡 MOCK — demo data</div>
<script src="/widget/razorpay-checkfront.js"
  data-checkfront-host="reddynasty.checkfront.com"
  data-razorpay-key="${CONFIG.razorpayKeyId}"
  data-proxy-url=""
  data-currency="SGD"
  data-theme-color="#e63946"
  data-merchant-name="Red Dynasty Paintball"
></script>
</body></html>`));

// ── Serve widget JS ───────────────────────────────────────────────
app.get("/widget/razorpay-checkfront.js", (req, res) => {
  if (!widgetFile) return res.status(404).send("// widget file not found");
  res.setHeader("Content-Type","application/javascript");
  res.sendFile(path.join(__dirname, widgetFile));
});

// ── Checkfront mock API ───────────────────────────────────────────
app.get("/cf", (req, res) => {
  const { cf_path, ...p } = req.query;
  if (cf_path === "/api/3.0/item") return res.json({ item: MOCK.items });
  const im = cf_path.match(/^\/api\/3\.0\/item\/(\d+)$/);
  if (im) { const r = MOCK.rate(im[1], parseInt(p["param[guests]"]||1)); return r ? res.json({item:{[im[1]]:r}}) : res.status(404).json({error:"Not found"}); }
  if (cf_path === "/api/3.0/booking/form") return res.json(MOCK.form());
  res.status(404).json({ error: "Unknown: "+cf_path });
});

app.post("/cf", (req, res) => {
  const { cf_path, ...body } = req.body;
  if (cf_path === "/api/3.0/booking/session") {
    const slip = body.slip||body["slip[]"];
    const sid  = "sess_"+crypto.randomBytes(8).toString("hex");
    const id   = slip ? String(slip).split(".")[0] : "101";
    const g    = slip ? ((String(slip).match(/guests\.(\d+)/)||[])[1]||1) : 1;
    const item = MOCK.rate(id, parseInt(g));
    sessions[sid] = { item };
    return res.json({ booking:{ session:{ id:sid, total:item?.total||"35.00", sub_total:item?.total||"35.00", due:item?.total||"35.00", summary:item?.name||"Session" }}});
  }
  if (cf_path === "/api/3.0/booking/create") {
    const s  = sessions[body.session_id]||{};
    const id = "RD-"+Date.now().toString(36).toUpperCase().slice(-6);
    sessions[id] = { ...s, status:"RESERVED" };
    return res.json({ booking:{ booking_id:id, status:"RESERVED", total:s.item?.total||"35.00" }});
  }
  const pm = cf_path.match(/^\/api\/3\.0\/booking\/([A-Z0-9-]+)$/);
  if (pm) { if(sessions[pm[1]]) sessions[pm[1]].status="PAID"; return res.json({booking:{booking_id:pm[1],status:"PAID"}}); }
  res.status(404).json({ error:"Unknown: "+cf_path });
});

app.post("/payment-confirm", (req, res) => {
  const { razorpay_payment_id, booking_id } = req.body;
  if (sessions[booking_id]) sessions[booking_id].status = "PAID";
  console.log("✅ Payment "+razorpay_payment_id+" | Booking "+booking_id+" → PAID");
  res.json({ success:true, booking_id, payment_id:razorpay_payment_id });
});

app.get("/config", (_, res) => res.json({ razorpay_key_id: CONFIG.razorpayKeyId, mock_mode: !USE_REAL_CHECKFRONT }));
app.get("/health", (_, res) => res.json({ status:"ok", widget: widgetFile||"MISSING", timestamp: new Date().toISOString() }));

app.listen(CONFIG.port, () => console.log("🚀 Port "+CONFIG.port+" | Widget: "+(widgetFile||"NOT FOUND")));
