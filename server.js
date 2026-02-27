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
  port:              process.env.PORT                || 3001,
  razorpayKeyId:     process.env.RAZORPAY_KEY_ID     || "rzp_test_DEMO",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || "",
};

const MOCK_DATA = {
  items: {
    "101": { item_id:"101", name:"Forest Skirmish — Standard", teaser:"<p>Classic woodland paintball. Up to 20 players.</p>", status:"A", price:"35.00", stock:20, image:{"1":{url_small:"https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=200&h=200&fit=crop"}}, category:"Standard Sessions" },
    "102": { item_id:"102", name:"Urban Combat — Pro", teaser:"<p>High-intensity urban warfare with bunkers.</p>", status:"A", price:"55.00", stock:15, image:{"1":{url_small:"https://images.unsplash.com/photo-1511795409834-ef04bbd61622?w=200&h=200&fit=crop"}}, category:"Pro Sessions" },
    "103": { item_id:"103", name:"Birthday Battle Package", teaser:"<p>Full session + cake setup + private arena for 2 hours.</p>", status:"A", price:"280.00", stock:5, image:{"1":{url_small:"https://images.unsplash.com/photo-1530103862676-de8c9debad1d?w=200&h=200&fit=crop"}}, category:"Packages" },
  },
  getRatedItem(itemId, guests) {
    const item = this.items[itemId];
    if (!item) return null;
    const total = (parseFloat(item.price) * guests).toFixed(2);
    return { ...item, rated:1, total, sub_total:total, slip:`${itemId}.${Date.now()}X8-guests.${guests}`, param:{guests:{value:guests,label:"Guests"}} };
  },
  getBookingForm() {
    return { booking_form_ui: {
      customer_name:  { value:"", define:{required:1,type:"text", lbl:"Full Name",     layout:{customer:{form:1,required:1}}} },
      customer_email: { value:"", define:{required:1,type:"email",lbl:"Email Address", layout:{customer:{form:1,required:1}}} },
      customer_phone: { value:"", define:{required:1,type:"tel",  lbl:"Phone Number",  layout:{customer:{form:1,required:1}}} },
      customer_note:  { value:"", define:{required:0,type:"text", lbl:"Special Requests (optional)", layout:{customer:{form:1}}} },
    }};
  },
};

const sessions = {};

// Auto-detect the widget JS file (handles any filename variation)
const widgetFile = ["razorpay-checkfront.js","razorpay checkfront.js"].find(f => fs.existsSync(path.join(__dirname, f)));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/widget/razorpay-checkfront.js", (req, res) => {
  if (!widgetFile) return res.status(404).send("Widget not found");
  res.sendFile(path.join(__dirname, widgetFile));
});

app.get("/cf", async (req, res) => {
  const { cf_path, ...params } = req.query;
  if (!cf_path) return res.status(400).json({ error:"cf_path required" });
  if (cf_path === "/api/3.0/item") return res.json({ item: MOCK_DATA.items });
  const im = cf_path.match(/^\/api\/3\.0\/item\/(\d+)$/);
  if (im) { const g=parseInt(params["param[guests]"]||1); const r=MOCK_DATA.getRatedItem(im[1],g); return r?res.json({item:{[im[1]]:r}}):res.status(404).json({error:"Not found"}); }
  if (cf_path === "/api/3.0/booking/form") return res.json(MOCK_DATA.getBookingForm());
  return res.status(404).json({ error:`Unknown: ${cf_path}` });
});

app.post("/cf", async (req, res) => {
  const { cf_path, ...body } = req.body;
  if (!cf_path) return res.status(400).json({ error:"cf_path required" });
  if (cf_path === "/api/3.0/booking/session") {
    const slip=body.slip||body["slip[]"];
    const sid=`sess_${crypto.randomBytes(8).toString("hex")}`;
    const itemId=slip?String(slip).split(".")[0]:"101";
    const guests=slip?(String(slip).match(/guests\.(\d+)/)||[])[1]||1:1;
    const item=MOCK_DATA.getRatedItem(itemId,parseInt(guests));
    sessions[sid]={slip,itemId,guests,item};
    return res.json({ booking:{ session:{ id:sid, total:item?.total||"35.00", sub_total:item?.total||"35.00", due:item?.total||"35.00", summary:item?.name||"Session" }}});
  }
  if (cf_path === "/api/3.0/booking/create") {
    const session=sessions[body.session_id]||{};
    const bookingId=`RD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const total=session.item?.total||"35.00";
    sessions[bookingId]={...session,total,status:"RESERVED"};
    return res.json({ booking:{ booking_id:bookingId, status:"RESERVED", total, customer:{ name:body["form[customer_name]"]||"", email:body["form[customer_email]"]||"" }}});
  }
  const pm=cf_path.match(/^\/api\/3\.0\/booking\/([A-Z0-9-]+)$/);
  if (pm) { if(sessions[pm[1]])sessions[pm[1]].status="PAID"; return res.json({booking:{booking_id:pm[1],status:"PAID"}}); }
  return res.status(404).json({ error:`Unknown: ${cf_path}` });
});

app.post("/payment-confirm", async (req, res) => {
  const { razorpay_payment_id, booking_id } = req.body;
  console.log(`✅ Payment ${razorpay_payment_id} for booking ${booking_id}`);
  if (sessions[booking_id]) sessions[booking_id].status = "PAID";
  return res.json({ success:true, booking_id, payment_id:razorpay_payment_id });
});

app.get("/config", (_, res) => res.json({ razorpay_key_id: CONFIG.razorpayKeyId, mock_mode: !USE_REAL_CHECKFRONT }));
app.get("/health", (_, res) => res.json({ status:"ok", widget: widgetFile||"missing", timestamp: new Date().toISOString() }));

app.listen(CONFIG.port, () => console.log(`🚀 Port ${CONFIG.port} | Widget: ${widgetFile||"NOT FOUND"}`));
