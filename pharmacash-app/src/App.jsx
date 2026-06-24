import { useState, useEffect } from "react";

// ─── SUPABASE ────────────────────────────────────────────────────────────────
const SUPA_URL = "https://ahpbjjtwzrzxcizdzfyq.supabase.co";
const SUPA_KEY = "sb_publishable_liQ3XVA1Z9f6vW4QqiAOgQ_hIWNSonX";

const supa = {
  async get(table, filters = {}) {
    let url = `${SUPA_URL}/rest/v1/${table}?select=*&order=created_at.desc`;
    Object.entries(filters).forEach(([k, v]) => { url += `&${k}=eq.${v}`; });
    const r = await fetch(url, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async insert(table, data) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async update(table, id, data) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async delete(table, id) {
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "DELETE",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    if (!r.ok) throw new Error(await r.text());
  },
};

// Cache local pour mode hors ligne
const CACHE_KEY = "pharmacash_cache_v3";
const saveCache = (d) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch {} };
const loadCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; } };

// File d'attente hors ligne
const QUEUE_KEY = "pharmacash_queue";
const loadQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; } };
const saveQueue = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {} };
const pushQueue = (op) => { const q = loadQueue(); q.push(op); saveQueue(q); };

const DOTATION_MONNAIE = 300000; // FCFA

// ─── CONFIG ALERTES ───────────────────────────────────────────────────────────
const ALERT_EMAIL     = "phcie.bethesda.sangouine@gmail.com";
const ALERT_SEUIL_CAISSE = 300000;   // FCFA — alerte si solde < ce montant
const ALERT_DEPOT_JOURS  = 5;        // jours sans versement avant alerte
const ALERTS_SENT_KEY    = "pharmacash_alerts_sent"; // cache local alertes déjà envoyées

// Charger/sauver les alertes déjà envoyées (évite doublons)
const loadAlertsSent = () => { try { return JSON.parse(localStorage.getItem(ALERTS_SENT_KEY)) || {}; } catch { return {}; } };
const markAlertSent  = (key) => { const a = loadAlertsSent(); a[key] = new Date().toISOString(); localStorage.setItem(ALERTS_SENT_KEY, JSON.stringify(a)); };
const wasAlertSent   = (key) => !!loadAlertsSent()[key];

// Envoi email via Resend (clé API publique)
async function sendAlertEmail(subject, html) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Clé Resend à configurer — placeholder pour l'instant
        "Authorization": "Bearer re_C6v5drjX_NCZH7bKVdQ6bjv6LTPxmDydk",
      },
      body: JSON.stringify({
        from: "PharmaCash Alertes <alertes@pharmacash.app>",
        to: [ALERT_EMAIL],
        subject,
        html,
      }),
    });
    return res.ok;
  } catch { return false; }
}

// Vérifier et envoyer les alertes nécessaires
async function checkAndSendAlerts(data, soldes) {
  const t = today();

  // ── Alerte solde caisse bas ──────────────────────────────────────────────
  const alertKeyC = `caisse_basse_${t}`;
  if (soldes.soldeEspeces < ALERT_SEUIL_CAISSE && !wasAlertSent(alertKeyC)) {
    const ok = await sendAlertEmail(
      "⚠️ PharmaCash — Solde caisse bas",
      `<h2 style="color:#dc2626">⚠️ Alerte Solde Caisse</h2>
      <p>Le solde de la caisse espèces est descendu sous le seuil minimum.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:8px;background:#fef2f2"><b>Solde actuel</b></td><td style="padding:8px;color:#dc2626;font-size:20px"><b>\${new Intl.NumberFormat('fr-FR').format(Math.round(soldes.soldeEspeces))} FCFA</b></td></tr>
        <tr><td style="padding:8px;background:#fef2f2"><b>Seuil minimum</b></td><td style="padding:8px">\${new Intl.NumberFormat('fr-FR').format(ALERT_SEUIL_CAISSE)} FCFA</td></tr>
        <tr><td style="padding:8px;background:#fef2f2"><b>Date</b></td><td style="padding:8px">\${new Date().toLocaleDateString('fr-FR')}</td></tr>
      </table>
      <p style="margin-top:16px;color:#6b7280">Ceci est une alerte automatique de PharmaCash.</p>`
    );
    if (ok) markAlertSent(alertKeyC);
  }

  // ── Alertes dépôts sans versement ────────────────────────────────────────
  for (const depot of (data.depots || [])) {
    const alertKeyD = `depot_\${depot.id}_\${t}`;
    if (wasAlertSent(alertKeyD)) continue;

    // Dernier versement de ce dépôt
    const versements = (data.verseDepots || []).filter(v => v.depotId === depot.id);
    let joursDepuis = ALERT_DEPOT_JOURS + 1; // par défaut > seuil si jamais versé
    if (versements.length > 0) {
      const dernierDate = versements.map(v => v.date).sort().reverse()[0];
      const diff = (new Date(t) - new Date(dernierDate)) / (1000 * 60 * 60 * 24);
      joursDepuis = Math.floor(diff);
    }

    if (joursDepuis >= ALERT_DEPOT_JOURS) {
      const ok = await sendAlertEmail(
        `⚠️ PharmaCash — \${depot.nom} : aucun versement depuis \${joursDepuis} jours`,
        `<h2 style="color:#ea580c">⚠️ Alerte Versement Dépôt</h2>
        <p>Le dépôt suivant n'a pas effectué de versement depuis <b>\${joursDepuis} jour(s)</b>.</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;background:#fff7ed"><b>Dépôt</b></td><td style="padding:8px"><b>\${depot.nom}</b> (\${depot.localite})</td></tr>
          <tr><td style="padding:8px;background:#fff7ed"><b>Derniers versements</b></td><td style="padding:8px">\${versements.length === 0 ? "Aucun versement enregistré" : "Dernier : " + new Date(versements.map(v=>v.date).sort().reverse()[0]).toLocaleDateString('fr-FR')}</td></tr>
          <tr><td style="padding:8px;background:#fff7ed"><b>Jours écoulés</b></td><td style="padding:8px;color:#dc2626"><b>\${joursDepuis} jour(s)</b></td></tr>
          <tr><td style="padding:8px;background:#fff7ed"><b>Date vérification</b></td><td style="padding:8px">\${new Date().toLocaleDateString('fr-FR')}</td></tr>
        </table>
        <p style="margin-top:16px;color:#6b7280">Ceci est une alerte automatique de PharmaCash.</p>`
      );
      if (ok) markAlertSent(alertKeyD);
    }
  }
}

// Structure vide — données chargées depuis Supabase
const EMPTY_DATA = {
  users: [], depots: [], recettes: [], clients: [],
  recouvrements: [], encaissementsDivers: [],
  versementsBanque: [], verseDepots: [],
  depenses: [], dotationHistory: [],
  responsables: [],
  connexions: [], // { id, user_id, user_name, role, date, heure, navigateur }
  clotures: [], // { id, date, tranche, caissiere, montantTheorique, montantPhysique, ecart, note }
};

// Normalisation snake_case → camelCase depuis Supabase
const norm = {
  users: (r) => ({ id:r.id, name:r.name, email:r.email, password:r.password, role:r.role }),
  depots: (r) => ({ id:r.id, nom:r.nom, localite:r.localite }),
  recettes: (r) => ({ id:r.id, date:r.date, tranche:r.tranche, caissiere:r.caissiere, source:r.source, montant:Number(r.montant), mode:r.mode, note:r.note||"" }),
  clients: (r) => ({ id:r.id, nom:r.nom, telephone:r.telephone||"", adresse:r.adresse||"", encours:Number(r.encours||0) }),
  recouvrements: (r) => ({ id:r.id, clientId:r.client_id, date:r.date, montant:Number(r.montant), mode:r.mode, note:r.note||"" }),
  encaissementsDivers: (r) => ({ id:r.id, date:r.date, nom:r.nom, motif:r.motif||"", montant:Number(r.montant), mode:r.mode, note:r.note||"" }),
  versementsBanque: (r) => ({ id:r.id, date:r.date, banque:r.banque||"", bordereau:r.bordereau||"", montant:Number(r.montant), source:r.source||"pharmacie", typeVers:r.type_vers||"especes", note:r.note||"" }),
  verseDepots: (r) => ({ id:r.id, depotId:r.depot_id, date:r.date, montant:Number(r.montant), caissiere:r.caissiere||"", note:r.note||"" }),
  depenses: (r) => ({ id:r.id, date:r.date, categorie:r.categorie, libelle:r.libelle, montant:Number(r.montant), mode:r.mode, note:r.note||"" }),
  dotationHistory: (r) => ({ id:r.id, date:r.date, dest:r.dest, montant:Number(r.montant), note:r.note||"" }),
  responsables: (r) => ({ id:r.id, nom:r.nom, depotId:r.depot_id||null, telephone:r.telephone||"" }),
  connexions: (r) => ({ id:r.id, userId:r.user_id, userName:r.user_name, role:r.role, date:r.date, heure:r.heure, navigateur:r.navigateur||"" }),
  clotures: (r) => ({ id:r.id, date:r.date, tranche:r.tranche, caissiere:r.caissiere||'', montantTheorique:Number(r.montant_theorique||0), montantPhysique:Number(r.montant_physique||0), ecart:Number(r.ecart||0), note:r.note||'' }),
};

// ─── OPÉRATIONS DB ───────────────────────────────────────────────────────────
// Écrire dans Supabase + mettre à jour le state local immédiatement
// En cas d'offline : file d'attente locale
async function dbInsert(table, supaRow, setRaw, raw, localKey, localRow) {
  // Optimistic update
  const updated = { ...raw, [localKey]: [localRow, ...raw[localKey]] };
  setRaw(updated);
  try {
    await supa.insert(table, supaRow);
  } catch {
    pushQueue({ action:"insert", table, data:supaRow });
  }
}

async function dbUpdate(table, id, supaRow, setRaw, raw, localKey, updater) {
  const updated = { ...raw, [localKey]: raw[localKey].map(updater) };
  setRaw(updated);
  try {
    await supa.update(table, id, supaRow);
  } catch {
    pushQueue({ action:"update", table, id, data:supaRow });
  }
}

async function dbDelete(table, id, setRaw, raw, localKey) {
  const updated = { ...raw, [localKey]: raw[localKey].filter(x=>x.id!==id) };
  setRaw(updated);
  try {
    await supa.delete(table, id);
  } catch {
    pushQueue({ action:"delete", table, id });
  }
}

const ROLES = {
  admin:      { label: "Administrateur", color: "#7c3aed", modules: ["dashboard","recettes","recouvrement","versements","depots","depenses","cloture","historique","connexions","utilisateurs"] },
  gerant:     { label: "Gérant",         color: "#0369a1", modules: ["gerant_dashboard","recettes","recouvrement","versements","depots","depenses","historique"] },
  comptable:  { label: "Comptable",      color: "#047857", modules: ["dashboard","versements","depots","depenses","cloture","historique"] },
  caissier:   { label: "Caissier",       color: "#b45309", modules: ["recettes","recouvrement","cloture"] },
};

const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Modes de paiement disponibles partout dans l'app
// Modes de paiement — espèces physiques
const MODES_ESPECES = [
  { value:"especes", label:"💵 Espèces" },
];
// Modes mobile money (restent sur compte téléphonique)
const MODES_MOBILE = [
  { value:"orange_money", label:"🟠 Orange Money", color:"#f97316" },
  { value:"wave",         label:"🔵 Wave",          color:"#0ea5e9" },
  { value:"mtn_money",    label:"🟡 MTN Money",     color:"#eab308" },
  { value:"moov_money",   label:"🟢 Moov Money",    color:"#22c55e" },
];
// Autres modes (carte, chèque, virement — pour dépenses/factures)
const MODES_AUTRES = [
  { value:"carte",    label:"💳 Carte bancaire" },
  { value:"cheque",   label:"📄 Chèque"        },
  { value:"virement", label:"🏦 Virement"      },
];
const MODES = [...MODES_ESPECES, ...MODES_MOBILE, ...MODES_AUTRES];
const MOBILE_MONEY_IDS = MODES_MOBILE.map(m=>m.value);
const modeLabel = (v) => MODES.find(m=>m.value===v)?.label || v || "—";
const modeColor = (v) => MODES_MOBILE.find(m=>m.value===v)?.color || null;
// Espèces physiques (entrent dans la caisse physique)
const isEspeces = (mode) => mode === "especes";
// Mobile money (restent sur compte téléphonique)
const isMobileMoney = (mode) => MOBILE_MONEY_IDS.includes(mode);
const fmt = (n) => new Intl.NumberFormat("fr-FR").format(Math.round(n||0)) + " FCFA";
const fmtDate = (d) => {
  if (!d) return "—";
  // Forcer interprétation en date locale (évite décalage UTC)
  const [y,m,day] = d.split("-");
  return new Date(+y, +m-1, +day).toLocaleDateString("fr-FR");
};
const today = () => {
  const d = new Date();
  // Date locale (pas UTC) pour correspondre à ce que l'utilisateur saisit
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};

// ─── ICONS ───────────────────────────────────────────────────────────────────
const PATHS = {
  dashboard:    "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
  recettes:     "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  recouvrement: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  versements:   "M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z",
  depots:       "M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z",
  depenses:     "M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z",
  factures:     "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  utilisateurs: "M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z",
  logout:       "M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1",
  plus:         "M12 4v16m8-8H4",
  check:        "M5 13l4 4L19 7",
  alert:        "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  menu:         "M4 6h16M4 12h16M4 18h16",
  close:        "M6 18L18 6M6 6l12 12",
  cash:         "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z",
};
const Icon = ({ name, size=18 }) => (
  <svg width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
    <path d={PATHS[name]||""} />
  </svg>
);

// ─── UI ATOMS ────────────────────────────────────────────────────────────────
const Badge = ({ children, color="#6b7280" }) => (
  <span style={{ background:color+"20", color, border:`1px solid ${color}40`, borderRadius:20, padding:"2px 10px", fontSize:12, fontWeight:600 }}>{children}</span>
);

const KpiCard = ({ label, value, sub, color="#0369a1", icon, highlight }) => (
  <div style={{ background:highlight||"#fff", borderRadius:12, padding:"18px 20px", boxShadow:"0 1px 6px #0001", borderLeft:`4px solid ${color}`, display:"flex", flexDirection:"column", gap:6 }}>
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
      <span style={{ fontSize:11, color: highlight?"#fff":"#6b7280", fontWeight:700, textTransform:"uppercase", letterSpacing:0.5 }}>{label}</span>
      <span style={{ color, opacity:0.8 }}><Icon name={icon||"dashboard"} size={20}/></span>
    </div>
    <div style={{ fontSize:21, fontWeight:900, color:highlight?"#fff":"#111" }}>{value}</div>
    {sub && <div style={{ fontSize:12, color:highlight?"#ffffffcc":"#9ca3af" }}>{sub}</div>}
  </div>
);

const Modal = ({ title, onClose, children, wide }) => (
  <div style={{ position:"fixed", inset:0, background:"#0007", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
    <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:wide?680:520, maxHeight:"92vh", overflowY:"auto", boxShadow:"0 24px 80px #0004" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"20px 24px 16px", borderBottom:"1px solid #f0f0f0", position:"sticky", top:0, background:"#fff", zIndex:1 }}>
        <h3 style={{ margin:0, fontSize:17, fontWeight:700 }}>{title}</h3>
        <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:"#6b7280" }}><Icon name="close"/></button>
      </div>
      <div style={{ padding:24 }}>{children}</div>
    </div>
  </div>
);

const Field = ({ label, children, required, half }) => (
  <div style={{ marginBottom:14, width:half?"calc(50% - 6px)":undefined }}>
    <label style={{ display:"block", fontSize:13, fontWeight:600, color:"#374151", marginBottom:5 }}>{label}{required&&" *"}</label>
    {children}
  </div>
);

const Row = ({ children }) => <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>{children}</div>;

const inp = { width:"100%", border:"1.5px solid #e5e7eb", borderRadius:8, padding:"9px 12px", fontSize:14, outline:"none", boxSizing:"border-box" };
const Input = (props) => <input {...props} style={{ ...inp, ...props.style }}/>;
const Select = ({ children, ...props }) => <select {...props} style={{ ...inp, background:"#fff", ...props.style }}>{children}</select>;
const Textarea = (props) => <textarea {...props} rows={2} style={{ ...inp, resize:"vertical", ...props.style }}/>;

const Btn = ({ children, onClick, variant="primary", disabled, style={} }) => {
  const v = { primary:{background:"#0369a1",color:"#fff"}, success:{background:"#047857",color:"#fff"}, danger:{background:"#dc2626",color:"#fff"}, ghost:{background:"#f3f4f6",color:"#374151"}, warn:{background:"#f59e0b",color:"#fff"} };
  return <button onClick={onClick} disabled={disabled} style={{ ...v[variant], border:"none", borderRadius:8, padding:"9px 18px", fontSize:14, fontWeight:600, cursor:disabled?"not-allowed":"pointer", opacity:disabled?0.6:1, ...style }}>{children}</button>;
};

const Table = ({ cols, rows, empty="Aucune donnée" }) => (
  <div style={{ overflowX:"auto" }}>
    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:14 }}>
      <thead>
        <tr style={{ background:"#f8fafc" }}>
          {cols.map((c,i) => <th key={i} style={{ padding:"10px 14px", textAlign:"left", fontWeight:700, color:"#374151", borderBottom:"2px solid #e5e7eb", whiteSpace:"nowrap" }}>{c}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.length===0
          ? <tr><td colSpan={cols.length} style={{ padding:32, textAlign:"center", color:"#9ca3af" }}>{empty}</td></tr>
          : rows.map((r,i) => (
            <tr key={i} style={{ borderBottom:"1px solid #f0f0f0", background:i%2?"#fafafa":"#fff" }}>
              {r.map((c,j) => <td key={j} style={{ padding:"9px 14px", color:"#374151" }}>{c}</td>)}
            </tr>
          ))}
      </tbody>
    </table>
  </div>
);

// Boutons modifier/supprimer pour admin
const EditDeleteBtns = ({ onEdit, onDelete, isAdmin }) => {
  if (!isAdmin) return null;
  return (
    <div style={{ display:"flex", gap:4 }}>
      {onEdit && <button onClick={onEdit} style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:6, padding:"3px 8px", cursor:"pointer", fontSize:12, color:"#1d4ed8" }}>✏️</button>}
      {onDelete && <button onClick={onDelete} style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, padding:"3px 8px", cursor:"pointer", fontSize:12, color:"#dc2626" }}>🗑️</button>}
    </div>
  );
};

const Divider = ({ label }) => (
  <div style={{ display:"flex", alignItems:"center", gap:10, margin:"20px 0 14px" }}>
    <div style={{ flex:1, height:1, background:"#e5e7eb" }}/>
    <span style={{ fontSize:12, fontWeight:700, color:"#9ca3af", textTransform:"uppercase", whiteSpace:"nowrap" }}>{label}</span>
    <div style={{ flex:1, height:1, background:"#e5e7eb" }}/>
  </div>
);

// ─── SOLDE CAISSE (calcul temps réel) ────────────────────────────────────────
// Logique :
//   Dotation monnaie (constante 300 000)
// + Recettes pharmacie encaissées en espèces (non versées banque)
// + Versements dépôts reçus
// + Recouvrements clients encaissés
// - Dépenses cash
// - Versements banque effectués
// - Dotations envoyées aux dépôts / caisses
function calcSoldes(data) {
  // ── CAISSE ESPÈCES PHYSIQUES ──────────────────────────────────────────────
  // Recettes espèces : pharmacie centrale + tous dépôts
  const recEspCentrale = data.recettes.filter(r=>r.source==="pharmacie" && isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
  const recEspDepots   = data.recettes.filter(r=>r.source!=="pharmacie" && isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
  // Versements reçus des dépôts (espèces remontées à la centrale)
  const verseDepotsEsp = (data.verseDepots||[]).filter(v=>!v.mode||isEspeces(v.mode)).reduce((s,v)=>s+Number(v.montant||0),0);
  // Recouvrements encaissés en espèces
  const recouvrEsp = data.recouvrements.filter(r=>isEspeces(r.mode)||!r.mode).reduce((s,r)=>s+Number(r.montant||0),0);
  const diversEsp  = (data.encaissementsDivers||[]).filter(e=>isEspeces(e.mode)||!e.mode).reduce((s,e)=>s+Number(e.montant||0),0);
  // Dépenses payées en espèces
  const depEsp = data.depenses.filter(d=>isEspeces(d.mode)).reduce((s,d)=>s+Number(d.montant||0),0);
  // Versements banque depuis caisse espèces
  const versBanqueEsp = data.versementsBanque.filter(v=>v.typeVers==="especes"||!v.typeVers).reduce((s,v)=>s+Number(v.montant||0),0);
  // Dotations envoyées (espèces)
  const dotations = (data.dotationHistory||[]).reduce((s,d)=>s+Number(d.montant||0),0);

  const soldeEspeces = DOTATION_MONNAIE + recEspCentrale + recEspDepots + verseDepotsEsp + recouvrEsp + diversEsp - depEsp - versBanqueEsp - dotations;

  // ── SOLDES MOBILE MONEY (par opérateur) ───────────────────────────────────
  const soldeMobile = {};
  MODES_MOBILE.forEach(op => {
    // Recettes via cet opérateur (centrale + tous dépôts)
    const encaisse = data.recettes.filter(r=>r.mode===op.value).reduce((s,r)=>s+Number(r.montant||0),0);
    // Versements banque depuis ce compte mobile money
    const vireBanque = data.versementsBanque.filter(v=>v.typeVers===op.value).reduce((s,v)=>s+Number(v.montant||0),0);
    soldeMobile[op.value] = { label:op.label, color:op.color, encaisse, vireBanque, solde: encaisse - vireBanque };
  });

  const totalMobile = Object.values(soldeMobile).reduce((s,m)=>s+m.solde, 0);

  return {
    dotation: DOTATION_MONNAIE,
    recEspCentrale, recEspDepots, verseDepotsEsp, recouvrEsp, diversEsp,
    depEsp, versBanqueEsp, dotations,
    soldeEspeces,
    soldeMobile,
    totalMobile,
    soldeGlobal: soldeEspeces + totalMobile,
  };
}
// Alias pour compat sidebar
const calcSoldeCaisse = (data) => { const s=calcSoldes(data); return { solde: s.soldeEspeces, ...s }; };

// ─── LOGIN ───────────────────────────────────────────────────────────────────
function LoginPage({ onLogin, users, refetch }) {
  const [email, setEmail] = useState(""); const [pwd, setPwd] = useState(""); const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const submit = async () => {
    setLoading(true); setErr("");
    try {
      // Cherche d'abord dans le cache local (mode hors ligne)
      let u = users.find(x=>x.email===email && x.password===pwd);
      if (!u) { setErr("Email ou mot de passe incorrect"); setLoading(false); return; }
      await refetch();
      // Enregistrer la connexion
      try {
        const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
        const d = new Date();
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const heureStr = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const nav = navigator.userAgent.includes("Mobile") ? "Mobile" : "Desktop";
        await supa.insert("connexions", { id, user_id:u.id, user_name:u.name, role:u.role, date:dateStr, heure:heureStr, navigateur:nav });
      } catch {}
      onLogin(u);
    } catch { setErr("Erreur de connexion"); } finally { setLoading(false); }
  };
  return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#0c4a6e 0%,#0369a1 55%,#0ea5e9 100%)", display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div style={{ background:"#fff", borderRadius:20, padding:40, width:"100%", maxWidth:400, boxShadow:"0 24px 80px #0004" }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ fontSize:44 }}>💊</div>
          <h1 style={{ margin:"8px 0 4px", fontSize:26, fontWeight:900, color:"#0c4a6e" }}>PharmaCash</h1>
          <p style={{ margin:0, color:"#6b7280", fontSize:14 }}>Gestion financière · Pharmacie de garde</p>
        </div>
        {err && <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", color:"#dc2626", borderRadius:8, padding:"10px 14px", fontSize:13, marginBottom:14 }}>{err}</div>}
        <Field label="Email" required><Input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="votre@email.com"/></Field>
        <Field label="Mot de passe" required><Input type="password" value={pwd} onChange={e=>setPwd(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="••••••••"/></Field>
        <Btn onClick={submit} disabled={loading} style={{ width:"100%", padding:12, fontSize:15, marginTop:6 }}>{loading?"Connexion...":"Se connecter"}</Btn>
        <div style={{ marginTop:20, background:"#f0f9ff", borderRadius:8, padding:12, fontSize:12, color:"#0369a1" }}>
          <b>Comptes démo :</b><br/>admin@pharmacie.com / admin123<br/>compta@pharmacie.com / compta123
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
function Dashboard({ data }) {
  const m = new Date().getMonth(); const y = new Date().getFullYear();
  const isThisMonth = (date) => {
    if (!date) return false;
    const [dy, dm] = date.split("-");
    return parseInt(dm)-1 === m && parseInt(dy) === y;
  };

  const recM   = data.recettes.filter(r=>isThisMonth(r.date)&&r.source==="pharmacie").reduce((s,r)=>s+Number(r.montant||0),0);
  const recToday = data.recettes.filter(r=>r.date===today()&&r.source==="pharmacie").reduce((s,r)=>s+Number(r.montant||0),0);
  const recDepM  = data.recettes.filter(r=>isThisMonth(r.date)&&r.source!=="pharmacie").reduce((s,r)=>s+Number(r.montant||0),0);
  const versBankM = data.versementsBanque.filter(v=>isThisMonth(v.date)).reduce((s,v)=>s+Number(v.montant||0),0);
  const depM   = data.depenses.filter(d=>isThisMonth(d.date)).reduce((s,d)=>s+Number(d.montant||0),0);
  const recouvrM = data.recouvrements.filter(r=>isThisMonth(r.date)).reduce((s,r)=>s+Number(r.montant||0),0);
  // Recettes dépôts aujourd'hui
  const recDepToday    = data.recettes.filter(r=>r.date===today()&&r.source!=="pharmacie").reduce((s,r)=>s+Number(r.montant||0),0);
  const recDepTodayEsp = data.recettes.filter(r=>r.date===today()&&r.source!=="pharmacie"&&isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
  const recDepTodayMob = data.recettes.filter(r=>r.date===today()&&r.source!=="pharmacie"&&isMobileMoney(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
  // Dépenses aujourd'hui
  const depToday = data.depenses.filter(d=>d.date===today()).reduce((s,d)=>s+Number(d.montant||0),0);
  // Versements banque aujourd'hui
  const versBanqueToday = data.versementsBanque.filter(v=>v.date===today()).reduce((s,v)=>s+Number(v.montant||0),0);
  // Recouvrement aujourd'hui (clients à crédit + divers)
  const recouvrToday = data.recouvrements.filter(r=>r.date===today()).reduce((s,r)=>s+Number(r.montant||0),0);
  const diversToday  = (data.encaissementsDivers||[]).filter(e=>e.date===today()).reduce((s,e)=>s+Number(e.montant||0),0);
  const recouvrTodayTotal = recouvrToday + diversToday;

  const soldes = calcSoldes(data);

  // Versements dépôts par mois (6 mois)
  const last6 = Array.from({length:6},(_,i)=>{
    const d=new Date(); d.setMonth(d.getMonth()-(5-i));
    const mm=d.getMonth(); const yy=d.getFullYear();
    const pharm = data.recettes.filter(r=>{ const rd=new Date(r.date); return rd.getMonth()===mm&&rd.getFullYear()===yy&&r.source==="pharmacie"; }).reduce((s,r)=>s+Number(r.montant||0),0);
    const dep = data.recettes.filter(r=>{ const rd=new Date(r.date); return rd.getMonth()===mm&&rd.getFullYear()===yy&&r.source!=="pharmacie"; }).reduce((s,r)=>s+Number(r.montant||0),0);
    return { label:d.toLocaleDateString("fr-FR",{month:"short"}), pharm, dep };
  });
  const maxBar = Math.max(...last6.map(x=>x.pharm+x.dep),1);

  // Versements dépôts ce mois (par dépôt)
  const depotStatsM = data.depots.map(dep => {
    const recettes = data.recettes.filter(r=>isThisMonth(r.date)&&r.source===dep.id);
    const recEsp    = recettes.filter(r=>isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
    const recMobile = recettes.filter(r=>isMobileMoney(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
    const recM      = recettes.reduce((s,r)=>s+Number(r.montant||0),0);
    const verseM    = (data.verseDepots||[]).filter(v=>isThisMonth(v.date)&&v.depotId===dep.id).reduce((s,v)=>s+Number(v.montant||0),0);
    return { nom:dep.nom, recEsp, recMobile, recM, verseM };
  });

  return (
    <div>
      {/* En-tête avec boutons PDF toujours visibles */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:16 }}>
        <div>
          <h2 style={{ margin:"0 0 4px", fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Tableau de bord</h2>
          <p style={{ margin:0, fontSize:13, color:"#6b7280" }}>{new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn variant="ghost" style={{ fontSize:13 }} onClick={()=>generatePDF(data,"jour")}>📄 PDF Journalier</Btn>
          <Btn variant="ghost" style={{ fontSize:13 }} onClick={()=>generatePDF(data,"mois")}>📄 PDF Mensuel</Btn>
        </div>
      </div>

      {/* ── ALERTES VISUELLES ── */}
      {(() => {
        const alertes = [];
        // Solde caisse bas
        if (soldes.soldeEspeces < ALERT_SEUIL_CAISSE) {
          alertes.push({ type:"danger", msg:`⚠️ Solde caisse espèces bas : ${fmt(soldes.soldeEspeces)} — seuil minimum ${fmt(ALERT_SEUIL_CAISSE)}` });
        }
        // Dépôts sans versement depuis X jours
        (data.depots||[]).forEach(dep => {
          const versements = (data.verseDepots||[]).filter(v=>v.depotId===dep.id);
          let jours = ALERT_DEPOT_JOURS + 1;
          if (versements.length > 0) {
            const dernier = versements.map(v=>v.date).sort().reverse()[0];
            jours = Math.floor((new Date(today()) - new Date(dernier)) / (1000*60*60*24));
          }
          if (jours >= ALERT_DEPOT_JOURS) {
            alertes.push({ type:"warn", msg:`📍 ${dep.nom} : aucun versement depuis ${jours} jour(s)` });
          }
        });
        if (!alertes.length) return null;
        return (
          <div style={{ marginBottom:16 }}>
            {alertes.map((a,i) => (
              <div key={i} style={{ background:a.type==="danger"?"#fef2f2":"#fff7ed", border:`1px solid ${a.type==="danger"?"#fca5a5":"#fed7aa"}`, borderRadius:10, padding:"10px 16px", marginBottom:8, display:"flex", gap:10, alignItems:"center" }}>
                <span style={{ color:a.type==="danger"?"#dc2626":"#ea580c", fontWeight:700, fontSize:13 }}>{a.msg}</span>
              </div>
            ))}
          </div>
        );
      })()}
      <p style={{ margin:"0 0 20px", color:"#6b7280", fontSize:14 }}>{new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>



      {/* SOLDES TEMPS RÉEL */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:14, marginBottom:22 }}>
        {/* Caisse espèces */}
        <div style={{ background:"linear-gradient(120deg,#0369a1,#0c4a6e)", borderRadius:14, padding:"20px 22px", color:"#fff", boxShadow:"0 4px 20px #0369a140" }}>
          <div style={{ fontSize:11, fontWeight:700, opacity:0.7, textTransform:"uppercase", letterSpacing:0.8, marginBottom:4 }}>💵 Caisse Espèces — Temps réel</div>
          <div style={{ fontSize:30, fontWeight:900 }}>{fmt(soldes.soldeEspeces)}</div>
          <div style={{ fontSize:11, opacity:0.65, marginTop:8, lineHeight:1.8 }}>
            Dotation : {fmt(DOTATION_MONNAIE)}<br/>
            + Centrale : {fmt(soldes.recEspCentrale)} · Dépôts : {fmt(soldes.recEspDepots)}<br/>
            + Versements dépôts : {fmt(soldes.verseDepotsEsp)} · Recouvrements : {fmt(soldes.recouvrEsp)} · Divers : {fmt(soldes.diversEsp)}<br/>
            − Dépenses : {fmt(soldes.depEsp)} · Banque : {fmt(soldes.versBanqueEsp)} · Dotations : {fmt(soldes.dotations)}
          </div>
        </div>
        {/* Mobile Money par opérateur */}
        <div style={{ background:"#fff", borderRadius:14, padding:"20px 22px", boxShadow:"0 1px 6px #0001" }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase", letterSpacing:0.8, marginBottom:10 }}>📱 Comptes Mobile Money</div>
          {MODES_MOBILE.map(op => {
            const s = soldes.soldeMobile[op.value];
            return (
              <div key={op.value} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"6px 0", borderBottom:"1px solid #f0f0f0" }}>
                <div>
                  <span style={{ fontWeight:700, color:op.color }}>{op.label}</span>
                  <div style={{ fontSize:11, color:"#9ca3af" }}>Encaissé: {fmt(s.encaisse)} · Viré banque: {fmt(s.vireBanque)}</div>
                </div>
                <b style={{ color:s.solde>0?op.color:"#047857", fontSize:15 }}>{fmt(s.solde)}</b>
              </div>
            );
          })}
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:10, paddingTop:8, borderTop:"2px solid #e5e7eb" }}>
            <span style={{ fontWeight:700, fontSize:13 }}>Total Mobile Money</span>
            <b style={{ fontSize:16, color:"#7c3aed" }}>{fmt(soldes.totalMobile)}</b>
          </div>
        </div>
      </div>

      {/* KPI DU JOUR */}
      <p style={{ margin:"0 0 8px", fontSize:12, fontWeight:700, color:"#9ca3af", textTransform:"uppercase", letterSpacing:0.8 }}>Aujourd'hui</p>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(175px,1fr))", gap:10, marginBottom:20 }}>
        <KpiCard label="Recettes centrale" value={fmt(recToday)} color="#047857" icon="recettes" sub="💵 Esp. + 📱 Mobile"/>
        <KpiCard label="Recettes dépôts" value={fmt(recDepToday)} color="#7c3aed" icon="depots" sub={`💵 ${fmt(recDepTodayEsp)} · 📱 ${fmt(recDepTodayMob)}`}/>
        <KpiCard label="Versements banque" value={fmt(versBanqueToday)} color="#0891b2" icon="versements" sub="Espèces + Mobile"/>
        <KpiCard label="Recouvrement" value={fmt(recouvrTodayTotal)} color="#b45309" icon="recouvrement" sub={`Clients: ${fmt(recouvrToday)} · Divers: ${fmt(diversToday)}`}/>
        <KpiCard label="Dépenses" value={fmt(depToday)} color="#dc2626" icon="depenses" sub="Toutes catégories"/>
      </div>

      {/* KPI DU MOIS */}
      <p style={{ margin:"0 0 8px", fontSize:12, fontWeight:700, color:"#9ca3af", textTransform:"uppercase", letterSpacing:0.8 }}>{new Date().toLocaleDateString("fr-FR",{month:"long",year:"numeric"})}</p>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(175px,1fr))", gap:10, marginBottom:24 }}>
        <KpiCard label="Recettes centrale" value={fmt(recM)} color="#0369a1" icon="recettes" sub={`Dépôts : ${fmt(recDepM)}`}/>
        <KpiCard label="Versements banque" value={fmt(versBankM)} color="#0891b2" icon="versements"/>
        <KpiCard label="Recouvrement" value={fmt(recouvrM)} color="#b45309" icon="recouvrement" sub="Encaissements clients"/>
        <KpiCard label="Dépenses" value={fmt(depM)} color="#ea580c" icon="depenses"/>
      </div>

      {/* ── COURBE CA JOURNALIER — 30 derniers jours ── */}
      <div style={{ background:"#fff", borderRadius:12, padding:"20px 24px", boxShadow:"0 1px 4px #0001", marginBottom:16 }}>
        <h3 style={{ margin:"0 0 4px", fontSize:15, fontWeight:700, color:"#374151" }}>Évolution du CA journalier — 30 derniers jours</h3>
        <p style={{ margin:"0 0 14px", fontSize:12, color:"#9ca3af" }}>Centrale + Dépôts</p>
        {(() => {
          const days = Array.from({length:30}, (_,i) => {
            const d = new Date(); d.setDate(d.getDate()-(29-i));
            const dd = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
            const total = data.recettes.filter(r=>r.date===dd).reduce((s,r)=>s+Number(r.montant||0),0);
            return { label: String(d.getDate()).padStart(2,'0'), total, isToday: i===29 };
          });
          const maxD = Math.max(...days.map(d=>d.total), 1);
          const H = 110;
          // Polyline SVG
          const pts = days.map((d,i) => `${(i/(days.length-1))*100},${H - (d.total/maxD)*H}`).join(' ');
          const fillPts = `0,${H} ${pts} 100,${H}`;
          return (
            <div>
              <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" style={{ width:"100%", height:H, display:"block" }}>
                <defs>
                  <linearGradient id="gJ" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0369a1" stopOpacity="0.25"/>
                    <stop offset="100%" stopColor="#0369a1" stopOpacity="0.02"/>
                  </linearGradient>
                </defs>
                <polygon points={fillPts} fill="url(#gJ)"/>
                <polyline points={pts} fill="none" stroke="#0369a1" strokeWidth="0.8" strokeLinejoin="round"/>
                {days.map((d,i) => d.total>0 ? (
                  <circle key={i} cx={(i/(days.length-1))*100} cy={H-(d.total/maxD)*H} r="1.2" fill={d.isToday?"#047857":"#0369a1"}/>
                ) : null)}
              </svg>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
                {days.filter((_,i)=>i%5===0||i===29).map((d,i)=>(
                  <span key={i} style={{ fontSize:10, color:"#9ca3af" }}>{d.label}</span>
                ))}
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:8 }}>
                <span style={{ fontSize:12, color:"#6b7280" }}>Min : <b>{fmt(Math.min(...days.map(d=>d.total).filter(v=>v>0)) || 0)}</b></span>
                <span style={{ fontSize:12, color:"#0369a1", fontWeight:700 }}>Aujourd'hui : <b>{fmt(days[29].total)}</b></span>
                <span style={{ fontSize:12, color:"#6b7280" }}>Max : <b>{fmt(Math.max(...days.map(d=>d.total)))}</b></span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ── COURBE CA MENSUEL — 12 derniers mois ── */}
      <div style={{ background:"#fff", borderRadius:12, padding:"20px 24px", boxShadow:"0 1px 4px #0001", marginBottom:20 }}>
        <h3 style={{ margin:"0 0 4px", fontSize:15, fontWeight:700, color:"#374151" }}>Évolution du CA mensuel — 12 derniers mois</h3>
        <p style={{ margin:"0 0 14px", fontSize:12, color:"#9ca3af" }}>Barres empilées : Centrale (bleu) + Dépôts (violet)</p>
        {(() => {
          const months = Array.from({length:12}, (_,i) => {
            const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-(11-i));
            const mm = d.getMonth(); const yy = d.getFullYear();
            const pharm = data.recettes.filter(r=>{ const [ry,rm]=r.date.split('-'); return parseInt(rm)-1===mm&&parseInt(ry)===yy&&r.source==="pharmacie"; }).reduce((s,r)=>s+Number(r.montant||0),0);
            const dep   = data.recettes.filter(r=>{ const [ry,rm]=r.date.split('-'); return parseInt(rm)-1===mm&&parseInt(ry)===yy&&r.source!=="pharmacie"; }).reduce((s,r)=>s+Number(r.montant||0),0);
            return { label:d.toLocaleDateString("fr-FR",{month:"short"}), pharm, dep, total:pharm+dep, isCurrent:i===11 };
          });
          const maxM = Math.max(...months.map(m=>m.total), 1);
          const H = 120;
          return (
            <div>
              <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:H }}>
                {months.map((m,i)=>(
                  <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                    <div style={{ fontSize:9, color:"#6b7280", whiteSpace:"nowrap" }}>
                      {m.total>0 ? `${(m.total/1000).toFixed(0)}k` : ""}
                    </div>
                    <div style={{ width:"100%", display:"flex", flexDirection:"column-reverse", borderRadius:"3px 3px 0 0", overflow:"hidden", minHeight:2 }}>
                      <div style={{ height:`${Math.max((m.pharm/maxM)*(H-20),m.pharm>0?3:0)}px`, background:m.isCurrent?"#0369a1":"#93c5fd", transition:"height .4s" }}/>
                      <div style={{ height:`${Math.max((m.dep/maxM)*(H-20),m.dep>0?3:0)}px`, background:m.isCurrent?"#7c3aed":"#c4b5fd", transition:"height .4s" }}/>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", gap:4, marginTop:4 }}>
                {months.map((m,i)=>(
                  <div key={i} style={{ flex:1, textAlign:"center", fontSize:10, color:m.isCurrent?"#0369a1":"#9ca3af", fontWeight:m.isCurrent?700:400 }}>{m.label}</div>
                ))}
              </div>
              <div style={{ display:"flex", gap:16, marginTop:10 }}>
                <span style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"#0369a1", fontWeight:600 }}><span style={{ width:10, height:10, background:"#0369a1", borderRadius:2, display:"inline-block" }}/> Centrale</span>
                <span style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"#7c3aed", fontWeight:600 }}><span style={{ width:10, height:10, background:"#7c3aed", borderRadius:2, display:"inline-block" }}/> Dépôts</span>
                <span style={{ marginLeft:"auto", fontSize:12, color:"#374151", fontWeight:700 }}>
                  Mois en cours : {fmt(months[11].total)}
                </span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ══ PERFORMANCE JOURNALIÈRE ══ */}
      <div style={{ background:"#fff", borderRadius:12, padding:"20px 24px", boxShadow:"0 1px 4px #0001", marginBottom:16 }}>
        <h3 style={{ margin:"0 0 14px", fontSize:15, fontWeight:700, color:"#374151" }}>
          📅 Performance du jour — {new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long"})}
        </h3>
        {(() => {
          const rows = [
            { label:"🏥 Pharmacie centrale", id:"pharmacie" },
            ...data.depots.map(d=>({ label:`📍 ${d.nom}`, id:d.id }))
          ].map(src => {
            const esp = data.recettes.filter(r=>r.date===today()&&r.source===src.id&&isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
            const mob = data.recettes.filter(r=>r.date===today()&&r.source===src.id&&isMobileMoney(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
            return { ...src, esp, mob, total:esp+mob };
          });
          const totEsp = rows.reduce((s,r)=>s+r.esp,0);
          const totMob = rows.reduce((s,r)=>s+r.mob,0);
          return (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:14 }}>
                <thead>
                  <tr style={{ background:"#f8fafc" }}>
                    <th style={{ padding:"8px 12px", textAlign:"left", fontWeight:700, color:"#374151", borderBottom:"2px solid #e5e7eb" }}>Point de vente</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#0369a1", borderBottom:"2px solid #e5e7eb" }}>💵 Espèces</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#7c3aed", borderBottom:"2px solid #e5e7eb" }}>📱 Mobile</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#047857", borderBottom:"2px solid #e5e7eb" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r,i)=>(
                    <tr key={i} style={{ borderBottom:"1px solid #f0f0f0", background:i===0?"#f0f9ff":i%2===0?"#fff":"#fafafa" }}>
                      <td style={{ padding:"8px 12px", fontWeight:i===0?700:400 }}>{r.label}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", color:"#0369a1", fontWeight:600 }}>{fmt(r.esp)}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", color:"#7c3aed", fontWeight:600 }}>{fmt(r.mob)}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:r.total>0?"#047857":"#9ca3af" }}>{fmt(r.total)}</td>
                    </tr>
                  ))}
                  <tr style={{ background:"#f0fdf4", fontWeight:800, borderTop:"2px solid #bbf7d0" }}>
                    <td style={{ padding:"10px 12px", color:"#047857" }}>TOTAL JOUR</td>
                    <td style={{ padding:"10px 12px", textAlign:"right", color:"#0369a1" }}>{fmt(totEsp)}</td>
                    <td style={{ padding:"10px 12px", textAlign:"right", color:"#7c3aed" }}>{fmt(totMob)}</td>
                    <td style={{ padding:"10px 12px", textAlign:"right", color:"#047857", fontSize:15 }}>{fmt(totEsp+totMob)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })()}
      </div>

      {/* ══ PERFORMANCE MENSUELLE ══ */}
      <div style={{ background:"#fff", borderRadius:12, padding:"20px 24px", boxShadow:"0 1px 4px #0001", marginBottom:20 }}>
        <h3 style={{ margin:"0 0 14px", fontSize:15, fontWeight:700, color:"#374151" }}>
          📆 Cumul mensuel — {new Date().toLocaleDateString("fr-FR",{month:"long",year:"numeric"})}
        </h3>
        {(() => {
          const rows = [
            { label:"🏥 Pharmacie centrale", id:"pharmacie" },
            ...data.depots.map(d=>({ label:`📍 ${d.nom}`, id:d.id }))
          ].map(src => {
            const esp   = data.recettes.filter(r=>isThisMonth(r.date)&&r.source===src.id&&isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
            const mob   = data.recettes.filter(r=>isThisMonth(r.date)&&r.source===src.id&&isMobileMoney(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
            const verse = src.id==="pharmacie" ? 0 : (data.verseDepots||[]).filter(v=>isThisMonth(v.date)&&v.depotId===src.id).reduce((s,v)=>s+Number(v.montant||0),0);
            const ecart = src.id==="pharmacie" ? null : (esp+mob) - verse;
            return { ...src, esp, mob, total:esp+mob, verse, ecart };
          });
          const totEsp   = rows.reduce((s,r)=>s+r.esp,0);
          const totMob   = rows.reduce((s,r)=>s+r.mob,0);
          const totVerse = rows.filter(r=>r.id!=="pharmacie").reduce((s,r)=>s+r.verse,0);
          return (
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:14 }}>
                <thead>
                  <tr style={{ background:"#f8fafc" }}>
                    <th style={{ padding:"8px 12px", textAlign:"left", fontWeight:700, color:"#374151", borderBottom:"2px solid #e5e7eb" }}>Point de vente</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#0369a1", borderBottom:"2px solid #e5e7eb" }}>💵 Espèces</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#7c3aed", borderBottom:"2px solid #e5e7eb" }}>📱 Mobile</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#047857", borderBottom:"2px solid #e5e7eb" }}>Total</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#0891b2", borderBottom:"2px solid #e5e7eb" }}>Versé centrale</th>
                    <th style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:"#dc2626", borderBottom:"2px solid #e5e7eb" }}>Écart</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r,i)=>(
                    <tr key={i} style={{ borderBottom:"1px solid #f0f0f0", background:i===0?"#f0f9ff":i%2===0?"#fff":"#fafafa" }}>
                      <td style={{ padding:"8px 12px", fontWeight:i===0?700:400 }}>{r.label}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", color:"#0369a1", fontWeight:600 }}>{fmt(r.esp)}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", color:"#7c3aed", fontWeight:600 }}>{fmt(r.mob)}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", fontWeight:700 }}>{fmt(r.total)}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", color:"#0891b2", fontWeight:600 }}>{r.id==="pharmacie"?"—":fmt(r.verse)}</td>
                      <td style={{ padding:"8px 12px", textAlign:"right", fontWeight:700, color:r.ecart>0?"#dc2626":r.ecart===0?"#047857":"#9ca3af" }}>
                        {r.id==="pharmacie"?"—":fmt(r.ecart)}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ background:"#f0fdf4", fontWeight:800, borderTop:"2px solid #bbf7d0" }}>
                    <td style={{ padding:"10px 12px", color:"#047857" }}>TOTAL MOIS</td>
                    <td style={{ padding:"10px 12px", textAlign:"right", color:"#0369a1" }}>{fmt(totEsp)}</td>
                    <td style={{ padding:"10px 12px", textAlign:"right", color:"#7c3aed" }}>{fmt(totMob)}</td>
                    <td style={{ padding:"10px 12px", textAlign:"right", color:"#047857", fontSize:15 }}>{fmt(totEsp+totMob)}</td>
                    <td style={{ padding:"10px 12px", textAlign:"right", color:"#0891b2" }}>{fmt(totVerse)}</td>
                    <td/>
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })()}
      </div>    </div>
  );
}

function ResponsablesSection({ data, setRaw, isAdmin }) {
  const [modal, setModal] = useState(false);
  const [rForm, setRForm] = useState({ nom:"", depotId:"", telephone:"" });

  const addResp = async () => {
    if (!rForm.nom) return;
    const id = uid();
    const localRow = { id, nom:rForm.nom, depotId:rForm.depotId||null, telephone:rForm.telephone||"" };
    const supaRow  = { id, nom:rForm.nom, depot_id:rForm.depotId||null, telephone:rForm.telephone||null };
    await dbInsert("responsables", supaRow, setRaw, data, "responsables", localRow);
    setModal(false); setRForm({ nom:"", depotId:"", telephone:"" });
  };

  const delResp = async (id) => {
    if (!confirm("Supprimer ce responsable ?")) return;
    await dbDelete("responsables", id, setRaw, data, "responsables");
  };

  return (
    <div style={{ marginTop:24 }}>
      <Divider label="Responsables / Gérants des dépôts"/>
      <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
        {isAdmin && <Btn onClick={()=>setModal(true)} style={{ fontSize:13 }}>+ Nouveau responsable</Btn>}
      </div>
      <Table
        cols={["Nom","Dépôt assigné","Téléphone",""]}
        rows={(data.responsables||[]).map(r=>{
          const dep = data.depots.find(d=>d.id===r.depotId);
          return [
            <b>{r.nom}</b>,
            dep ? <Badge color="#7c3aed">📍 {dep.nom}</Badge> : <span style={{color:"#9ca3af"}}>Non assigné</span>,
            r.telephone||"—",
            isAdmin ? <Btn variant="danger" style={{fontSize:12,padding:"4px 10px"}} onClick={()=>delResp(r.id)}>Supprimer</Btn> : null,
          ];
        })}
        empty="Aucun responsable enregistré"
      />
      {modal && (
        <Modal title="Nouveau responsable de dépôt" onClose={()=>setModal(false)}>
          <Field label="Nom complet" required>
            <Input value={rForm.nom} onChange={e=>setRForm({...rForm,nom:e.target.value})} placeholder="Ex: M. Koné Adama"/>
          </Field>
          <Field label="Dépôt assigné">
            <Select value={rForm.depotId} onChange={e=>setRForm({...rForm,depotId:e.target.value})}>
              <option value="">— Aucun dépôt spécifique —</option>
              {data.depots.map(d=><option key={d.id} value={d.id}>{d.nom}</option>)}
            </Select>
          </Field>
          <Field label="Téléphone">
            <Input value={rForm.telephone} onChange={e=>setRForm({...rForm,telephone:e.target.value})} placeholder="+225 ..."/>
          </Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={addResp} disabled={!rForm.nom}>Enregistrer</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}


// ─── RECETTES ────────────────────────────────────────────────────────────────
function Recettes({ data, setRaw, user }) {
  const isAdmin = user?.role === 'admin';
  const [modal, setModal] = useState(false);
  const [dotModal, setDotModal] = useState(false);
  const [form, setForm] = useState({ date:today(), tranche:"jour", caissiere:"", source:"pharmacie", montantEsp:"", modeMobile:"orange_money", montantMobile:"", note:"" });
  const [dotForm, setDotForm] = useState({ date:today(), dest:"caisse_jour", montant:"", note:"" });
  const [filterFrom, setFilterFrom] = useState(today());
  const [filterTo, setFilterTo] = useState(today());
  const [editRow, setEditRow] = useState(null);

  const add = async () => {
    const hasEsp = Number(form.montantEsp) > 0;
    const hasMob = Number(form.montantMobile) > 0;
    if (!hasEsp && !hasMob) return;
    const rows = [];
    if (hasEsp) rows.push({ mode:"especes", montant:Number(form.montantEsp) });
    if (hasMob) rows.push({ mode:form.modeMobile, montant:Number(form.montantMobile) });
    for (const r of rows) {
      const id = uid();
      const localRow = { id, date:form.date, tranche:form.source==="pharmacie"?form.tranche:null, caissiere:form.caissiere, source:form.source, montant:r.montant, mode:r.mode, note:form.note||"" };
      const supaRow  = { id, date:form.date, tranche:form.source==="pharmacie"?form.tranche:null, caissiere:form.caissiere||null, source:form.source, montant:r.montant, mode:r.mode, note:form.note||null };
      await dbInsert("recettes", supaRow, setRaw, data, "recettes", localRow);
    }
    setModal(false);
    setForm({ date:today(), tranche:"jour", caissiere:"", source:"pharmacie", montantEsp:"", modeMobile:"orange_money", montantMobile:"", note:"" });
  };

  const addDot = async () => {
    if (!dotForm.montant) return;
    const id = uid();
    const localRow = { ...dotForm, id, montant:Number(dotForm.montant) };
    const supaRow = { id, date:dotForm.date, dest:dotForm.dest, montant:Number(dotForm.montant), note:dotForm.note||null };
    await dbInsert("dotation_history", supaRow, setRaw, data, "dotationHistory", localRow);
    setDotModal(false); setDotForm({ date:today(), dest:"caisse_jour", montant:"", note:"" });
  };

  const deleteRec = async (id) => {
    if (!confirm("Supprimer cette recette ?")) return;
    await dbDelete("recettes", id, setRaw, data, "recettes");
  };

  const openEdit = (r) => {
    if (isMobileMoney(r.mode)) {
      setForm({ date:r.date, tranche:r.tranche||"jour", caissiere:r.caissiere||"", source:r.source, montantEsp:"", modeMobile:r.mode, montantMobile:String(r.montant), note:r.note||"" });
    } else {
      setForm({ date:r.date, tranche:r.tranche||"jour", caissiere:r.caissiere||"", source:r.source, montantEsp:String(r.montant), modeMobile:"orange_money", montantMobile:"", note:r.note||"" });
    }
    setEditRow(r);
    setModal(true);
  };

  const saveEdit = async () => {
    if (!editRow) return;
    const montant = Number(form.montantEsp||0) + Number(form.montantMobile||0);
    const mode = Number(form.montantMobile)>0 ? form.modeMobile : "especes";
    const supaRow = { date:form.date, tranche:form.source==="pharmacie"?form.tranche:null, caissiere:form.caissiere||null, source:form.source, montant, mode, note:form.note||null };
    await dbUpdate("recettes", editRow.id, supaRow, setRaw, data, "recettes", r=>r.id===editRow.id?{...r,...supaRow,montant,mode}:r);
    setModal(false); setEditRow(null);
    setForm({ date:today(), tranche:"jour", caissiere:"", source:"pharmacie", montantEsp:"", modeMobile:"orange_money", montantMobile:"", note:"" });
  };

  const caissiers = [...new Set([
    ...data.users.filter(u=>u.role==="caissier"||u.role==="admin").map(u=>u.name),
    ...(data.responsables||[]).map(r=>r.nom),
  ])];
  const filtered = [...data.recettes]
    .filter(r=>(!filterFrom||r.date>=filterFrom)&&(!filterTo||r.date<=filterTo))
    .sort((a,b)=>b.date.localeCompare(a.date));
  const totJour = filtered.filter(r=>r.source==="pharmacie"&&r.tranche==="jour").reduce((s,r)=>s+Number(r.montant||0),0);
  const totNuit = filtered.filter(r=>r.source==="pharmacie"&&r.tranche==="nuit").reduce((s,r)=>s+Number(r.montant||0),0);

  const destLabel = { caisse_jour:"Caisse Jour", caisse_nuit:"Caisse Nuit", ...Object.fromEntries((data.depots||[]).map(d=>[d.id,d.nom])) };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Recettes journalières</h2>
        <div style={{ display:"flex", gap:8 }}>
          {isAdmin && <Btn variant="warn" onClick={()=>setDotModal(true)} style={{ fontSize:13 }}>💰 Dotation monnaie</Btn>}
          <Btn onClick={()=>setModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Saisir recette</span></Btn>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))", gap:10, marginBottom:18 }}>
        <KpiCard label="☀️ Caisse Jour (7h30–17h30)" value={fmt(totJour)} color="#f59e0b" icon="recettes"/>
        <KpiCard label="🌙 Caisse Nuit (17h30–7h30)" value={fmt(totNuit)} color="#1e40af" icon="recettes"/>
        <KpiCard label="💵 Espèces (filtre)" value={fmt(filtered.filter(r=>isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0))} color="#0369a1" icon="cash"/>
        <KpiCard label="📱 Mobile Money (filtre)" value={fmt(filtered.filter(r=>isMobileMoney(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0))} color="#7c3aed" icon="recettes"/>
      </div>

      {filtered.some(r=>isMobileMoney(r.mode)) && (
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
          {MODES_MOBILE.map(op=>{
            const tot = filtered.filter(r=>r.mode===op.value).reduce((s,r)=>s+Number(r.montant||0),0);
            if(!tot) return null;
            return <span key={op.value} style={{ background:op.color+"15", color:op.color, border:`1px solid ${op.color}40`, borderRadius:20, padding:"4px 12px", fontSize:13, fontWeight:700 }}>{op.label} : {fmt(tot)}</span>;
          })}
        </div>
      )}

      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
        <label style={{ fontSize:13, fontWeight:600, color:"#374151" }}>Période :</label>
        <Input type="date" value={filterFrom} onChange={e=>setFilterFrom(e.target.value)} style={{ width:"auto" }}/>
        <span style={{ fontSize:13, color:"#6b7280" }}>→</span>
        <Input type="date" value={filterTo} onChange={e=>setFilterTo(e.target.value)} style={{ width:"auto" }}/>
        <Btn variant="ghost" style={{ fontSize:13 }} onClick={()=>{ setFilterFrom(today()); setFilterTo(today()); }}>Aujourd'hui</Btn>
        <Btn variant="ghost" style={{ fontSize:13 }} onClick={()=>{ setFilterFrom(""); setFilterTo(""); }}>Tout voir</Btn>
      </div>

      <Table
        cols={["Date","Tranche","Source","Caissière","Mode","Montant","Note",""]}
        rows={filtered.map(r=>{
          const src = r.source==="pharmacie" ? "🏥 Centrale" : ((data.depots||[]).find(d=>d.id===r.source)?.nom||"Dépôt");
          return [
            fmtDate(r.date),
            r.source==="pharmacie"
              ? (r.tranche==="jour"?<Badge color="#f59e0b">☀️ Jour</Badge>:<Badge color="#1e40af">🌙 Nuit</Badge>)
              : <Badge color="#7c3aed">📍 Dépôt</Badge>,
            src, r.caissiere||"—", modeLabel(r.mode), <b>{fmt(r.montant)}</b>, r.note||"—",
            <EditDeleteBtns isAdmin={isAdmin} onEdit={()=>openEdit(r)} onDelete={()=>deleteRec(r.id)}/>,
          ];
        })}
        empty="Aucune recette"
      />

      {modal && (
        <Modal title={editRow?"Modifier la recette":"Enregistrer une recette"} onClose={()=>{setModal(false);setEditRow(null);}}>
          <Row>
            <Field label="Date" required half><Input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></Field>
            {form.source==="pharmacie" && (
              <Field label="Tranche horaire" required half>
                <Select value={form.tranche} onChange={e=>setForm({...form,tranche:e.target.value})}>
                  <option value="jour">☀️ Jour (7h30 – 17h30)</option>
                  <option value="nuit">🌙 Nuit (17h30 – 7h30)</option>
                </Select>
              </Field>
            )}
          </Row>
          <Field label="Source" required>
            <Select value={form.source} onChange={e=>setForm({...form,source:e.target.value})}>
              <option value="pharmacie">🏥 Pharmacie centrale</option>
              {(data.depots||[]).map(d=><option key={d.id} value={d.id}>📍 {d.nom}</option>)}
            </Select>
          </Field>
          <Field label="Caissière / Responsable">
            <Input list="caissieres-list" value={form.caissiere} onChange={e=>setForm({...form,caissiere:e.target.value})} placeholder="Nom de la caissière ou responsable"/>
            <datalist id="caissieres-list">
              {caissiers.map(c=><option key={c} value={c}/>)}
            </datalist>
          </Field>
          <div style={{ background:"#f0f9ff", borderRadius:10, padding:"14px 16px", marginBottom:14 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#0369a1", marginBottom:10, textTransform:"uppercase" }}>💵 Espèces</div>
            <Field label="Montant espèces (FCFA)">
              <Input type="number" value={form.montantEsp} onChange={e=>setForm({...form,montantEsp:e.target.value})} placeholder="0 — laisser vide si aucun"/>
            </Field>
          </div>
          <div style={{ background:"#faf5ff", borderRadius:10, padding:"14px 16px", marginBottom:14 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#7c3aed", marginBottom:10, textTransform:"uppercase" }}>📱 Mobile Money</div>
            <Row>
              <Field label="Opérateur" half>
                <Select value={form.modeMobile} onChange={e=>setForm({...form,modeMobile:e.target.value})}>
                  {MODES_MOBILE.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              </Field>
              <Field label="Montant (FCFA)" half>
                <Input type="number" value={form.montantMobile} onChange={e=>setForm({...form,montantMobile:e.target.value})} placeholder="0 — laisser vide si aucun"/>
              </Field>
            </Row>
          </div>
          {(Number(form.montantEsp)+Number(form.montantMobile))>0 && (
            <div style={{ background:"#f0fdf4", borderRadius:8, padding:"8px 14px", marginBottom:12, fontSize:13, fontWeight:700, color:"#047857" }}>
              Total : {fmt(Number(form.montantEsp||0)+Number(form.montantMobile||0))}
            </div>
          )}
          <Field label="Note"><Textarea value={form.note} onChange={e=>setForm({...form,note:e.target.value})} placeholder="Optionnel"/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={editRow?saveEdit:add} disabled={!Number(form.montantEsp)&&!Number(form.montantMobile)}>{editRow?"Modifier":"Enregistrer"}</Btn>
          </div>
        </Modal>
      )}

      {dotModal && (
        <Modal title="💰 Dotation monnaie" onClose={()=>setDotModal(false)}>
          <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, padding:12, marginBottom:16, fontSize:13, color:"#92400e" }}>
            Dotation de base : <b>{fmt(DOTATION_MONNAIE)}</b>
          </div>
          <Field label="Date" required><Input type="date" value={dotForm.date} onChange={e=>setDotForm({...dotForm,date:e.target.value})}/></Field>
          <Field label="Destinataire" required>
            <Select value={dotForm.dest} onChange={e=>setDotForm({...dotForm,dest:e.target.value})}>
              <option value="caisse_jour">☀️ Caisse Jour</option>
              <option value="caisse_nuit">🌙 Caisse Nuit</option>
              {(data.depots||[]).map(d=><option key={d.id} value={d.id}>📍 {d.nom}</option>)}
            </Select>
          </Field>
          <Field label="Montant (FCFA)" required><Input type="number" value={dotForm.montant} onChange={e=>setDotForm({...dotForm,montant:e.target.value})}/></Field>
          <Field label="Note"><Input value={dotForm.note} onChange={e=>setDotForm({...dotForm,note:e.target.value})}/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setDotModal(false)}>Annuler</Btn>
            <Btn variant="warn" onClick={addDot} disabled={!dotForm.montant}>Enregistrer dotation</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── RECOUVREMENT ─────────────────────────────────────────────────────────────
function Recouvrement({ data, setRaw, user }) {
  const isAdmin = user?.role === 'admin';
  const [modal, setModal] = useState(false);
  const [clientModal, setClientModal] = useState(false);
  const [diversModal, setDiversModal] = useState(false);
  const [editClient, setEditClient] = useState(null);
  const [form, setForm] = useState({ clientId:"", montant:"", date:today(), mode:"especes", note:"" });
  const [cForm, setCForm] = useState({ nom:"", telephone:"", adresse:"", encours:"" });
  const [diversForm, setDiversForm] = useState({ nom:"", motif:"", montant:"", date:today(), mode:"especes", note:"" });

  const add = async () => {
    if (!form.clientId||!form.montant) return;
    const montant = Number(form.montant);
    const id = uid();
    const localRow = { ...form, id, montant };
    const supaRow = { id, client_id:form.clientId, date:form.date, montant, mode:form.mode, note:form.note||null };
    const nouvelEncours = Math.max(0, (data.clients.find(c=>c.id===form.clientId)?.encours||0) - montant);
    const updated = { ...data, recouvrements:[localRow,...data.recouvrements], clients:data.clients.map(c=>c.id===form.clientId?{...c,encours:nouvelEncours}:c) };
    setRaw(updated);
    try {
      await supa.insert("recouvrements", supaRow);
      await supa.update("clients", form.clientId, { encours:nouvelEncours });
    } catch {
      pushQueue({ action:"insert", table:"recouvrements", data:supaRow });
      pushQueue({ action:"update", table:"clients", id:form.clientId, data:{ encours:nouvelEncours } });
    }
    setModal(false); setForm({ clientId:"", montant:"", date:today(), mode:"especes", note:"" });
  };

  const addDivers = async () => {
    if (!diversForm.montant||!diversForm.nom) return;
    const id = uid();
    const localRow = { id, ...diversForm, montant:Number(diversForm.montant) };
    const supaRow = { id, date:diversForm.date, nom:diversForm.nom, motif:diversForm.motif||null, montant:Number(diversForm.montant), mode:diversForm.mode, note:diversForm.note||null };
    await dbInsert("encaissements_divers", supaRow, setRaw, data, "encaissementsDivers", localRow);
    setDiversModal(false); setDiversForm({ nom:"", motif:"", montant:"", date:today(), mode:"especes", note:"" });
  };

  const saveClient = async () => {
    if (!cForm.nom) return;
    const encours = Number(cForm.encours||0);
    if (editClient) {
      const supaRow = { nom:cForm.nom, telephone:cForm.telephone||null, adresse:cForm.adresse||null, encours };
      await dbUpdate("clients", editClient.id, supaRow, setRaw, data, "clients", c=>c.id===editClient.id?{...c,...cForm,encours}:c);
    } else {
      const id = uid();
      const localRow = { id, ...cForm, encours };
      const supaRow = { id, nom:cForm.nom, telephone:cForm.telephone||null, adresse:cForm.adresse||null, encours };
      await dbInsert("clients", supaRow, setRaw, data, "clients", localRow);
    }
    setClientModal(false);
  };

  const deleteClient = async (id) => {
    if (!confirm("Supprimer ce client ?")) return;
    await dbDelete("clients", id, setRaw, data, "clients");
  };

  const deleteRecouv = async (r) => {
    if (!confirm("Supprimer cet encaissement ?")) return;
    const client = data.clients.find(c=>c.id===r.clientId);
    if (client) {
      const nouvelEncours = client.encours + Number(r.montant||0);
      try { await supa.update("clients", client.id, { encours:nouvelEncours }); } catch {}
      setRaw({ ...data, clients:data.clients.map(c=>c.id===client.id?{...c,encours:nouvelEncours}:c) });
    }
    await dbDelete("recouvrements", r.id, setRaw, data, "recouvrements");
  };

  const deleteDivers = async (id) => {
    if (!confirm("Supprimer cet encaissement ?")) return;
    await dbDelete("encaissements_divers", id, setRaw, data, "encaissementsDivers");
  };

  const totalEncours = data.clients.reduce((s,c)=>s+Number(c.encours||0),0);

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Recouvrement clients à crédit</h2>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <Btn variant="ghost" onClick={()=>{ setCForm({ nom:"",telephone:"",adresse:"",encours:"" }); setEditClient(null); setClientModal(true); }} style={{ fontSize:13 }}>+ Nouveau client</Btn>
          <Btn variant="ghost" onClick={()=>setDiversModal(true)} style={{ fontSize:13, background:"#f0fdf4", color:"#047857" }}>💰 Encaissement divers</Btn>
          <Btn onClick={()=>setModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Encaisser client</span></Btn>
        </div>
      </div>

      {totalEncours>0 && (
        <div style={{ background:"linear-gradient(120deg,#7c3aed,#6d28d9)", borderRadius:12, padding:"14px 20px", marginBottom:16, color:"#fff", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:11, opacity:0.7, fontWeight:700, textTransform:"uppercase" }}>Total encours clients</div>
            <div style={{ fontSize:26, fontWeight:900 }}>{fmt(totalEncours)}</div>
          </div>
          <div style={{ fontSize:13, opacity:0.8 }}>{data.clients.filter(c=>c.encours>0).length} client(s) débiteur(s)</div>
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:10, marginBottom:22 }}>
        {data.clients.map(c=>(
          <div key={c.id} style={{ background:"#fff", borderRadius:10, padding:16, boxShadow:"0 1px 4px #0001", borderLeft:`3px solid ${c.encours>100000?"#dc2626":c.encours>0?"#f59e0b":"#047857"}` }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div style={{ fontWeight:700, fontSize:14 }}>{c.nom}</div>
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={()=>{ setCForm({ nom:c.nom,telephone:c.telephone||"",adresse:c.adresse||"",encours:c.encours }); setEditClient(c); setClientModal(true); }} style={{ background:"none", border:"none", cursor:"pointer", color:"#0369a1", fontSize:12, padding:0 }}>✏️</button>
                {isAdmin && <button onClick={()=>deleteClient(c.id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#dc2626", fontSize:12, padding:0 }}>✕</button>}
              </div>
            </div>
            {c.telephone && <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>📞 {c.telephone}</div>}
            {c.adresse && <div style={{ fontSize:12, color:"#6b7280" }}>📍 {c.adresse}</div>}
            <div style={{ fontSize:19, fontWeight:900, color:c.encours>0?"#7c3aed":"#047857", marginTop:8 }}>{fmt(c.encours)}</div>
            <div style={{ fontSize:11, color:"#9ca3af" }}>encours dû</div>
          </div>
        ))}
        {data.clients.length===0 && (
          <div style={{ gridColumn:"1/-1", textAlign:"center", padding:32, color:"#9ca3af", background:"#fff", borderRadius:10 }}>
            Aucun client — cliquez sur "Nouveau client" pour commencer
          </div>
        )}
      </div>

      <Divider label="Historique des encaissements"/>
      <Table
        cols={["Date","Client","Montant","Mode","Note",""]}
        rows={[...data.recouvrements].sort((a,b)=>b.date.localeCompare(a.date)).map(r=>{
          const c=data.clients.find(x=>x.id===r.clientId);
          return [fmtDate(r.date),c?.nom||"—",<b style={{color:"#047857"}}>{fmt(r.montant)}</b>,modeLabel(r.mode)||"—",r.note||"—",
            <EditDeleteBtns isAdmin={isAdmin} onDelete={()=>deleteRecouv(r)}/>,
          ];
        })}
        empty="Aucun encaissement enregistré"
      />

      <Divider label="Encaissements divers / Tiers"/>
      <Table
        cols={["Date","Nom / Tiers","Motif","Mode","Montant","Note",""]}
        rows={[...(data.encaissementsDivers||[])].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>[
          fmtDate(e.date),<b>{e.nom}</b>,e.motif||"—",modeLabel(e.mode),<b style={{color:"#047857"}}>{fmt(e.montant)}</b>,e.note||"—",
          <EditDeleteBtns isAdmin={isAdmin} onDelete={()=>deleteDivers(e.id)}/>,
        ])}
        empty="Aucun encaissement divers"
      />

      {modal && (
        <Modal title="Enregistrer un encaissement" onClose={()=>setModal(false)}>
          <Field label="Client" required>
            <Select value={form.clientId} onChange={e=>setForm({...form,clientId:e.target.value})}>
              <option value="">— Sélectionner —</option>
              {data.clients.filter(c=>c.encours>0).map(c=><option key={c.id} value={c.id}>{c.nom} — {fmt(c.encours)} dû</option>)}
            </Select>
          </Field>
          <Row>
            <Field label="Montant (FCFA)" required half><Input type="number" value={form.montant} onChange={e=>setForm({...form,montant:e.target.value})}/></Field>
            <Field label="Date" required half><Input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></Field>
          </Row>
          <Field label="Mode de paiement">
            <Select value={form.mode} onChange={e=>setForm({...form,mode:e.target.value})}>
              {MODES.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          </Field>
          <Field label="Note"><Input value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={add} disabled={!form.clientId||!form.montant}>Enregistrer</Btn>
          </div>
        </Modal>
      )}

      {diversModal && (
        <Modal title="💰 Encaissement divers / Tiers" onClose={()=>setDiversModal(false)}>
          <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:13, color:"#166534" }}>
            Pour tout encaissement hors client à crédit.
          </div>
          <Field label="Nom / Identité du tiers" required>
            <Input value={diversForm.nom} onChange={e=>setDiversForm({...diversForm,nom:e.target.value})} placeholder="Ex: M. Traoré, Mairie..."/>
          </Field>
          <Field label="Motif / Objet">
            <Input value={diversForm.motif} onChange={e=>setDiversForm({...diversForm,motif:e.target.value})} placeholder="Ex: remboursement avance..."/>
          </Field>
          <Row>
            <Field label="Montant (FCFA)" required half><Input type="number" value={diversForm.montant} onChange={e=>setDiversForm({...diversForm,montant:e.target.value})}/></Field>
            <Field label="Date" required half><Input type="date" value={diversForm.date} onChange={e=>setDiversForm({...diversForm,date:e.target.value})}/></Field>
          </Row>
          <Field label="Mode de paiement">
            <Select value={diversForm.mode} onChange={e=>setDiversForm({...diversForm,mode:e.target.value})}>
              {MODES.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
            </Select>
          </Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setDiversModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={addDivers} disabled={!diversForm.montant||!diversForm.nom}>Enregistrer</Btn>
          </div>
        </Modal>
      )}

      {clientModal && (
        <Modal title={editClient?"Modifier le client":"Nouveau client à crédit"} onClose={()=>setClientModal(false)}>
          <Field label="Nom / Raison sociale" required>
            <Input value={cForm.nom} onChange={e=>setCForm({...cForm,nom:e.target.value})} placeholder="Ex: Hôpital Central, M. Koné..."/>
          </Field>
          <Row>
            <Field label="Téléphone" half><Input value={cForm.telephone} onChange={e=>setCForm({...cForm,telephone:e.target.value})} placeholder="+225 ..."/></Field>
            <Field label="Encours initial (FCFA)" half><Input type="number" value={cForm.encours} onChange={e=>setCForm({...cForm,encours:e.target.value})} placeholder="0"/></Field>
          </Row>
          <Field label="Adresse / Localité">
            <Input value={cForm.adresse} onChange={e=>setCForm({...cForm,adresse:e.target.value})} placeholder="Ex: Abidjan, Cocody..."/>
          </Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setClientModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={saveClient} disabled={!cForm.nom}>{editClient?"Enregistrer":"Créer le client"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── VERSEMENTS BANQUE ────────────────────────────────────────────────────────
function Versements({ data, setRaw, user }) {
  const isAdmin = user?.role === 'admin';
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ date:today(), banque:"", bordereau:"", montant:"", source:"pharmacie", typeVers:"especes", note:"" });

  const add = async () => {
    if (!form.montant) return;
    const id = uid();
    const localRow = { ...form, id, montant:Number(form.montant) };
    const supaRow = { id, date:form.date, banque:form.banque||null, bordereau:form.bordereau||null, montant:Number(form.montant), source:form.source, type_vers:form.typeVers, note:form.note||null };
    await dbInsert("versements_banque", supaRow, setRaw, data, "versementsBanque", localRow);
    setModal(false); setForm({ date:today(), banque:"", bordereau:"", montant:"", source:"pharmacie", typeVers:"especes", note:"" });
  };

  const deleteVers = async (id) => {
    if (!confirm("Supprimer ce versement ?")) return;
    await dbDelete("versements_banque", id, setRaw, data, "versementsBanque");
  };

  const vers = [...data.versementsBanque].sort((a,b)=>b.date.localeCompare(a.date));

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Versements banque</h2>
        <Btn onClick={()=>setModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Nouveau versement</span></Btn>
      </div>
      <Table
        cols={["Date","Banque","N° Bordereau","Source","Type fonds","Montant","Note",""]}
        rows={vers.map(v=>{
          const src = v.source==="pharmacie"?"🏥 Centrale":((data.depots||[]).find(d=>d.id===v.source)?.nom||"—");
          const tv = v.typeVers;
          const tvLabel = !tv||tv==="especes"?<Badge color="#0369a1">💵 Espèces</Badge>
            :(() => { const op=MODES_MOBILE.find(m=>m.value===tv); return op?<Badge color={op.color}>{op.label}</Badge>:<Badge color="#6b7280">{tv}</Badge>; })();
          return [fmtDate(v.date),v.banque||"—",v.bordereau||"—",src,tvLabel,<b style={{color:"#0369a1"}}>{fmt(v.montant)}</b>,v.note||"—",
            <EditDeleteBtns isAdmin={isAdmin} onDelete={()=>deleteVers(v.id)}/>,
          ];
        })}
        empty="Aucun versement"
      />
      {modal && (
        <Modal title="Enregistrer un versement banque" onClose={()=>setModal(false)}>
          <Row>
            <Field label="Date" required half><Input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></Field>
            <Field label="Banque" required half><Input value={form.banque} onChange={e=>setForm({...form,banque:e.target.value})} placeholder="SGBCI, BNI..."/></Field>
          </Row>
          <Field label="N° Bordereau"><Input value={form.bordereau} onChange={e=>setForm({...form,bordereau:e.target.value})}/></Field>
          <Field label="Source (point de vente)">
            <Select value={form.source} onChange={e=>setForm({...form,source:e.target.value})}>
              <option value="pharmacie">🏥 Pharmacie centrale</option>
              {(data.depots||[]).map(d=><option key={d.id} value={d.id}>📍 {d.nom}</option>)}
            </Select>
          </Field>
          <Field label="Type de fonds versés" required>
            <Select value={form.typeVers} onChange={e=>setForm({...form,typeVers:e.target.value})}>
              <option value="especes">💵 Espèces (caisse physique)</option>
              {MODES_MOBILE.map(m=><option key={m.value} value={m.value}>{m.label} (compte mobile)</option>)}
            </Select>
          </Field>
          <Field label="Montant (FCFA)" required><Input type="number" value={form.montant} onChange={e=>setForm({...form,montant:e.target.value})}/></Field>
          <Field label="Note"><Input value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={add} disabled={!form.montant}>Enregistrer</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── DÉPÔTS EXTERNES ─────────────────────────────────────────────────────────
function Depots({ data, setRaw, user }) {
  const isAdmin = user?.role === 'admin';
  const [verseModal, setVerseModal] = useState(false);
  const [depotModal, setDepotModal] = useState(false);
  const [vForm, setVForm] = useState({ depotId:"", montant:"", date:today(), caissiere:"", note:"" });
  const [dForm, setDForm] = useState({ nom:"", localite:"" });

  const addVerse = async () => {
    if (!vForm.depotId||!vForm.montant) return;
    const id = uid();
    const localRow = { ...vForm, id, montant:Number(vForm.montant) };
    const supaRow = { id, depot_id:vForm.depotId, date:vForm.date, montant:Number(vForm.montant), caissiere:vForm.caissiere||null, note:vForm.note||null };
    await dbInsert("verse_depots", supaRow, setRaw, data, "verseDepots", localRow);
    setVerseModal(false); setVForm({ depotId:"", montant:"", date:today(), caissiere:"", note:"" });
  };

  const addDepot = async () => {
    if (!dForm.nom) return;
    const id = uid();
    const localRow = { id, ...dForm };
    const supaRow = { id, nom:dForm.nom, localite:dForm.localite||null };
    await dbInsert("depots", supaRow, setRaw, data, "depots", localRow);
    setDepotModal(false); setDForm({ nom:"", localite:"" });
  };

  const removeDepot = async (id) => {
    if (!confirm("Supprimer ce dépôt ?")) return;
    await dbDelete("depots", id, setRaw, data, "depots");
  };

  const deleteVerseDepot = async (id) => {
    if (!confirm("Supprimer ce versement ?")) return;
    await dbDelete("verse_depots", id, setRaw, data, "verseDepots");
  };

  const caissiers = [...new Set([
    ...data.users.filter(u=>u.role==="caissier"||u.role==="admin").map(u=>u.name),
    ...(data.responsables||[]).map(r=>r.nom),
  ])];

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:10 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Dépôts externes</h2>
        <div style={{ display:"flex", gap:8 }}>
          {isAdmin && <Btn variant="ghost" onClick={()=>setDepotModal(true)} style={{ fontSize:13 }}>+ Nouveau dépôt</Btn>}
          <Btn onClick={()=>setVerseModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Réceptionner versement</span></Btn>
        </div>
      </div>

      <Divider label="Liste des dépôts"/>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))", gap:12, marginBottom:22 }}>
        {data.depots.map(dep=>{
          const recTot   = data.recettes.filter(r=>r.source===dep.id).reduce((s,r)=>s+Number(r.montant||0),0);
          const verseTot = (data.verseDepots||[]).filter(v=>v.depotId===dep.id).reduce((s,v)=>s+Number(v.montant||0),0);
          return (
            <div key={dep.id} style={{ background:"#fff", borderRadius:12, padding:18, boxShadow:"0 1px 6px #0001", borderTop:"3px solid #7c3aed" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontWeight:800, fontSize:15 }}>📍 {dep.nom}</div>
                  <div style={{ fontSize:12, color:"#6b7280", marginBottom:10 }}>{dep.localite}</div>
                </div>
                {isAdmin && <button onClick={()=>removeDepot(dep.id)} style={{ background:"none", border:"none", cursor:"pointer", color:"#dc2626", fontSize:12 }}>✕</button>}
              </div>
              <div style={{ fontSize:12, color:"#6b7280" }}>Recettes totales</div>
              <div style={{ fontWeight:800, fontSize:17, color:"#0369a1" }}>{fmt(recTot)}</div>
              <div style={{ fontSize:12, color:"#6b7280", marginTop:6 }}>Versé à la centrale</div>
              <div style={{ fontWeight:800, fontSize:15, color:"#047857" }}>{fmt(verseTot)}</div>
              {recTot-verseTot>0 && <div style={{ fontSize:12, color:"#dc2626", fontWeight:600, marginTop:4 }}>Non versé : {fmt(recTot-verseTot)}</div>}
            </div>
          );
        })}
      </div>

      <Divider label="Historique des versements reçus"/>
      <Table
        cols={["Date","Dépôt","Responsable","Montant reçu","Note",""]}
        rows={[...(data.verseDepots||[])].sort((a,b)=>b.date.localeCompare(a.date)).map(v=>{
          const dep=data.depots.find(d=>d.id===v.depotId);
          return [fmtDate(v.date),dep?.nom||"—",v.caissiere||"—",<b style={{color:"#047857"}}>{fmt(v.montant)}</b>,v.note||"—",
            <EditDeleteBtns isAdmin={isAdmin} onDelete={()=>deleteVerseDepot(v.id)}/>,
          ];
        })}
        empty="Aucun versement reçu"
      />

      {verseModal && (
        <Modal title="Réceptionner un versement de dépôt" onClose={()=>setVerseModal(false)}>
          <Field label="Dépôt" required>
            <Select value={vForm.depotId} onChange={e=>setVForm({...vForm,depotId:e.target.value})}>
              <option value="">— Sélectionner —</option>
              {data.depots.map(d=><option key={d.id} value={d.id}>{d.nom} ({d.localite})</option>)}
            </Select>
          </Field>
          <Row>
            <Field label="Montant reçu (FCFA)" required half><Input type="number" value={vForm.montant} onChange={e=>setVForm({...vForm,montant:e.target.value})}/></Field>
            <Field label="Date" required half><Input type="date" value={vForm.date} onChange={e=>setVForm({...vForm,date:e.target.value})}/></Field>
          </Row>
          <Field label="Responsable du dépôt">
            <Input list="dep-caissieres" value={vForm.caissiere} onChange={e=>setVForm({...vForm,caissiere:e.target.value})} placeholder="Nom du responsable"/>
            <datalist id="dep-caissieres">{caissiers.map(c=><option key={c} value={c}/>)}</datalist>
          </Field>
          <Field label="Note"><Input value={vForm.note} onChange={e=>setVForm({...vForm,note:e.target.value})}/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setVerseModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={addVerse} disabled={!vForm.depotId||!vForm.montant}>Enregistrer</Btn>
          </div>
        </Modal>
      )}

      {depotModal && (
        <Modal title="Créer un nouveau dépôt externe" onClose={()=>setDepotModal(false)}>
          <Field label="Nom du dépôt" required><Input value={dForm.nom} onChange={e=>setDForm({...dForm,nom:e.target.value})} placeholder="Ex: Dépôt Village"/></Field>
          <Field label="Localité / Village"><Input value={dForm.localite} onChange={e=>setDForm({...dForm,localite:e.target.value})}/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setDepotModal(false)}>Annuler</Btn>
            <Btn onClick={addDepot} disabled={!dForm.nom}>Créer le dépôt</Btn>
          </div>
        </Modal>
      )}

      <ResponsablesSection data={data} setRaw={setRaw} isAdmin={isAdmin}/>
    </div>
  );
}

// ─── DÉPENSES ────────────────────────────────────────────────────────────────
function Depenses({ data, setRaw, user }) {
  const isAdmin = user?.role === 'admin';
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ date:today(), categorie:"loyer", libelle:"", montant:"", mode:"especes", note:"" });
  const CATS = ["loyer","salaires","eau/électricité","transport","fournitures","maintenance","communication","divers"];

  const [editRow, setEditRow] = useState(null);

  const add = async () => {
    if (!form.montant||!form.libelle) return;
    if (editRow) {
      const supaRow = { date:form.date, categorie:form.categorie, libelle:form.libelle, montant:Number(form.montant), mode:form.mode, note:form.note||null };
      await dbUpdate("depenses", editRow.id, supaRow, setRaw, data, "depenses", d=>d.id===editRow.id?{...d,...supaRow,montant:Number(form.montant)}:d);
      setEditRow(null);
    } else {
      const id = uid();
      const localRow = { ...form, id, montant:Number(form.montant) };
      const supaRow = { id, date:form.date, categorie:form.categorie, libelle:form.libelle, montant:Number(form.montant), mode:form.mode, note:form.note||null };
      await dbInsert("depenses", supaRow, setRaw, data, "depenses", localRow);
    }
    setModal(false); setForm({ date:today(), categorie:"loyer", libelle:"", montant:"", mode:"especes", note:"" });
  };

  const deleteDep = async (id) => {
    if (!confirm("Supprimer cette dépense ?")) return;
    await dbDelete("depenses", id, setRaw, data, "depenses");
  };

  const depenses = [...data.depenses].sort((a,b)=>b.date.localeCompare(a.date));
  const bycat = CATS.map(c=>({ cat:c, total:depenses.filter(d=>d.categorie===c).reduce((s,d)=>s+d.montant,0) })).filter(x=>x.total>0);

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Dépenses</h2>
        <Btn onClick={()=>setModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Nouvelle dépense</span></Btn>
      </div>
      {bycat.length>0 && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))", gap:8, marginBottom:18 }}>
          {bycat.map(x=>(
            <div key={x.cat} style={{ background:"#fff7ed", borderRadius:8, padding:"10px 14px", borderLeft:"3px solid #ea580c" }}>
              <div style={{ fontSize:11, color:"#9a3412", fontWeight:700, textTransform:"capitalize" }}>{x.cat}</div>
              <div style={{ fontWeight:800, fontSize:15 }}>{fmt(x.total)}</div>
            </div>
          ))}
        </div>
      )}
      <Table
        cols={["Date","Catégorie","Libellé","Mode","Montant"]}
        rows={depenses.map(d=>[fmtDate(d.date),d.categorie,d.libelle,modeLabel(d.mode),<b style={{color:"#dc2626"}}>{fmt(d.montant)}</b>])}
        empty="Aucune dépense"
      />
      {modal && (
        <Modal title={editRow?"Modifier la dépense":"Enregistrer une dépense"} onClose={()=>{setModal(false);setEditRow(null);}}>
          <Row>
            <Field label="Date" required half><Input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></Field>
            <Field label="Catégorie" required half>
              <Select value={form.categorie} onChange={e=>setForm({...form,categorie:e.target.value})}>
                {CATS.map(c=><option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
          </Row>
          <Field label="Libellé" required><Input value={form.libelle} onChange={e=>setForm({...form,libelle:e.target.value})} placeholder="Description de la dépense"/></Field>
          <Row>
            <Field label="Mode" half>
              <Select value={form.mode} onChange={e=>setForm({...form,mode:e.target.value})}>
                {MODES.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Field>
            <Field label="Montant (FCFA)" required half><Input type="number" value={form.montant} onChange={e=>setForm({...form,montant:e.target.value})}/></Field>
          </Row>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn variant="danger" onClick={add} disabled={!form.montant||!form.libelle}>{editRow?"Modifier":"Enregistrer"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── FACTURES ─────────────────────────────────────────────────────────────────
function Factures({ data, setRaw, user }) {
  const isAdmin = user?.role === 'admin';
  const [modal, setModal] = useState(false);
  const [reglModal, setReglModal] = useState(null);
  const [form, setForm] = useState({ date:today(), fournisseurId:"", numero:"", montant:"", echeance:"", note:"" });
  const [rForm, setRForm] = useState({ date:today(), montant:"", mode:"virement" });

  const addF = () => {
    if (!form.montant||!form.fournisseurId) return;
    setRaw({ ...data, factures:[...data.factures,{...form,id:uid(),montant:Number(form.montant),statut:"reçue"}] });
    setModal(false); setForm({ date:today(), fournisseurId:"", numero:"", montant:"", echeance:"", note:"" });
  };

  const addR = () => {
    if (!rForm.montant) return;
    const montant=Number(rForm.montant);
    const f=data.factures.find(x=>x.id===reglModal);
    const totalRegle=data.reglements.filter(r=>r.factureId===reglModal).reduce((s,r)=>s+r.montant,0)+montant;
    const statut=totalRegle>=f.montant?"soldée":"partiellement réglée";
    setRaw({ ...data,
      reglements:[...data.reglements,{...rForm,id:uid(),factureId:reglModal,montant}],
      factures:data.factures.map(x=>x.id===reglModal?{...x,statut}:x),
    });
    setReglModal(null); setRForm({ date:today(), montant:"", mode:"virement" });
  };

  const getRegle=(id)=>data.reglements.filter(r=>r.factureId===id).reduce((s,r)=>s+r.montant,0);
  const sc={ "reçue":"#f59e0b","partiellement réglée":"#0891b2","soldée":"#047857" };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Factures fournisseurs</h2>
        <Btn onClick={()=>setModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Nouvelle facture</span></Btn>
      </div>
      <Table
        cols={["Date","Fournisseur","N° Facture","Total TTC","Réglé","Reste","Statut","Échéance",""]}
        rows={[...data.factures].sort((a,b)=>b.date.localeCompare(a.date)).map(f=>{
          const fourn=data.fournisseurs.find(x=>x.id===f.fournisseurId);
          const regle=getRegle(f.id); const reste=f.montant-regle;
          const retard=f.echeance&&new Date(f.echeance)<new Date()&&f.statut!=="soldée";
          return [
            fmtDate(f.date), fourn?.nom||"—", f.numero||"—",
            fmt(f.montant),
            <span style={{color:"#047857",fontWeight:700}}>{fmt(regle)}</span>,
            <span style={{color:reste>0?"#dc2626":"#047857",fontWeight:700}}>{fmt(reste)}</span>,
            <Badge color={sc[f.statut]||"#6b7280"}>{f.statut}</Badge>,
            <span style={{color:retard?"#dc2626":"#374151"}}>{fmtDate(f.echeance)}{retard?" ⚠️":""}</span>,
            f.statut!=="soldée"?<Btn variant="ghost" style={{fontSize:12,padding:"4px 10px"}} onClick={()=>setReglModal(f.id)}>Régler</Btn>:null,
          ];
        })}
        empty="Aucune facture"
      />

      {modal && (
        <Modal title="Nouvelle facture fournisseur" onClose={()=>setModal(false)}>
          <Field label="Fournisseur" required>
            <Select value={form.fournisseurId} onChange={e=>setForm({...form,fournisseurId:e.target.value})}>
              <option value="">— Sélectionner —</option>
              {data.fournisseurs.map(f=><option key={f.id} value={f.id}>{f.nom}</option>)}
            </Select>
          </Field>
          <Row>
            <Field label="N° Facture" half><Input value={form.numero} onChange={e=>setForm({...form,numero:e.target.value})} placeholder="FAC-001"/></Field>
            <Field label="Date réception" required half><Input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></Field>
          </Row>
          <Row>
            <Field label="Date d'échéance" half><Input type="date" value={form.echeance} onChange={e=>setForm({...form,echeance:e.target.value})}/></Field>
            <Field label="Montant TTC (FCFA)" required half><Input type="number" value={form.montant} onChange={e=>setForm({...form,montant:e.target.value})}/></Field>
          </Row>
          <Field label="Note"><Textarea value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn onClick={addF} disabled={!form.montant||!form.fournisseurId}>Enregistrer</Btn>
          </div>
        </Modal>
      )}

      {reglModal && (() => {
        const f=data.factures.find(x=>x.id===reglModal);
        const regle=getRegle(reglModal);
        return (
          <Modal title="Enregistrer un règlement" onClose={()=>setReglModal(null)}>
            <div style={{ background:"#f0f9ff", borderRadius:8, padding:12, marginBottom:16, fontSize:14 }}>
              <b>Reste à payer :</b> {fmt(f.montant-regle)} sur {fmt(f.montant)}
            </div>
            <Row>
              <Field label="Date" required half><Input type="date" value={rForm.date} onChange={e=>setRForm({...rForm,date:e.target.value})}/></Field>
              <Field label="Montant (FCFA)" required half><Input type="number" value={rForm.montant} max={f.montant-regle} onChange={e=>setRForm({...rForm,montant:e.target.value})}/></Field>
            </Row>
            <Field label="Mode">
              <Select value={rForm.mode} onChange={e=>setRForm({...rForm,mode:e.target.value})}>
                {MODES.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Field>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <Btn variant="ghost" onClick={()=>setReglModal(null)}>Annuler</Btn>
              <Btn variant="success" onClick={addR} disabled={!rForm.montant}>Valider règlement</Btn>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

// ─── UTILISATEURS ─────────────────────────────────────────────────────────────
function Utilisateurs({ data, setRaw, currentUser }) {
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name:"", email:"", password:"", role:"caissier" });

  const add = async () => {
    if (!form.name||!form.email||!form.password) return;
    const id = uid();
    const localRow = { ...form, id };
    const supaRow = { id, name:form.name, email:form.email, password:form.password, role:form.role };
    await dbInsert("utilisateurs", supaRow, setRaw, data, "users", localRow);
    setModal(false); setForm({ name:"", email:"", password:"", role:"caissier" });
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Gestion des utilisateurs</h2>
        <Btn onClick={()=>setModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Ajouter</span></Btn>
      </div>
      <Table
        cols={["Nom","Email","Rôle","Modules accessibles",""]}
        rows={data.users.map(u=>[
          u.name, u.email,
          <Badge color={ROLES[u.role]?.color}>{ROLES[u.role]?.label}</Badge>,
          <span style={{fontSize:12,color:"#6b7280"}}>{ROLES[u.role]?.modules.join(", ")}</span>,
          u.id!==currentUser.id
            ? <Btn variant="danger" style={{fontSize:12,padding:"4px 10px"}} onClick={async()=>{ if(confirm("Supprimer ?")) await dbDelete("utilisateurs",u.id,setRaw,data,"users"); }}>Supprimer</Btn>
            : <span style={{fontSize:12,color:"#9ca3af"}}>Vous</span>,
        ])}
      />
      {modal && (
        <Modal title="Nouvel utilisateur" onClose={()=>setModal(false)}>
          <Field label="Nom complet" required><Input value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field>
          <Row>
            <Field label="Email" required half><Input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></Field>
            <Field label="Mot de passe" required half><Input type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></Field>
          </Row>
          <Field label="Rôle" required>
            <Select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>
              {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
          <div style={{ background:"#f0f9ff", borderRadius:8, padding:10, fontSize:13, marginBottom:14 }}>
            <b>Modules accessibles :</b> {ROLES[form.role]?.modules.join(", ")}
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn onClick={add} disabled={!form.name||!form.email||!form.password}>Créer</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}



// ─── CLÔTURE DE CAISSE ───────────────────────────────────────────────────────
function ClotureCaisse({ data, setRaw, user }) {
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ date:today(), tranche:"jour", caissiere:"", montantPhysique:"", note:"" });

  const caissiers = [...new Set([
    ...data.users.filter(u=>u.role==="caissier"||u.role==="admin").map(u=>u.name),
    ...(data.responsables||[]).map(r=>r.nom),
  ])];

  // Calcul montant théorique de la tranche
  const calcTheorique = (date, tranche) => {
    return data.recettes
      .filter(r=>r.date===date&&r.source==="pharmacie"&&r.tranche===tranche)
      .reduce((s,r)=>s+Number(r.montant||0),0);
  };

  const add = async () => {
    if (!form.montantPhysique) return;
    const theorique = calcTheorique(form.date, form.tranche);
    const physique  = Number(form.montantPhysique);
    const ecart     = physique - theorique;
    const id = uid();
    const localRow = { id, date:form.date, tranche:form.tranche, caissiere:form.caissiere, montantTheorique:theorique, montantPhysique:physique, ecart, note:form.note||"" };
    const supaRow  = { id, date:form.date, tranche:form.tranche, caissiere:form.caissiere||null, montant_theorique:theorique, montant_physique:physique, ecart, note:form.note||null };
    await dbInsert("clotures", supaRow, setRaw, data, "clotures", localRow);
    setModal(false); setForm({ date:today(), tranche:"jour", caissiere:"", montantPhysique:"", note:"" });
  };

  const theorique = calcTheorique(form.date, form.tranche);
  const physique  = Number(form.montantPhysique||0);
  const ecart     = physique - theorique;

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Clôture de caisse</h2>
        <Btn onClick={()=>setModal(true)}><span style={{ display:"flex", alignItems:"center", gap:6 }}><Icon name="plus" size={15}/>Nouvelle clôture</span></Btn>
      </div>

      <Table
        cols={["Date","Tranche","Caissière","Montant théorique","Montant physique","Écart","Statut","Note"]}
        rows={[...(data.clotures||[])].sort((a,b)=>b.date.localeCompare(a.date)).map(c=>{
          const ok = Math.abs(c.ecart) < 100;
          return [
            fmtDate(c.date),
            c.tranche==="jour"?<Badge color="#f59e0b">☀️ Jour</Badge>:<Badge color="#1e40af">🌙 Nuit</Badge>,
            c.caissiere||"—",
            fmt(c.montantTheorique),
            fmt(c.montantPhysique),
            <b style={{color:c.ecart===0?"#047857":c.ecart>0?"#0369a1":"#dc2626"}}>{c.ecart>0?"+":""}{fmt(c.ecart)}</b>,
            <Badge color={ok?"#047857":"#dc2626"}>{ok?"✅ Conforme":"⚠️ Écart"}</Badge>,
            c.note||"—",
          ];
        })}
        empty="Aucune clôture enregistrée"
      />

      {modal && (
        <Modal title="Clôture de caisse" onClose={()=>setModal(false)}>
          <Row>
            <Field label="Date" required half><Input type="date" value={form.date} onChange={e=>setForm({...form,date:e.target.value})}/></Field>
            <Field label="Tranche" required half>
              <Select value={form.tranche} onChange={e=>setForm({...form,tranche:e.target.value})}>
                <option value="jour">☀️ Jour (7h30–17h30)</option>
                <option value="nuit">🌙 Nuit (17h30–7h30)</option>
              </Select>
            </Field>
          </Row>
          <Field label="Caissière responsable">
            <Input list="cl-caissieres" value={form.caissiere} onChange={e=>setForm({...form,caissiere:e.target.value})} placeholder="Nom de la caissière"/>
            <datalist id="cl-caissieres">{caissiers.map(c=><option key={c} value={c}/>)}</datalist>
          </Field>
          <div style={{ background:"#f0f9ff", borderRadius:10, padding:"14px 16px", marginBottom:14 }}>
            <div style={{ fontSize:12, color:"#0369a1", fontWeight:700, marginBottom:6 }}>MONTANT THÉORIQUE (calculé)</div>
            <div style={{ fontSize:22, fontWeight:900, color:"#0369a1" }}>{fmt(calcTheorique(form.date, form.tranche))}</div>
            <div style={{ fontSize:12, color:"#6b7280", marginTop:4 }}>Somme des recettes espèces enregistrées pour cette tranche</div>
          </div>
          <Field label="Montant physique compté (FCFA)" required>
            <Input type="number" value={form.montantPhysique} onChange={e=>setForm({...form,montantPhysique:e.target.value})} placeholder="Montant réellement compté en caisse"/>
          </Field>
          {form.montantPhysique && (
            <div style={{ background:ecart===0?"#f0fdf4":ecart>0?"#eff6ff":"#fef2f2", borderRadius:8, padding:"10px 14px", marginBottom:14 }}>
              <div style={{ fontSize:13, fontWeight:700, color:ecart===0?"#047857":ecart>0?"#0369a1":"#dc2626" }}>
                Écart : {ecart>0?"+":""}{fmt(ecart)}
                {ecart===0?" ✅ Conforme":ecart>0?" ➕ Excédent":" ➖ Déficit"}
              </div>
            </div>
          )}
          <Field label="Note"><Input value={form.note} onChange={e=>setForm({...form,note:e.target.value})} placeholder="Observation éventuelle"/></Field>
          <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
            <Btn variant="ghost" onClick={()=>setModal(false)}>Annuler</Btn>
            <Btn variant="success" onClick={add} disabled={!form.montantPhysique}>Clôturer</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── VUE GÉRANT SIMPLIFIÉE ───────────────────────────────────────────────────
function GerantDashboard({ data }) {
  const soldes = calcSoldes(data);
  const recToday = data.recettes.filter(r=>r.date===today()).reduce((s,r)=>s+Number(r.montant||0),0);
  const recEspToday = data.recettes.filter(r=>r.date===today()&&isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
  const recMobToday = data.recettes.filter(r=>r.date===today()&&isMobileMoney(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
  const depToday = data.depenses.filter(d=>d.date===today()).reduce((s,d)=>s+Number(d.montant||0),0);
  const versBankToday = data.versementsBanque.filter(v=>v.date===today()).reduce((s,v)=>s+Number(v.montant||0),0);
  const recouvrToday = data.recouvrements.filter(r=>r.date===today()).reduce((s,r)=>s+Number(r.montant||0),0);

  // Alertes dépôts
  const depotsAlerte = (data.depots||[]).filter(dep => {
    const vers = (data.verseDepots||[]).filter(v=>v.depotId===dep.id);
    if (!vers.length) return true;
    const dernier = vers.map(v=>v.date).sort().reverse()[0];
    const jours = Math.floor((new Date(today())-new Date(dernier))/(1000*60*60*24));
    return jours >= ALERT_DEPOT_JOURS;
  });

  return (
    <div>
      <h2 style={{ margin:"0 0 4px", fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Vue Gérant</h2>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:20 }}>
        <p style={{ margin:0, fontSize:13, color:"#6b7280" }}>{new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
        <div style={{ display:"flex", gap:8 }}>
          <Btn variant="ghost" style={{ fontSize:13 }} onClick={()=>generatePDF(data,"jour")}>📄 PDF Journalier</Btn>
          <Btn variant="ghost" style={{ fontSize:13 }} onClick={()=>generatePDF(data,"mois")}>📄 PDF Mensuel</Btn>
        </div>
      </div>

      {depotsAlerte.length>0 && (
        <div style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:10, padding:"12px 16px", marginBottom:16 }}>
          <div style={{ fontWeight:700, color:"#ea580c", marginBottom:6 }}>⚠️ {depotsAlerte.length} dépôt(s) sans versement depuis {ALERT_DEPOT_JOURS}+ jours</div>
          {depotsAlerte.map(d=><div key={d.id} style={{ fontSize:13, color:"#9a3412" }}>• {d.nom}</div>)}
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:20 }}>
        {[
          { label:"CA du jour", value:fmt(recToday), color:"#047857", sub:`💵 ${fmt(recEspToday)} + 📱 ${fmt(recMobToday)}` },
          { label:"Dépenses du jour", value:fmt(depToday), color:"#dc2626", sub:"Toutes catégories" },
          { label:"Versé en banque", value:fmt(versBankToday), color:"#0891b2", sub:"Aujourd'hui" },
          { label:"Recouvrement", value:fmt(recouvrToday), color:"#b45309", sub:"Aujourd'hui" },
          { label:"💵 Solde caisse", value:fmt(soldes.soldeEspeces), color:soldes.soldeEspeces<ALERT_SEUIL_CAISSE?"#dc2626":"#047857", sub:soldes.soldeEspeces<ALERT_SEUIL_CAISSE?"⚠️ En dessous du seuil":"✅ Normal" },
          { label:"📱 Total Mobile Money", value:fmt(soldes.totalMobile), color:"#7c3aed", sub:"Tous opérateurs" },
        ].map((k,i)=>(
          <div key={i} style={{ background:"#fff", borderRadius:12, padding:"16px 18px", boxShadow:"0 1px 6px #0001", borderLeft:`4px solid ${k.color}` }}>
            <div style={{ fontSize:11, color:"#6b7280", fontWeight:700, textTransform:"uppercase", marginBottom:4 }}>{k.label}</div>
            <div style={{ fontSize:20, fontWeight:900, color:k.color }}>{k.value}</div>
            <div style={{ fontSize:11, color:"#9ca3af", marginTop:3 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Mobile money par opérateur */}
      <div style={{ background:"#fff", borderRadius:12, padding:"18px 20px", boxShadow:"0 1px 4px #0001" }}>
        <div style={{ fontSize:13, fontWeight:700, color:"#374151", marginBottom:12 }}>📱 Détail Mobile Money</div>
        {MODES_MOBILE.map(op=>{
          const s = soldes.soldeMobile[op.value];
          return (
            <div key={op.value} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #f0f0f0" }}>
              <span style={{ color:op.color, fontWeight:600 }}>{op.label}</span>
              <b style={{ color:op.color }}>{fmt(s.solde)}</b>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── HISTORIQUE CONNEXIONS ───────────────────────────────────────────────────
function ConnexionsPage({ data }) {
  return (
    <div>
      <h2 style={{ margin:"0 0 20px", fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Historique des connexions</h2>
      <Table
        cols={["Date","Heure","Utilisateur","Rôle","Appareil"]}
        rows={[...(data.connexions||[])].sort((a,b)=>b.date.localeCompare(a.date)||b.heure.localeCompare(a.heure)).map(c=>[
          fmtDate(c.date),
          c.heure,
          <b>{c.userName}</b>,
          <Badge color={ROLES[c.role]?.color||"#6b7280"}>{ROLES[c.role]?.label||c.role}</Badge>,
          c.navigateur==="Mobile"?"📱 Mobile":"🖥️ Desktop",
        ])}
        empty="Aucune connexion enregistrée"
      />
    </div>
  );
}

// ─── HISTORIQUE ──────────────────────────────────────────────────────────────
function Historique({ data }) {
  const [onglet, setOnglet] = useState("recettes");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo]     = useState("");
  const [sortCol, setSortCol]   = useState("date");
  const [sortDir, setSortDir]   = useState("desc");
  const [search, setSearch]     = useState("");

  const inPeriod = (date) => (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);

  const sortIcon = (col) => sortCol === col ? (sortDir === "asc" ? " ↑" : " ↓") : " ·";
  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  };
  const thStyle = (col) => ({
    padding:"10px 14px", textAlign:"left", fontWeight:700, color:"#374151",
    borderBottom:"2px solid #e5e7eb", whiteSpace:"nowrap", cursor:"pointer",
    background: sortCol===col ? "#f0f9ff" : "#f8fafc",
  });

  // ── RECETTES ──
  const recettes = data.recettes
    .filter(r => inPeriod(r.date) && (
      !search ||
      (data.depots.find(d=>d.id===r.source)?.nom||"centrale").toLowerCase().includes(search.toLowerCase()) ||
      (r.caissiere||"").toLowerCase().includes(search.toLowerCase()) ||
      modeLabel(r.mode).toLowerCase().includes(search.toLowerCase())
    ))
    .sort((a,b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (sortCol==="montant") { va=Number(va); vb=Number(vb); }
      return sortDir==="asc" ? (va>vb?1:-1) : (va<vb?1:-1);
    });
  const totRecEsp = recettes.filter(r=>isEspeces(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
  const totRecMob = recettes.filter(r=>isMobileMoney(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);

  // ── DÉPENSES ──
  const depenses = data.depenses
    .filter(d => inPeriod(d.date) && (
      !search ||
      d.libelle.toLowerCase().includes(search.toLowerCase()) ||
      d.categorie.toLowerCase().includes(search.toLowerCase()) ||
      modeLabel(d.mode).toLowerCase().includes(search.toLowerCase())
    ))
    .sort((a,b) => {
      let va = a[sortCol==="source"?"categorie":sortCol];
      let vb = b[sortCol==="source"?"categorie":sortCol];
      if (sortCol==="montant") { va=Number(a.montant); vb=Number(b.montant); }
      return sortDir==="asc" ? (va>vb?1:-1) : (va<vb?1:-1);
    });
  const totDep = depenses.reduce((s,d)=>s+Number(d.montant||0),0);

  // ── VERSEMENTS ──
  const versements = [
    ...data.versementsBanque.map(v=>({...v, type:"banque"})),
    ...(data.verseDepots||[]).map(v=>({...v, type:"depot", montant:v.montant, mode:"especes", date:v.date})),
  ]
    .filter(v => inPeriod(v.date) && (
      !search ||
      (v.banque||v.caissiere||"").toLowerCase().includes(search.toLowerCase()) ||
      (data.depots.find(d=>d.id===v.depotId)?.nom||"").toLowerCase().includes(search.toLowerCase())
    ))
    .sort((a,b) => {
      let va = a.date, vb = b.date;
      if (sortCol==="montant") { va=Number(a.montant); vb=Number(b.montant); }
      return sortDir==="asc" ? (va>vb?1:-1) : (va<vb?1:-1);
    });
  const totVers = versements.reduce((s,v)=>s+Number(v.montant||0),0);

  const ONGLETS = [
    { key:"recettes",  label:"💰 Recettes",          count: recettes.length  },
    { key:"depenses",  label:"💸 Dépenses",           count: depenses.length  },
    { key:"versements",label:"🏦 Versements",         count: versements.length},
  ];

  return (
    <div>
      <h2 style={{ margin:"0 0 16px", fontSize:20, fontWeight:900, color:"#0c4a6e" }}>Historique</h2>

      {/* Filtres */}
      <div style={{ background:"#fff", borderRadius:12, padding:"16px 18px", marginBottom:16, boxShadow:"0 1px 4px #0001" }}>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
          <Input
            placeholder="🔍 Rechercher..."
            value={search}
            onChange={e=>setSearch(e.target.value)}
            style={{ width:180, fontSize:13 }}
          />
          <Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{ width:"auto", fontSize:13 }}/>
          <span style={{ color:"#9ca3af" }}>→</span>
          <Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{ width:"auto", fontSize:13 }}/>
          <Btn variant="ghost" style={{ fontSize:12 }} onClick={()=>{ setDateFrom(""); setDateTo(""); setSearch(""); }}>Réinitialiser</Btn>
          <Btn variant="ghost" style={{ fontSize:12 }} onClick={()=>{ const d=today(); setDateFrom(d); setDateTo(d); }}>Aujourd'hui</Btn>
          <Btn variant="ghost" style={{ fontSize:12 }} onClick={()=>{
            const d=new Date(); const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,'0');
            setDateFrom(`${y}-${m}-01`); setDateTo(today());
          }}>Ce mois</Btn>
        </div>
      </div>

      {/* Onglets */}
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
        {ONGLETS.map(o=>(
          <button key={o.key} onClick={()=>setOnglet(o.key)} style={{
            padding:"8px 16px", borderRadius:20, border:"none", cursor:"pointer", fontSize:13, fontWeight:600,
            background: onglet===o.key ? "#0369a1" : "#f3f4f6",
            color: onglet===o.key ? "#fff" : "#374151",
          }}>
            {o.label} <span style={{ opacity:0.7, fontSize:12 }}>({o.count})</span>
          </button>
        ))}
      </div>

      {/* ── RECETTES ── */}
      {onglet==="recettes" && (
        <div>
          <div style={{ display:"flex", gap:10, marginBottom:12, flexWrap:"wrap" }}>
            <div style={{ background:"#f0f9ff", borderRadius:8, padding:"8px 14px", fontSize:13 }}>
              💵 Espèces : <b style={{color:"#0369a1"}}>{fmt(totRecEsp)}</b>
            </div>
            <div style={{ background:"#faf5ff", borderRadius:8, padding:"8px 14px", fontSize:13 }}>
              📱 Mobile : <b style={{color:"#7c3aed"}}>{fmt(totRecMob)}</b>
            </div>
            <div style={{ background:"#f0fdf4", borderRadius:8, padding:"8px 14px", fontSize:13 }}>
              Total : <b style={{color:"#047857"}}>{fmt(totRecEsp+totRecMob)}</b>
            </div>
          </div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:14 }}>
              <thead>
                <tr>
                  <th style={thStyle("date")} onClick={()=>toggleSort("date")}>Date{sortIcon("date")}</th>
                  <th style={thStyle("source")} onClick={()=>toggleSort("source")}>Source{sortIcon("source")}</th>
                  <th style={thStyle("tranche")}>Tranche</th>
                  <th style={thStyle("caissiere")} onClick={()=>toggleSort("caissiere")}>Caissière{sortIcon("caissiere")}</th>
                  <th style={thStyle("mode")} onClick={()=>toggleSort("mode")}>Mode{sortIcon("mode")}</th>
                  <th style={thStyle("montant")} onClick={()=>toggleSort("montant")}>Montant{sortIcon("montant")}</th>
                  <th style={{...thStyle("note")}}>Note</th>
                </tr>
              </thead>
              <tbody>
                {recettes.length===0
                  ? <tr><td colSpan={7} style={{padding:32,textAlign:"center",color:"#9ca3af"}}>Aucune recette</td></tr>
                  : recettes.map((r,i)=>{
                    const src = r.source==="pharmacie" ? "🏥 Centrale" : (data.depots.find(d=>d.id===r.source)?.nom||"Dépôt");
                    return (
                      <tr key={i} style={{borderBottom:"1px solid #f0f0f0", background:i%2?"#fafafa":"#fff"}}>
                        <td style={{padding:"9px 14px"}}>{fmtDate(r.date)}</td>
                        <td style={{padding:"9px 14px"}}>{src}</td>
                        <td style={{padding:"9px 14px"}}>
                          {r.source==="pharmacie"
                            ? (r.tranche==="jour"?<Badge color="#f59e0b">☀️ Jour</Badge>:<Badge color="#1e40af">🌙 Nuit</Badge>)
                            : <Badge color="#7c3aed">📍 Dépôt</Badge>}
                        </td>
                        <td style={{padding:"9px 14px"}}>{r.caissiere||"—"}</td>
                        <td style={{padding:"9px 14px"}}>{modeLabel(r.mode)}</td>
                        <td style={{padding:"9px 14px"}}><b style={{color:isEspeces(r.mode)?"#0369a1":"#7c3aed"}}>{fmt(r.montant)}</b></td>
                        <td style={{padding:"9px 14px",color:"#9ca3af"}}>{r.note||"—"}</td>
                      </tr>
                    );
                  })}
                {recettes.length>0 && (
                  <tr style={{background:"#f0fdf4",fontWeight:700}}>
                    <td colSpan={5} style={{padding:"10px 14px",color:"#047857"}}>TOTAL ({recettes.length} enregistrements)</td>
                    <td style={{padding:"10px 14px",color:"#047857",fontSize:15}}>{fmt(totRecEsp+totRecMob)}</td>
                    <td/>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── DÉPENSES ── */}
      {onglet==="depenses" && (
        <div>
          <div style={{ background:"#fff7ed", borderRadius:8, padding:"8px 14px", fontSize:13, marginBottom:12, display:"inline-block" }}>
            Total dépenses : <b style={{color:"#dc2626"}}>{fmt(totDep)}</b>
          </div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:14 }}>
              <thead>
                <tr>
                  <th style={thStyle("date")} onClick={()=>toggleSort("date")}>Date{sortIcon("date")}</th>
                  <th style={thStyle("categorie")} onClick={()=>toggleSort("categorie")}>Catégorie{sortIcon("categorie")}</th>
                  <th style={thStyle("libelle")} onClick={()=>toggleSort("libelle")}>Libellé{sortIcon("libelle")}</th>
                  <th style={thStyle("mode")} onClick={()=>toggleSort("mode")}>Mode{sortIcon("mode")}</th>
                  <th style={thStyle("montant")} onClick={()=>toggleSort("montant")}>Montant{sortIcon("montant")}</th>
                </tr>
              </thead>
              <tbody>
                {depenses.length===0
                  ? <tr><td colSpan={5} style={{padding:32,textAlign:"center",color:"#9ca3af"}}>Aucune dépense</td></tr>
                  : depenses.map((d,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #f0f0f0", background:i%2?"#fafafa":"#fff"}}>
                      <td style={{padding:"9px 14px"}}>{fmtDate(d.date)}</td>
                      <td style={{padding:"9px 14px"}}><Badge color="#ea580c">{d.categorie}</Badge></td>
                      <td style={{padding:"9px 14px"}}>{d.libelle}</td>
                      <td style={{padding:"9px 14px"}}>{modeLabel(d.mode)}</td>
                      <td style={{padding:"9px 14px"}}><b style={{color:"#dc2626"}}>{fmt(d.montant)}</b></td>
                    </tr>
                  ))}
                {depenses.length>0 && (
                  <tr style={{background:"#fff7ed",fontWeight:700}}>
                    <td colSpan={4} style={{padding:"10px 14px",color:"#dc2626"}}>TOTAL ({depenses.length} enregistrements)</td>
                    <td style={{padding:"10px 14px",color:"#dc2626",fontSize:15}}>{fmt(totDep)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── VERSEMENTS ── */}
      {onglet==="versements" && (
        <div>
          <div style={{ background:"#f0f9ff", borderRadius:8, padding:"8px 14px", fontSize:13, marginBottom:12, display:"inline-block" }}>
            Total versements : <b style={{color:"#0891b2"}}>{fmt(totVers)}</b>
          </div>
          <div style={{ overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:14 }}>
              <thead>
                <tr>
                  <th style={thStyle("date")} onClick={()=>toggleSort("date")}>Date{sortIcon("date")}</th>
                  <th style={thStyle("type")}>Type</th>
                  <th style={thStyle("banque")} onClick={()=>toggleSort("banque")}>Banque / Dépôt{sortIcon("banque")}</th>
                  <th style={thStyle("bordereau")}>N° Bordereau</th>
                  <th style={thStyle("typeVers")}>Fonds</th>
                  <th style={thStyle("montant")} onClick={()=>toggleSort("montant")}>Montant{sortIcon("montant")}</th>
                  <th style={thStyle("note")}>Note</th>
                </tr>
              </thead>
              <tbody>
                {versements.length===0
                  ? <tr><td colSpan={7} style={{padding:32,textAlign:"center",color:"#9ca3af"}}>Aucun versement</td></tr>
                  : versements.map((v,i)=>{
                    const isBanque = v.type==="banque";
                    const dest = isBanque ? (v.banque||"—") : (data.depots.find(d=>d.id===v.depotId)?.nom||"—");
                    const tv = v.typeVers;
                    const tvLabel = !tv||tv==="especes" ? <Badge color="#0369a1">💵 Espèces</Badge>
                      : (() => { const op=MODES_MOBILE.find(m=>m.value===tv); return op?<Badge color={op.color}>{op.label}</Badge>:<Badge color="#6b7280">{tv}</Badge>; })();
                    return (
                      <tr key={i} style={{borderBottom:"1px solid #f0f0f0", background:i%2?"#fafafa":"#fff"}}>
                        <td style={{padding:"9px 14px"}}>{fmtDate(v.date)}</td>
                        <td style={{padding:"9px 14px"}}>{isBanque ? <Badge color="#0891b2">🏦 Banque</Badge> : <Badge color="#7c3aed">📍 Dépôt→Centrale</Badge>}</td>
                        <td style={{padding:"9px 14px"}}>{dest}</td>
                        <td style={{padding:"9px 14px",color:"#9ca3af"}}>{v.bordereau||"—"}</td>
                        <td style={{padding:"9px 14px"}}>{isBanque ? tvLabel : <Badge color="#0369a1">💵 Espèces</Badge>}</td>
                        <td style={{padding:"9px 14px"}}><b style={{color:"#0891b2"}}>{fmt(v.montant)}</b></td>
                        <td style={{padding:"9px 14px",color:"#9ca3af"}}>{v.note||"—"}</td>
                      </tr>
                    );
                  })}
                {versements.length>0 && (
                  <tr style={{background:"#f0f9ff",fontWeight:700}}>
                    <td colSpan={5} style={{padding:"10px 14px",color:"#0891b2"}}>TOTAL ({versements.length} enregistrements)</td>
                    <td style={{padding:"10px 14px",color:"#0891b2",fontSize:15}}>{fmt(totVers)}</td>
                    <td/>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GÉNÉRATION PDF ──────────────────────────────────────────────────────────
function generatePDF(data, type = "jour") {
  const soldes = calcSoldes(data);
  const isJour = type === "jour";
  const dateLabel = isJour
    ? new Date().toLocaleDateString("fr-FR", { weekday:"long", day:"numeric", month:"long", year:"numeric" })
    : new Date().toLocaleDateString("fr-FR", { month:"long", year:"numeric" });

  const fmtN = (n) => new Intl.NumberFormat("fr-FR").format(Math.round(n||0)) + " FCFA";
  const filterFn = isJour
    ? (r) => r.date === today()
    : (r) => { const [ry,rm] = r.date.split("-"); const d=new Date(); return parseInt(rm)-1===d.getMonth()&&parseInt(ry)===d.getFullYear(); };

  const recettes = data.recettes.filter(filterFn);
  const depenses = data.depenses.filter(d=>filterFn(d));
  const versements = data.versementsBanque.filter(v=>filterFn(v));
  const totRec = recettes.reduce((s,r)=>s+Number(r.montant||0),0);
  const totDep = depenses.reduce((s,d)=>s+Number(d.montant||0),0);
  const totVers = versements.reduce((s,v)=>s+Number(v.montant||0),0);

  const rows = (arr, cols) => arr.map(r => `<tr>${cols.map(c=>`<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${c(r)}</td>`).join("")}</tr>`).join("");

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <title>PharmaCash — Rapport ${isJour?"Journalier":"Mensuel"}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; margin: 0; padding: 20px; font-size: 13px; }
    h1 { color: #0c4a6e; margin-bottom: 4px; }
    h2 { color: #0369a1; font-size: 15px; margin: 20px 0 8px; border-bottom: 2px solid #e5e7eb; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #f8fafc; padding: 8px 10px; text-align: left; font-weight: 700; color: #374151; border-bottom: 2px solid #e5e7eb; }
    td { padding: 6px 10px; border-bottom: 1px solid #f0f0f0; }
    .kpi { display: inline-block; background: #f8fafc; border-left: 4px solid #0369a1; padding: 10px 16px; margin: 6px 8px 6px 0; border-radius: 4px; min-width: 150px; }
    .kpi-label { font-size: 11px; color: #6b7280; font-weight: 700; text-transform: uppercase; }
    .kpi-value { font-size: 18px; font-weight: 900; color: #0c4a6e; margin-top: 2px; }
    .total { background: #f0fdf4; font-weight: 700; }
    .footer { margin-top: 30px; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 10px; }
    @media print { body { padding: 0; } }
  </style></head><body>
  <h1>💊 PharmaCash — Rapport ${isJour?"Journalier":"Mensuel"}</h1>
  <p style="color:#6b7280;margin:0 0 16px">${dateLabel} · Généré le ${new Date().toLocaleString("fr-FR")}</p>

  <div>
    <div class="kpi"><div class="kpi-label">Total Recettes</div><div class="kpi-value" style="color:#047857">${fmtN(totRec)}</div></div>
    <div class="kpi"><div class="kpi-label">💵 Espèces</div><div class="kpi-value" style="color:#0369a1">${fmtN(recettes.filter(r=>r.mode==="especes").reduce((s,r)=>s+Number(r.montant||0),0))}</div></div>
    <div class="kpi"><div class="kpi-label">📱 Mobile Money</div><div class="kpi-value" style="color:#7c3aed">${fmtN(recettes.filter(r=>MOBILE_MONEY_IDS.includes(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0))}</div></div>
    <div class="kpi"><div class="kpi-label">Dépenses</div><div class="kpi-value" style="color:#dc2626">${fmtN(totDep)}</div></div>
    <div class="kpi"><div class="kpi-label">Versements banque</div><div class="kpi-value" style="color:#0891b2">${fmtN(totVers)}</div></div>
    <div class="kpi"><div class="kpi-label">Solde Caisse</div><div class="kpi-value" style="color:${soldes.soldeEspeces>=0?"#047857":"#dc2626"}">${fmtN(soldes.soldeEspeces)}</div></div>
  </div>

  <h2>Recettes par point de vente</h2>
  <table><thead><tr><th>Source</th><th>💵 Espèces</th><th>📱 Mobile</th><th>Total</th></tr></thead><tbody>
  ${[{label:"🏥 Pharmacie centrale", id:"pharmacie"}, ...data.depots.map(d=>({label:"📍 "+d.nom, id:d.id}))].map(src=>{
    const esp = recettes.filter(r=>r.source===src.id&&r.mode==="especes").reduce((s,r)=>s+Number(r.montant||0),0);
    const mob = recettes.filter(r=>r.source===src.id&&MOBILE_MONEY_IDS.includes(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0);
    return `<tr><td>\${src.label}</td><td>\${fmtN(esp)}</td><td>\${fmtN(mob)}</td><td><b>\${fmtN(esp+mob)}</b></td></tr>`;
  }).join("")}
  <tr class="total"><td>TOTAL</td><td>${fmtN(recettes.filter(r=>r.mode==="especes").reduce((s,r)=>s+Number(r.montant||0),0))}</td><td>${fmtN(recettes.filter(r=>MOBILE_MONEY_IDS.includes(r.mode)).reduce((s,r)=>s+Number(r.montant||0),0))}</td><td>${fmtN(totRec)}</td></tr>
  </tbody></table>

  <h2>Détail des recettes</h2>
  <table><thead><tr><th>Date</th><th>Source</th><th>Caissière</th><th>Mode</th><th>Montant</th></tr></thead><tbody>
  ${rows(recettes, [
    r=>r.date,
    r=>r.source==="pharmacie"?"Centrale":(data.depots.find(d=>d.id===r.source)?.nom||"Dépôt"),
    r=>r.caissiere||"—",
    r=>MODES.find(m=>m.value===r.mode)?.label||r.mode,
    r=>"<b>"+fmtN(r.montant)+"</b>",
  ])}
  </tbody></table>

  <h2>Dépenses</h2>
  <table><thead><tr><th>Date</th><th>Catégorie</th><th>Libellé</th><th>Mode</th><th>Montant</th></tr></thead><tbody>
  ${rows(depenses, [d=>d.date, d=>d.categorie, d=>d.libelle, d=>d.mode, d=>"<b style='color:#dc2626'>"+fmtN(d.montant)+"</b>"])}
  <tr class="total"><td colspan="4">TOTAL DÉPENSES</td><td>${fmtN(totDep)}</td></tr>
  </tbody></table>

  <h2>Versements banque</h2>
  <table><thead><tr><th>Date</th><th>Banque</th><th>Type</th><th>Montant</th></tr></thead><tbody>
  ${rows(versements, [v=>v.date, v=>v.banque||"—", v=>v.typeVers||"especes", v=>"<b style='color:#0891b2'>"+fmtN(v.montant)+"</b>"])}
  <tr class="total"><td colspan="3">TOTAL VERSEMENTS</td><td>${fmtN(totVers)}</td></tr>
  </tbody></table>

  <div class="footer">PharmaCash · Rapport généré automatiquement · ${new Date().toLocaleString("fr-FR")}</div>
  </body></html>`;

  const win = window.open("", "_blank");
  if (win) {
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 500);
  }
}

// ─── APP SHELL ───────────────────────────────────────────────────────────────
const NAV = [
  { key:"dashboard",       label:"Tableau de bord",    icon:"dashboard"    },
  { key:"gerant_dashboard",label:"Vue Gérant",          icon:"dashboard"    },
  { key:"recettes",        label:"Recettes",            icon:"recettes"     },
  { key:"recouvrement",    label:"Recouvrement",        icon:"recouvrement" },
  { key:"versements",      label:"Versements banque",   icon:"versements"   },
  { key:"depots",          label:"Dépôts externes",     icon:"depots"       },
  { key:"depenses",        label:"Dépenses",            icon:"depenses"     },
  { key:"cloture",         label:"Clôture caisse",      icon:"check"        },
  { key:"historique",      label:"Historique",          icon:"factures"     },
  { key:"connexions",      label:"Connexions",          icon:"utilisateurs" },
  { key:"utilisateurs",    label:"Utilisateurs",        icon:"utilisateurs" },
];

// ─── PWA SERVICE WORKER REGISTRATION ────────────────────────────────────────
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ─── HOOK CHARGEMENT SUPABASE ────────────────────────────────────────────────
function useSupabaseData() {
  const [raw, setRawState] = useState(() => loadCache() || EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchAll = async () => {
    try {
      const [users, depots, recettes, clients, recouvrements, encaissementsDivers,
             versementsBanque, verseDepots, depenses, dotationHistory, responsables, connexions, clotures] = await Promise.all([
        supa.get("utilisateurs"),
        supa.get("depots"),
        supa.get("recettes"),
        supa.get("clients"),
        supa.get("recouvrements"),
        supa.get("encaissements_divers"),
        supa.get("versements_banque"),
        supa.get("verse_depots"),
        supa.get("depenses"),
        supa.get("dotation_history"),
        supa.get("responsables").catch(()=>[]),
        supa.get("connexions").catch(()=>[]),
        supa.get("clotures").catch(()=>[]),
      ]);
      const data = {
        users:               users.map(norm.users),
        depots:              depots.map(norm.depots),
        recettes:            recettes.map(norm.recettes),
        clients:             clients.map(norm.clients),
        recouvrements:       recouvrements.map(norm.recouvrements),
        encaissementsDivers: encaissementsDivers.map(norm.encaissementsDivers),
        versementsBanque:    versementsBanque.map(norm.versementsBanque),
        verseDepots:         verseDepots.map(norm.verseDepots),
        depenses:            depenses.map(norm.depenses),
        dotationHistory:     dotationHistory.map(norm.dotationHistory),
        responsables:        responsables.map(norm.responsables),
        connexions:          connexions.map(norm.connexions),
        clotures:            clotures.map(norm.clotures),
      };
      setRawState(data);
      saveCache(data);
      // Vérifier alertes après chargement
      const s = calcSoldes(data);
      checkAndSendAlerts(data, s).catch(()=>{});
      return data;
    } catch (e) {
      console.warn("Supabase hors ligne, cache utilisé", e);
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Synchroniser la file d'attente hors ligne
  const flushQueue = async () => {
    const q = loadQueue();
    if (!q.length) return;
    setSyncing(true);
    const failed = [];
    for (const op of q) {
      try {
        if (op.action === "insert") await supa.insert(op.table, op.data);
        else if (op.action === "update") await supa.update(op.table, op.id, op.data);
        else if (op.action === "delete") await supa.delete(op.table, op.id);
      } catch { failed.push(op); }
    }
    saveQueue(failed);
    setSyncing(false);
    if (failed.length === 0) await fetchAll();
  };

  useEffect(() => {
    fetchAll();
    const onOnline = () => flushQueue();
    window.addEventListener("online", onOnline);
    // Rafraîchir automatiquement toutes les 30 secondes
    const interval = setInterval(() => { if (navigator.onLine) fetchAll(); }, 30000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(interval);
    };
  }, []);

  // setData avec écriture Supabase + cache + file d'attente offline
  const setRaw = (newData) => {
    setRawState(newData);
    saveCache(newData);
  };

  return { raw, setRaw, loading, syncing, refetch: fetchAll };
}

export default function App() {
  const { raw, setRaw, loading, syncing, refetch } = useSupabaseData();
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [sideOpen, setSideOpen] = useState(false);

  // PWA Install prompt
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstall, setShowInstall] = useState(false);
  useEffect(()=>{
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); setShowInstall(true); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);
  const handleInstall = () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.then(() => { setInstallPrompt(null); setShowInstall(false); });
  };

  // Offline indicator
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  useEffect(()=>{
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  if (loading) return (
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#0c4a6e,#0369a1)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
      <div style={{ fontSize:48 }}>💊</div>
      <div style={{ color:"#fff", fontSize:20, fontWeight:800 }}>PharmaCash</div>
      <div style={{ color:"#7dd3fc", fontSize:14 }}>Connexion à la base de données...</div>
      <div style={{ width:40, height:40, border:"4px solid #ffffff40", borderTop:"4px solid #fff", borderRadius:"50%", animation:"spin 1s linear infinite" }}/>
      <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );

  if (!user) return <LoginPage onLogin={u=>{ setUser(u); setPage(ROLES[u.role].modules[0]); }} users={raw.users} refetch={refetch}/>;

  const allowed = ROLES[user.role]?.modules||[];
  const nav = NAV.filter(n=>allowed.includes(n.key));
  const solde = calcSoldes(raw);
  const soldeCaisse = solde.soldeEspeces;

  const renderPage = () => {
    if (!allowed.includes(page)) return <div style={{padding:32,color:"#dc2626"}}>Accès non autorisé.</div>;
    switch(page) {
      case "dashboard":    return <Dashboard data={raw}/>;
      case "recettes":     return <Recettes data={raw} setRaw={setRaw} user={user}/>;
      case "recouvrement": return <Recouvrement data={raw} setRaw={setRaw} user={user}/>;
      case "versements":   return <Versements data={raw} setRaw={setRaw} user={user}/>;
      case "depots":       return <Depots data={raw} setRaw={setRaw} user={user}/>;
      case "depenses":     return <Depenses data={raw} setRaw={setRaw} user={user}/>;
      case "historique":        return <Historique data={raw}/>;
      case "gerant_dashboard":  return <GerantDashboard data={raw}/>;
      case "cloture":           return <ClotureCaisse data={raw} setRaw={setRaw} user={user}/>;
      case "connexions":        return <ConnexionsPage data={raw}/>;
      case "utilisateurs": return <Utilisateurs data={raw} setRaw={setRaw} currentUser={user}/>;
      default: return null;
    }
  };

  const Sidebar = () => (
    <div style={{ width:224, background:"#0c4a6e", display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ padding:"22px 20px 14px", borderBottom:"1px solid #1e5f8a" }}>
        <div style={{ fontSize:20, fontWeight:900, color:"#fff" }}>💊 PharmaCash</div>
        <div style={{ fontSize:11, color:"#7dd3fc", marginTop:3 }}>Gestion financière · 24h/24</div>
        {syncing && <div style={{ marginTop:4, fontSize:11, color:"#fde68a", fontWeight:600 }}>⟳ Synchronisation...</div>}
        {!isOnline && <div style={{ marginTop:6, fontSize:11, background:"#dc2626", color:"#fff", borderRadius:6, padding:"3px 8px", display:"inline-block", fontWeight:700 }}>✗ Hors ligne — données locales</div>}
        {showInstall && <button onClick={handleInstall} style={{ marginTop:6, fontSize:11, background:"#38bdf8", color:"#0c4a6e", border:"none", borderRadius:6, padding:"4px 10px", fontWeight:700, cursor:"pointer", display:"block" }}>📲 Installer l'app</button>}
      </div>

      {/* Solde mini dans sidebar */}
      <div style={{ margin:"10px 12px", background:"#1e5f8a", borderRadius:10, padding:"10px 14px" }}>
        <div style={{ fontSize:10, color:"#7dd3fc", fontWeight:700, textTransform:"uppercase" }}>💵 Solde caisse</div>
        <div style={{ fontSize:15, fontWeight:900, color:soldeCaisse>=0?"#4ade80":"#f87171", marginTop:2 }}>💵 {fmt(soldeCaisse)}</div>
        <div style={{ fontSize:12, color:"#7dd3fc", marginTop:2 }}>📱 {fmt(solde.totalMobile)}</div>
      </div>

      <nav style={{ flex:1, overflowY:"auto", padding:"6px 0" }}>
        {nav.map(n=>(
          <button key={n.key} onClick={()=>{ setPage(n.key); setSideOpen(false); }} style={{
            display:"flex", alignItems:"center", gap:12, width:"100%", padding:"10px 20px",
            background:page===n.key?"#1e5f8a":"none", border:"none", cursor:"pointer",
            color:page===n.key?"#fff":"#bae6fd", fontSize:14, fontWeight:page===n.key?700:400,
            borderLeft:page===n.key?"3px solid #38bdf8":"3px solid transparent", textAlign:"left",
          }}>
            <Icon name={n.icon} size={16}/> {n.label}
          </button>
        ))}
      </nav>
      <div style={{ padding:"14px 20px", borderTop:"1px solid #1e5f8a" }}>
        <div style={{ fontSize:13, color:"#7dd3fc", marginBottom:3 }}>{user.name}</div>
        <div style={{ marginBottom:10 }}><Badge color="#38bdf8">{ROLES[user.role]?.label}</Badge></div>
        <button onClick={()=>setUser(null)} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", color:"#f87171", cursor:"pointer", fontSize:13, fontWeight:600 }}>
          <Icon name="logout" size={14}/> Déconnexion
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ display:"flex", height:"100vh", fontFamily:"'Inter','Segoe UI',sans-serif", background:"#f1f5f9" }}>
      <style>{`
        @media(max-width:720px){ .ds{display:none!important} }
        @media(min-width:721px){ .mb{display:none!important} }
        * { box-sizing:border-box; }
        input,select,textarea { font-family:inherit; }
        button { font-family:inherit; }
        ::-webkit-scrollbar{ width:5px; } ::-webkit-scrollbar-thumb{ background:#cbd5e1; border-radius:4px; }
      `}</style>

      {/* Desktop */}
      <div className="ds" style={{ flexShrink:0, height:"100vh", position:"sticky", top:0 }}>
        <Sidebar/>
      </div>

      {/* Mobile overlay */}
      {sideOpen && (
        <div style={{ position:"fixed", inset:0, zIndex:200, display:"flex" }}>
          <div style={{ width:240 }}><Sidebar/></div>
          <div style={{ flex:1, background:"#0007" }} onClick={()=>setSideOpen(false)}/>
        </div>
      )}

      <div style={{ flex:1, display:"flex", flexDirection:"column", minWidth:0, overflow:"hidden" }}>
        {/* Mobile bar */}
        <div className="mb" style={{ background:"#0c4a6e", padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <button onClick={()=>setSideOpen(true)} style={{ background:"none", border:"none", cursor:"pointer", color:"#fff" }}><Icon name="menu"/></button>
            <span style={{ color:"#fff", fontWeight:900, fontSize:17 }}>💊 PharmaCash</span>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {!isOnline && <span style={{ fontSize:11, background:"#dc2626", color:"#fff", borderRadius:20, padding:"2px 8px", fontWeight:700 }}>✗ Hors ligne</span>}
            {showInstall && <button onClick={handleInstall} style={{ fontSize:11, background:"#38bdf8", color:"#0c4a6e", border:"none", borderRadius:20, padding:"4px 10px", fontWeight:700, cursor:"pointer" }}>📲 Installer</button>}
            <div style={{ fontSize:12, fontWeight:800, color:soldeCaisse>=0?"#4ade80":"#f87171" }}>💵{fmt(soldeCaisse)}</div>
          </div>
        </div>

        <main style={{ flex:1, overflowY:"auto", padding:"22px 18px" }}>
          {renderPage()}
        </main>
      </div>
    </div>
  );
}
