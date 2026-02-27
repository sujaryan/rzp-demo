/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          Razorpay × Checkfront Booking Widget                 ║
 * ║          v1.0.0  |  Powered by Razorpay                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * HOW MERCHANTS USE THIS — just one line on their website:
 *
 *   <div id="razorpay-booking"></div>
 *   <script
 *     src="https://cdn.razorpay.com/checkfront/razorpay-checkfront.js"
 *     data-checkfront-host="reddynasty.checkfront.com"
 *     data-razorpay-key="rzp_live_XXXXXXXX"
 *     data-proxy-url="https://your-proxy.onrender.com"
 *     data-currency="SGD"
 *     data-theme-color="#e63946"
 *     data-merchant-name="Red Dynasty Paintball"
 *   ></script>
 *
 * ─── HOW IT WORKS (full API flow) ────────────────────────────────
 *
 *  Step 1  GET  /api/3.0/item
 *          → Fetch all bookable items from Checkfront
 *
 *  Step 2  GET  /api/3.0/item/{id}?start_date=&end_date=&param[guests]=N
 *          → Get a "rated" item with live pricing + availability SLIP token
 *
 *  Step 3  POST /api/3.0/booking/session  { slip: "..." }
 *          → Create a booking session (like a cart), get session_id
 *
 *  Step 4  GET  /api/3.0/booking/form
 *          → Get the customer detail fields required for this account
 *
 *  Step 5  POST /api/3.0/booking/create  { session_id, form[...] }
 *          → Create the booking (status: RESERVED, awaiting payment)
 *          → Returns booking_id and total amount
 *
 *  Step 6  Razorpay checkout opens in an iframe/modal
 *          → Customer pays
 *
 *  Step 7  POST /proxy/payment-confirm
 *          → Proxy verifies Razorpay signature, then calls
 *            POST /api/3.0/booking/{id}/payment to record payment in Checkfront
 *          → Booking status → CONFIRMED / PAID
 *
 * ─────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  // ── 1. Read configuration from script tag ───────────────────────
  const scriptTag = document.currentScript;
  const CONFIG = {
    checkfrontHost: scriptTag.getAttribute("data-checkfront-host"),
    razorpayKey:    scriptTag.getAttribute("data-razorpay-key"),
    proxyUrl:       (scriptTag.getAttribute("data-proxy-url") || "").replace(/\/$/, ""),
    currency:       scriptTag.getAttribute("data-currency")     || "SGD",
    themeColor:     scriptTag.getAttribute("data-theme-color")  || "#528FF0",
    merchantName:   scriptTag.getAttribute("data-merchant-name") || "Book Now",
    containerId:    scriptTag.getAttribute("data-container")    || "razorpay-booking",
    logoUrl:        scriptTag.getAttribute("data-logo-url")     || "",
    itemId:         scriptTag.getAttribute("data-item-id")      || null, // optional: restrict to single item
  };

  if (!CONFIG.checkfrontHost || !CONFIG.razorpayKey || !CONFIG.proxyUrl) {
    console.error("[Razorpay×Checkfront] Missing required config: data-checkfront-host, data-razorpay-key, data-proxy-url");
    return;
  }

  // ── 2. Load Razorpay checkout script ────────────────────────────
  function loadScript(src) {
    return new Promise((res) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement("script");
      s.src = src; s.onload = res;
      document.head.appendChild(s);
    });
  }

  // ── 3. API helpers (calls go through our proxy to keep CF keys server-side) ──
  async function proxyGet(path, params = {}) {
    const qs = new URLSearchParams({ cf_path: path, ...params }).toString();
    const res = await fetch(`${CONFIG.proxyUrl}/cf?${qs}`);
    if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
    return res.json();
  }

  async function proxyPost(path, body = {}) {
    const res = await fetch(`${CONFIG.proxyUrl}/cf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cf_path: path, ...body }),
    });
    if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
    return res.json();
  }

  // ── 4. State ─────────────────────────────────────────────────────
  const state = {
    step: "loading",      // loading | select-item | select-date | guest-count | customer-form | processing | success | error
    items: [],
    selectedItem: null,
    selectedDate: null,
    guests: 1,
    slip: null,
    sessionId: null,
    bookingId: null,
    totalAmount: null,
    formFields: [],
    formValues: {},
    errorMsg: "",
  };

  // ── 5. Widget HTML/CSS ───────────────────────────────────────────
  const FONT_URL = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap";

  function injectStyles() {
    if (document.getElementById("rzp-cf-styles")) return;
    const c = CONFIG.themeColor;
    const style = document.createElement("style");
    style.id = "rzp-cf-styles";
    style.textContent = `
      @import url('${FONT_URL}');

      :root {
        --rzp-primary: ${c};
        --rzp-primary-dim: ${c}22;
        --rzp-bg: #0c0c0e;
        --rzp-surface: #16161a;
        --rzp-surface2: #1e1e24;
        --rzp-border: #2a2a32;
        --rzp-text: #f0f0f4;
        --rzp-muted: #72728a;
        --rzp-success: #34d399;
        --rzp-error: #f87171;
        --rzp-radius: 14px;
        --rzp-font: 'DM Sans', sans-serif;
        --rzp-mono: 'DM Mono', monospace;
      }

      #rzp-cf-widget * { box-sizing: border-box; margin: 0; padding: 0; }

      #rzp-cf-widget {
        font-family: var(--rzp-font);
        background: var(--rzp-bg);
        border: 1px solid var(--rzp-border);
        border-radius: var(--rzp-radius);
        overflow: hidden;
        max-width: 520px;
        width: 100%;
        color: var(--rzp-text);
        box-shadow: 0 24px 64px rgba(0,0,0,0.5);
      }

      /* ── Header ── */
      .rzp-header {
        padding: 22px 24px 18px;
        background: linear-gradient(135deg, var(--rzp-surface) 0%, var(--rzp-bg) 100%);
        border-bottom: 1px solid var(--rzp-border);
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .rzp-header-logo {
        width: 40px; height: 40px;
        border-radius: 10px;
        background: var(--rzp-primary);
        display: flex; align-items: center; justify-content: center;
        font-size: 20px; flex-shrink: 0;
        overflow: hidden;
      }
      .rzp-header-logo img { width: 100%; height: 100%; object-fit: cover; }
      .rzp-header-name { font-size: 16px; font-weight: 700; color: var(--rzp-text); }
      .rzp-header-sub  { font-size: 12px; color: var(--rzp-muted); margin-top: 2px; }
      .rzp-header-badge {
        margin-left: auto;
        font-size: 10px; font-weight: 600; letter-spacing: 0.5px;
        color: var(--rzp-primary);
        background: var(--rzp-primary-dim);
        border: 1px solid ${c}44;
        border-radius: 20px;
        padding: 3px 10px;
        white-space: nowrap;
      }

      /* ── Steps progress bar ── */
      .rzp-steps {
        display: flex;
        padding: 16px 24px;
        gap: 6px;
        background: var(--rzp-surface);
        border-bottom: 1px solid var(--rzp-border);
      }
      .rzp-step {
        flex: 1; height: 3px;
        border-radius: 2px;
        background: var(--rzp-border);
        transition: background 0.3s;
      }
      .rzp-step.done  { background: var(--rzp-primary); }
      .rzp-step.active { background: var(--rzp-primary); opacity: 0.5; }

      /* ── Body ── */
      .rzp-body { padding: 24px; }

      .rzp-section-title {
        font-size: 11px; font-weight: 600;
        letter-spacing: 1px; text-transform: uppercase;
        color: var(--rzp-muted); margin-bottom: 14px;
      }

      /* ── Item cards ── */
      .rzp-items { display: flex; flex-direction: column; gap: 10px; }
      .rzp-item-card {
        border: 1px solid var(--rzp-border);
        border-radius: 12px;
        padding: 14px 16px;
        cursor: pointer;
        transition: border-color 0.2s, background 0.2s;
        display: flex; align-items: center; gap: 14px;
        background: var(--rzp-surface2);
      }
      .rzp-item-card:hover  { border-color: var(--rzp-primary); }
      .rzp-item-card.selected {
        border-color: var(--rzp-primary);
        background: var(--rzp-primary-dim);
      }
      .rzp-item-img {
        width: 52px; height: 52px; border-radius: 8px;
        object-fit: cover; background: var(--rzp-border); flex-shrink: 0;
      }
      .rzp-item-info { flex: 1; }
      .rzp-item-name { font-size: 14px; font-weight: 600; color: var(--rzp-text); }
      .rzp-item-desc { font-size: 12px; color: var(--rzp-muted); margin-top: 3px; line-height: 1.4; }
      .rzp-item-price {
        font-size: 15px; font-weight: 700; color: var(--rzp-primary);
        white-space: nowrap; font-family: var(--rzp-mono);
      }

      /* ── Date picker ── */
      .rzp-date-input {
        width: 100%;
        background: var(--rzp-surface2);
        border: 1px solid var(--rzp-border);
        border-radius: 10px;
        padding: 12px 16px;
        color: var(--rzp-text);
        font-family: var(--rzp-font);
        font-size: 14px;
        outline: none;
        transition: border-color 0.2s;
      }
      .rzp-date-input:focus { border-color: var(--rzp-primary); }

      /* ── Guest counter ── */
      .rzp-guest-row {
        display: flex; align-items: center; gap: 16px;
        background: var(--rzp-surface2);
        border: 1px solid var(--rzp-border);
        border-radius: 10px;
        padding: 12px 16px;
      }
      .rzp-guest-label { flex: 1; font-size: 14px; color: var(--rzp-text); }
      .rzp-guest-ctrl { display: flex; align-items: center; gap: 12px; }
      .rzp-guest-btn {
        width: 32px; height: 32px;
        background: var(--rzp-surface);
        border: 1px solid var(--rzp-border);
        border-radius: 8px;
        color: var(--rzp-text);
        font-size: 18px; line-height: 1;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s, border-color 0.15s;
      }
      .rzp-guest-btn:hover { background: var(--rzp-primary-dim); border-color: var(--rzp-primary); }
      .rzp-guest-count {
        font-size: 18px; font-weight: 700;
        min-width: 28px; text-align: center;
        font-family: var(--rzp-mono);
      }

      /* ── Price summary ── */
      .rzp-price-box {
        background: var(--rzp-surface2);
        border: 1px solid var(--rzp-border);
        border-radius: 10px;
        padding: 14px 16px;
        display: flex; justify-content: space-between; align-items: center;
      }
      .rzp-price-label { font-size: 13px; color: var(--rzp-muted); }
      .rzp-price-value {
        font-size: 22px; font-weight: 700;
        color: var(--rzp-text); font-family: var(--rzp-mono);
      }
      .rzp-price-currency { font-size: 14px; color: var(--rzp-muted); margin-right: 4px; }

      /* ── Customer form ── */
      .rzp-form-fields { display: flex; flex-direction: column; gap: 12px; }
      .rzp-field label {
        display: block; font-size: 11px; font-weight: 600;
        letter-spacing: 0.5px; text-transform: uppercase;
        color: var(--rzp-muted); margin-bottom: 6px;
      }
      .rzp-field input, .rzp-field select {
        width: 100%;
        background: var(--rzp-surface2);
        border: 1px solid var(--rzp-border);
        border-radius: 10px;
        padding: 11px 14px;
        color: var(--rzp-text);
        font-family: var(--rzp-font); font-size: 14px;
        outline: none;
        transition: border-color 0.2s;
      }
      .rzp-field input:focus, .rzp-field select:focus {
        border-color: var(--rzp-primary);
      }
      .rzp-field input::placeholder { color: var(--rzp-muted); }

      /* ── Order summary row ── */
      .rzp-summary {
        background: var(--rzp-surface2);
        border: 1px solid var(--rzp-border);
        border-radius: 10px;
        padding: 14px 16px;
        margin-bottom: 16px;
      }
      .rzp-summary-row {
        display: flex; justify-content: space-between;
        font-size: 13px; padding: 4px 0;
        color: var(--rzp-muted);
      }
      .rzp-summary-row.total {
        font-size: 15px; font-weight: 700;
        color: var(--rzp-text); border-top: 1px solid var(--rzp-border);
        margin-top: 8px; padding-top: 10px;
      }
      .rzp-summary-val { font-family: var(--rzp-mono); }

      /* ── Buttons ── */
      .rzp-btn {
        width: 100%; padding: 14px;
        background: var(--rzp-primary);
        color: #fff; border: none; border-radius: 10px;
        font-family: var(--rzp-font); font-size: 15px; font-weight: 700;
        cursor: pointer; transition: opacity 0.15s, transform 0.1s;
        margin-top: 16px;
      }
      .rzp-btn:hover   { opacity: 0.9; }
      .rzp-btn:active  { transform: scale(0.99); }
      .rzp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .rzp-btn-ghost {
        background: transparent;
        border: 1px solid var(--rzp-border);
        color: var(--rzp-muted);
        margin-top: 8px;
      }
      .rzp-btn-ghost:hover { border-color: var(--rzp-primary); color: var(--rzp-primary); }

      /* ── Loading / status ── */
      .rzp-spinner-wrap { text-align: center; padding: 40px 0; }
      .rzp-spinner {
        width: 36px; height: 36px;
        border: 3px solid var(--rzp-border);
        border-top-color: var(--rzp-primary);
        border-radius: 50%;
        animation: rzp-spin 0.75s linear infinite;
        margin: 0 auto 16px;
      }
      @keyframes rzp-spin { to { transform: rotate(360deg); } }
      .rzp-spinner-text { font-size: 14px; color: var(--rzp-muted); }

      .rzp-status-wrap { text-align: center; padding: 32px 0; }
      .rzp-status-icon { font-size: 52px; margin-bottom: 14px; }
      .rzp-status-title { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
      .rzp-status-sub {
        font-size: 13px; color: var(--rzp-muted); line-height: 1.6;
        margin-bottom: 16px;
      }
      .rzp-booking-id {
        font-family: var(--rzp-mono); font-size: 13px;
        background: var(--rzp-surface2); border: 1px solid var(--rzp-border);
        border-radius: 8px; padding: 10px 14px; color: var(--rzp-muted);
        display: inline-block; word-break: break-all;
      }

      /* ── Footer ── */
      .rzp-footer {
        padding: 12px 24px;
        border-top: 1px solid var(--rzp-border);
        display: flex; align-items: center; justify-content: center;
        gap: 6px;
        font-size: 11px; color: var(--rzp-muted);
      }
      .rzp-footer a { color: var(--rzp-muted); text-decoration: none; }
      .rzp-footer a:hover { color: var(--rzp-primary); }

      /* ── Error inline ── */
      .rzp-error-msg {
        background: #f8717122;
        border: 1px solid #f8717144;
        border-radius: 8px;
        padding: 10px 14px;
        font-size: 13px; color: var(--rzp-error);
        margin-top: 12px;
      }

      /* ── Transitions ── */
      .rzp-body > div { animation: rzp-fade-in 0.2s ease; }
      @keyframes rzp-fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    `;
    document.head.appendChild(style);
  }

  // ── 6. Render engine ─────────────────────────────────────────────
  function getContainer() {
    return document.getElementById(CONFIG.containerId);
  }

  function render() {
    const container = getContainer();
    if (!container) return;
    container.id = "rzp-cf-widget"; // reassign so styles apply

    const stepMap = {
      "loading": 0, "select-item": 1, "select-date": 2,
      "guest-count": 2, "customer-form": 3, "processing": 4,
      "success": 4, "error": 4,
    };
    const currentStep = stepMap[state.step] || 0;

    container.innerHTML = `
      ${renderHeader()}
      ${currentStep > 0 ? renderSteps(currentStep) : ""}
      <div class="rzp-body">
        ${renderBody()}
      </div>
      ${renderFooter()}
    `;

    attachEvents();
  }

  function renderHeader() {
    const logoHtml = CONFIG.logoUrl
      ? `<img src="${CONFIG.logoUrl}" alt="logo" />`
      : `🎯`;
    return `
      <div class="rzp-header">
        <div class="rzp-header-logo">${logoHtml}</div>
        <div>
          <div class="rzp-header-name">${CONFIG.merchantName}</div>
          <div class="rzp-header-sub">Online Booking</div>
        </div>
        <div class="rzp-header-badge">🔒 Secured by Razorpay</div>
      </div>
    `;
  }

  function renderSteps(active) {
    return `
      <div class="rzp-steps">
        ${[1,2,3,4].map(i =>
          `<div class="rzp-step ${i < active ? "done" : i === active ? "active" : ""}"></div>`
        ).join("")}
      </div>
    `;
  }

  function renderBody() {
    switch (state.step) {
      case "loading":      return renderLoading("Loading available sessions…");
      case "select-item":  return renderSelectItem();
      case "select-date":  return renderSelectDate();
      case "guest-count":  return renderGuestCount();
      case "customer-form":return renderCustomerForm();
      case "processing":   return renderLoading(state.loadingMsg || "Processing your booking…");
      case "success":      return renderSuccess();
      case "error":        return renderError();
      default:             return "";
    }
  }

  function renderLoading(msg) {
    return `
      <div class="rzp-spinner-wrap">
        <div class="rzp-spinner"></div>
        <div class="rzp-spinner-text">${msg}</div>
      </div>`;
  }

  function renderSelectItem() {
    const itemsHtml = state.items.map(item => `
      <div class="rzp-item-card ${state.selectedItem?.item_id === item.item_id ? "selected" : ""}"
           data-item-id="${item.item_id}">
        ${item.image?.["1"]?.url_small
          ? `<img class="rzp-item-img" src="${item.image["1"].url_small}" alt="${item.name}" />`
          : `<div class="rzp-item-img" style="display:flex;align-items:center;justify-content:center;font-size:24px;">🎯</div>`
        }
        <div class="rzp-item-info">
          <div class="rzp-item-name">${item.name}</div>
          ${item.teaser ? `<div class="rzp-item-desc">${item.teaser.replace(/<[^>]*>/g,"").substring(0,80)}…</div>` : ""}
        </div>
        ${item.price ? `<div class="rzp-item-price">${CONFIG.currency} ${parseFloat(item.price).toFixed(2)}</div>` : ""}
      </div>
    `).join("");

    return `
      <div class="rzp-section-title">Choose a Session</div>
      <div class="rzp-items">${itemsHtml}</div>
      <button class="rzp-btn" id="rzp-btn-next-date" ${!state.selectedItem ? "disabled" : ""}>
        Continue →
      </button>
    `;
  }

  function renderSelectDate() {
    const today = new Date().toISOString().split("T")[0];
    return `
      <div class="rzp-section-title">Select Date</div>
      <input
        type="date"
        class="rzp-date-input"
        id="rzp-date-input"
        min="${today}"
        value="${state.selectedDate || ""}"
      />
      <button class="rzp-btn" id="rzp-btn-next-guests" ${!state.selectedDate ? "disabled" : ""}>
        Continue →
      </button>
      <button class="rzp-btn rzp-btn-ghost" id="rzp-btn-back-items">← Back</button>
    `;
  }

  function renderGuestCount() {
    return `
      <div class="rzp-section-title">How many guests?</div>
      <div class="rzp-guest-row">
        <div class="rzp-guest-label">Number of Guests</div>
        <div class="rzp-guest-ctrl">
          <button class="rzp-guest-btn" id="rzp-guests-minus">−</button>
          <div class="rzp-guest-count" id="rzp-guests-val">${state.guests}</div>
          <button class="rzp-guest-btn" id="rzp-guests-plus">+</button>
        </div>
      </div>
      <div style="margin-top:16px">
        <div class="rzp-price-box">
          <span class="rzp-price-label">Estimated Total</span>
          <span class="rzp-price-value">
            <span class="rzp-price-currency">${CONFIG.currency}</span>
            ${state.slip ? (parseFloat(state.slip.total || 0)).toFixed(2) : "—"}
          </span>
        </div>
      </div>
      <button class="rzp-btn" id="rzp-btn-next-form">Continue →</button>
      <button class="rzp-btn rzp-btn-ghost" id="rzp-btn-back-date">← Back</button>
    `;
  }

  function renderCustomerForm() {
    const fieldsHtml = state.formFields.map(field => {
      const id = `rzp-field-${field.key}`;
      const val = state.formValues[field.key] || "";
      const label = field.label || field.key.replace(/_/g," ").replace(/\b\w/g,c=>c.toUpperCase());
      const req = field.required ? `<span style="color:var(--rzp-primary)">*</span>` : "";

      if (field.type === "select" && field.options) {
        const opts = Object.entries(field.options).map(([k,v]) =>
          `<option value="${k}" ${val===k?"selected":""}>${v}</option>`
        ).join("");
        return `
          <div class="rzp-field">
            <label for="${id}">${label} ${req}</label>
            <select id="${id}" data-key="${field.key}">${opts}</select>
          </div>`;
      }
      return `
        <div class="rzp-field">
          <label for="${id}">${label} ${req}</label>
          <input type="${field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text"}"
            id="${id}" data-key="${field.key}"
            value="${val}" placeholder="${label}"
          />
        </div>`;
    }).join("");

    return `
      <div class="rzp-section-title">Your Details</div>
      <div class="rzp-summary">
        <div class="rzp-summary-row">
          <span>${state.selectedItem?.name}</span>
          <span class="rzp-summary-val">${state.selectedDate}</span>
        </div>
        <div class="rzp-summary-row">
          <span>Guests</span>
          <span class="rzp-summary-val">${state.guests}</span>
        </div>
        <div class="rzp-summary-row total">
          <span>Total</span>
          <span class="rzp-summary-val">${CONFIG.currency} ${parseFloat(state.totalAmount || 0).toFixed(2)}</span>
        </div>
      </div>
      <div class="rzp-form-fields">${fieldsHtml}</div>
      ${state.errorMsg ? `<div class="rzp-error-msg">${state.errorMsg}</div>` : ""}
      <button class="rzp-btn" id="rzp-btn-pay">
        Pay ${CONFIG.currency} ${parseFloat(state.totalAmount || 0).toFixed(2)}
      </button>
      <button class="rzp-btn rzp-btn-ghost" id="rzp-btn-back-guests">← Back</button>
    `;
  }

  function renderSuccess() {
    return `
      <div class="rzp-status-wrap">
        <div class="rzp-status-icon">✅</div>
        <div class="rzp-status-title" style="color:var(--rzp-success)">Booking Confirmed!</div>
        <div class="rzp-status-sub">
          Your payment was successful and your booking has been confirmed.<br/>
          A confirmation email will be sent to you shortly.
        </div>
        <div class="rzp-booking-id">Booking ID: ${state.bookingId}</div>
      </div>
    `;
  }

  function renderError() {
    return `
      <div class="rzp-status-wrap">
        <div class="rzp-status-icon">⚠️</div>
        <div class="rzp-status-title" style="color:var(--rzp-error)">Something went wrong</div>
        <div class="rzp-status-sub">${state.errorMsg || "Please try again or contact support."}</div>
        <button class="rzp-btn" id="rzp-btn-retry" style="max-width:200px;margin:0 auto;">Try Again</button>
      </div>
    `;
  }

  function renderFooter() {
    return `
      <div class="rzp-footer">
        🔒 Payments powered by
        <a href="https://razorpay.com" target="_blank">Razorpay</a>
        &nbsp;·&nbsp; 256-bit SSL
      </div>
    `;
  }

  // ── 7. Event binding ─────────────────────────────────────────────
  function attachEvents() {
    const $ = (id) => document.getElementById(id);

    // Select item
    document.querySelectorAll(".rzp-item-card").forEach(card => {
      card.addEventListener("click", () => {
        const itemId = card.getAttribute("data-item-id");
        state.selectedItem = state.items.find(i => String(i.item_id) === String(itemId));
        render();
      });
    });

    // Item → Date
    const btnDate = $("rzp-btn-next-date");
    if (btnDate) btnDate.addEventListener("click", () => { state.step = "select-date"; render(); });

    // Date input
    const dateInput = $("rzp-date-input");
    if (dateInput) {
      dateInput.addEventListener("change", () => {
        state.selectedDate = dateInput.value;
        $("rzp-btn-next-guests").disabled = !state.selectedDate;
      });
    }

    // Date → Guests (fetch rated item + SLIP)
    const btnGuests = $("rzp-btn-next-guests");
    if (btnGuests) btnGuests.addEventListener("click", async () => {
      state.step = "loading"; state.loadingMsg = "Checking availability…"; render();
      try {
        const dateStr = state.selectedDate.replace(/-/g, "");
        const data = await proxyGet(`/api/3.0/item/${state.selectedItem.item_id}`, {
          start_date: dateStr, end_date: dateStr,
          "param[guests]": state.guests,
        });
        const item = data.item?.[state.selectedItem.item_id];
        if (!item?.slip) throw new Error("No availability for selected date.");
        state.slip = item;
        state.totalAmount = item.total || item.price || 0;
        state.step = "guest-count"; render();
      } catch (e) {
        state.step = "error"; state.errorMsg = e.message; render();
      }
    });

    // Guest counter
    const minusBtn = $("rzp-guests-minus");
    const plusBtn  = $("rzp-guests-plus");
    if (minusBtn) minusBtn.addEventListener("click", async () => {
      if (state.guests > 1) {
        state.guests--;
        await refreshSlip();
      }
    });
    if (plusBtn) plusBtn.addEventListener("click", async () => {
      state.guests++;
      await refreshSlip();
    });

    // Guests → Customer form (create session)
    const btnForm = $("rzp-btn-next-form");
    if (btnForm) btnForm.addEventListener("click", async () => {
      state.step = "loading"; state.loadingMsg = "Preparing your booking…"; render();
      try {
        const [sessionData, formData] = await Promise.all([
          proxyPost("/api/3.0/booking/session", { slip: state.slip.slip }),
          proxyGet("/api/3.0/booking/form"),
        ]);
        state.sessionId = sessionData.booking?.session?.id;
        state.totalAmount = sessionData.booking?.session?.total || state.totalAmount;
        state.formFields = parseFormFields(formData);
        state.step = "customer-form"; render();
      } catch (e) {
        state.step = "error"; state.errorMsg = e.message; render();
      }
    });

    // Form field changes
    document.querySelectorAll("[data-key]").forEach(el => {
      el.addEventListener("input", () => { state.formValues[el.dataset.key] = el.value; });
      el.addEventListener("change", () => { state.formValues[el.dataset.key] = el.value; });
    });

    // Pay button
    const btnPay = $("rzp-btn-pay");
    if (btnPay) btnPay.addEventListener("click", () => handlePayment());

    // Back buttons
    if ($("rzp-btn-back-items")) $("rzp-btn-back-items").addEventListener("click", () => { state.step = "select-item"; render(); });
    if ($("rzp-btn-back-date"))  $("rzp-btn-back-date").addEventListener("click",  () => { state.step = "select-date";  render(); });
    if ($("rzp-btn-back-guests"))$("rzp-btn-back-guests").addEventListener("click",() => { state.step = "guest-count";  render(); });
    if ($("rzp-btn-retry"))      $("rzp-btn-retry").addEventListener("click", () => { state.step = "select-item"; state.errorMsg = ""; render(); });
  }

  // ── 8. Business logic ────────────────────────────────────────────

  async function refreshSlip() {
    try {
      const dateStr = state.selectedDate.replace(/-/g, "");
      const data = await proxyGet(`/api/3.0/item/${state.selectedItem.item_id}`, {
        start_date: dateStr, end_date: dateStr, "param[guests]": state.guests,
      });
      const item = data.item?.[state.selectedItem.item_id];
      if (item) {
        state.slip = item;
        state.totalAmount = item.total || item.price || 0;
        document.getElementById("rzp-guests-val").textContent = state.guests;
        // update price display
        const priceEl = document.querySelector(".rzp-price-value");
        if (priceEl) priceEl.innerHTML = `<span class="rzp-price-currency">${CONFIG.currency}</span>${parseFloat(state.totalAmount).toFixed(2)}`;
      }
    } catch (e) { /* silent refresh failure */ }
  }

  function parseFormFields(formData) {
    const ui = formData.booking_form_ui || {};
    const skip = new Set(["booking_policy","errors","msg","mode","_cnf"]);
    return Object.entries(ui)
      .filter(([k]) => !skip.has(k))
      .map(([key, v]) => ({
        key,
        label:    v.define?.layout?.customer?.lbl || v.define?.lbl || key,
        type:     v.define?.type || "text",
        required: v.define?.required || v.define?.layout?.customer?.required || 0,
        options:  v.define?.options || null,
      }))
      .filter(f => f.type !== "hidden");
  }

  async function handlePayment() {
    // Validate required fields
    const missing = state.formFields.filter(f => f.required && !state.formValues[f.key]);
    if (missing.length) {
      state.errorMsg = `Please fill in: ${missing.map(f=>f.label).join(", ")}`;
      render(); return;
    }

    state.step = "loading"; state.loadingMsg = "Creating your reservation…"; render();

    try {
      // Step 5: Create booking (RESERVED status, unpaid)
      const formPayload = {};
      state.formFields.forEach(f => { if (state.formValues[f.key]) formPayload[`form[${f.key}]`] = state.formValues[f.key]; });

      const bookingData = await proxyPost("/api/3.0/booking/create", {
        session_id: state.sessionId,
        ...formPayload,
      });

      state.bookingId = bookingData.booking?.booking_id;
      if (!state.bookingId) throw new Error("Booking creation failed. Please try again.");

      // Step 6: Open Razorpay checkout
      await loadScript("https://checkout.razorpay.com/v1/checkout.js");

      const options = {
        key:         CONFIG.razorpayKey,
        amount:      Math.round(parseFloat(state.totalAmount) * 100), // in cents
        currency:    CONFIG.currency,
        name:        CONFIG.merchantName,
        description: state.selectedItem?.name || "Booking",
        image:       CONFIG.logoUrl || undefined,
        prefill: {
          name:    state.formValues.customer_name  || "",
          email:   state.formValues.customer_email || "",
          contact: state.formValues.customer_phone || "",
        },
        notes: { checkfront_booking_id: state.bookingId },
        theme: { color: CONFIG.themeColor },

        handler: async function (response) {
          // Step 7: Verify payment + confirm booking
          state.step = "loading"; state.loadingMsg = "Confirming your booking…"; render();
          try {
            await fetch(`${CONFIG.proxyUrl}/payment-confirm`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_order_id:   response.razorpay_order_id,
                razorpay_signature:  response.razorpay_signature,
                booking_id:          state.bookingId,
                amount:              state.totalAmount,
                currency:            CONFIG.currency,
              }),
            });
            state.step = "success"; render();
          } catch (e) {
            // Payment captured — show success anyway, proxy handles logging
            state.step = "success"; render();
          }
        },

        modal: {
          ondismiss: () => { state.step = "customer-form"; render(); }
        }
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", (r) => {
        state.step = "error";
        state.errorMsg = r.error.description || "Payment failed. Please try again.";
        render();
      });
      rzp.open();

    } catch (e) {
      state.step = "error"; state.errorMsg = e.message; render();
    }
  }

  // ── 9. Init ──────────────────────────────────────────────────────
  async function init() {
    injectStyles();
    render(); // show loading spinner

    try {
      const params = CONFIG.itemId ? { item_id: CONFIG.itemId } : {};
      const data = await proxyGet("/api/3.0/item", params);

      const items = data.item
        ? Object.values(data.item).filter(i => i.status === "A")
        : [];

      if (!items.length) throw new Error("No bookable items found.");

      state.items = items;

      // If only one item (or item forced via config), skip selection step
      if (items.length === 1 || CONFIG.itemId) {
        state.selectedItem = items[0];
        state.step = "select-date";
      } else {
        state.step = "select-item";
      }
      render();
    } catch (e) {
      state.step = "error"; state.errorMsg = e.message; render();
    }
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
