#!/usr/bin/env node
/* ============================================================
   GAJ CAVA — Serveur de synchronisation
   ------------------------------------------------------------
   Remplace l'échange manuel de fichiers .json entre postes par
   une synchronisation réseau automatique, tout en gardant le
   fonctionnement 100% hors-ligne du poste client comme repli.

   Zéro dépendance externe (uniquement les modules standard de
   Node.js) : aucun "npm install" n'est nécessaire, ce qui rend
   le déploiement possible sur n'importe quel poste/serveur
   disposant de Node.js (18+), y compris sur site (entrepôt) ou
   dans le cloud.

   Démarrage :  node server/server.js
   Variables d'environnement optionnelles :
     PORT                    (défaut 8787)
     GAJ_ADMIN_MATRICULE     (défaut "admin", uniquement à la création)
     GAJ_ADMIN_PASSWORD      (sinon un mot de passe est généré et
                              affiché une seule fois dans la console)
   ============================================================ */
"use strict";
var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var ROOT = path.resolve(__dirname, "..");
var DATA_DIR = path.join(__dirname, "data");
var DB_FILE = path.join(DATA_DIR, "db.json");
var SECRET_FILE = path.join(DATA_DIR, "secret.key");
var PORT = parseInt(process.env.PORT, 10) || 8787;
var TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 jours

/* ---------- Bootstrap fichiers ---------- */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

var SECRET = (function () {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, "utf8").trim();
  var s = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
})();

function defaultDB() {
  return {
    users: [], catalogue: [], picking: {}, supports: [], om: [], mapping: { catalogue: null, picking: null, supports: null },
    counts: {}, supcounts: {}, suploc: {}, invest: {}, regule: {}, countmeta: {}, pickOverride: {}, rowLocked: {}, consignes: {},
    retours: [], regulSign: [], consSign: {},
    activities: [], meta: { cat: null, pick: null, sup: null, om: null }, log: [], settings: { blind: true }
  };
}

function scryptHash(password) {
  var salt = crypto.randomBytes(16).toString("hex");
  var hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return "scrypt$" + salt + "$" + hash;
}
function scryptVerify(password, stored) {
  var parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  var salt = parts[1], hash = Buffer.from(parts[2], "hex");
  var test = crypto.scryptSync(String(password), salt, 64);
  return test.length === hash.length && crypto.timingSafeEqual(test, hash);
}

var DB = null;
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { DB = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) { DB = defaultDB(); }
  } else {
    DB = defaultDB();
  }
  var d0 = defaultDB();
  for (var k in d0) if (DB[k] === undefined) DB[k] = d0[k];
  if (!DB.users.length) {
    var matricule = process.env.GAJ_ADMIN_MATRICULE || "admin";
    var password = process.env.GAJ_ADMIN_PASSWORD || crypto.randomBytes(6).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
    DB.users.push({ id: "u_" + Date.now().toString(36), matricule: matricule, numero: "", nom: "Administrateur serveur", fonction: "Administrateur", role: "admin", sectors: [], password: scryptHash(password) });
    saveDB();
    console.log("============================================================");
    console.log(" Compte administrateur serveur créé :");
    console.log("   matricule : " + matricule);
    console.log("   mot de passe : " + password + "   (à noter — non réaffiché)");
    console.log(" Changez-le avec l'écran Utilisateurs > Comptes serveur une fois connecté.");
    console.log("============================================================");
  }
}
function saveDB() {
  var tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(DB), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

/* ---------- Fusion (port fidèle de window.GAJ.merge côté client) ----------
   Mêmes règles : union par id pour activities/retours/regulSign, dernier
   comptage/régul gagne pour les maps clé→valeur, users jamais écrasé
   (seuls lastLogin/loginCount progressent) — le mot de passe serveur
   (scrypt) n'est donc jamais remplacé par une poussée d'un client. */
function mergeInto(canonical, inc) {
  var res = { act: 0, comptages: 0, regule: 0, supports: 0, retours: 0, signs: 0 };
  canonical.users = canonical.users || [];
  (inc.users || []).forEach(function (iu) {
    var lu = canonical.users.filter(function (x) { return String(x.matricule || "").toLowerCase() === String(iu.matricule || "").toLowerCase(); })[0];
    if (!lu) return;
    if (iu.lastLogin && (!lu.lastLogin || iu.lastLogin > lu.lastLogin)) lu.lastLogin = iu.lastLogin;
    if (iu.loginCount) lu.loginCount = Math.max(lu.loginCount || 0, iu.loginCount);
  });
  canonical.activities = canonical.activities || [];
  var have = {}; canonical.activities.forEach(function (a) { have[a.id] = 1; });
  (inc.activities || []).forEach(function (a) { if (!have[a.id]) { canonical.activities.push(a); res.act++; } });
  canonical.activities.sort(function (x, y) { return (y.at || "").localeCompare(x.at || ""); });

  canonical.retours = canonical.retours || [];
  var haveR = {}, haveNum = {};
  canonical.retours.forEach(function (r) { haveR[r.id] = 1; haveNum[String(r.numero || "").trim().toLowerCase()] = 1; });
  (inc.retours || []).forEach(function (r) {
    var nk = String(r.numero || "").trim().toLowerCase();
    if (!haveR[r.id] && !haveNum[nk]) { canonical.retours.push(r); haveR[r.id] = 1; haveNum[nk] = 1; res.retours++; }
  });
  canonical.retours.sort(function (x, y) { return (y.at || "").localeCompare(x.at || ""); });

  ["counts", "supcounts", "suploc", "invest", "regule", "countmeta", "pickOverride", "rowLocked"].forEach(function (k) {
    canonical[k] = canonical[k] || {};
    var src = inc[k] || {};
    for (var code in src) {
      if (k === "supcounts" || k === "suploc") canonical[k][code] = Object.assign(canonical[k][code] || {}, src[code]);
      else canonical[k][code] = src[code];
    }
  });
  res.comptages = Object.keys(inc.counts || {}).length;
  res.regule = Object.keys(inc.regule || {}).length;
  res.supports = Object.keys(inc.supcounts || {}).length;

  canonical.regulSign = canonical.regulSign || [];
  var haveRS = {}; canonical.regulSign.forEach(function (r) { haveRS[r.id] = 1; });
  (inc.regulSign || []).forEach(function (r) { if (!haveRS[r.id]) { canonical.regulSign.push(r); haveRS[r.id] = 1; res.signs++; } });
  canonical.regulSign.sort(function (x, y) { return (y.at || "").localeCompare(x.at || ""); });

  canonical.consSign = canonical.consSign || {};
  var incCS = inc.consSign || {};
  for (var period in incCS) {
    var exCS = canonical.consSign[period];
    if (!exCS || (incCS[period].at || "") > (exCS.at || "")) canonical.consSign[period] = incCS[period];
  }
  return res;
}

/* ---------- Jetons d'authentification (HMAC-SHA256, sans dépendance JWT) ---------- */
function b64u(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromB64u(str) { str = String(str).replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; return Buffer.from(str, "base64"); }
function signToken(payload) {
  var body = b64u(JSON.stringify(payload));
  var sig = b64u(crypto.createHmac("sha256", SECRET).update(body).digest());
  return body + "." + sig;
}
function verifyToken(token) {
  var parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  var expected = b64u(crypto.createHmac("sha256", SECRET).update(parts[0]).digest());
  var a = Buffer.from(parts[1]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    var payload = JSON.parse(fromB64u(parts[0]).toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}

/* ---------- Utilitaires HTTP ---------- */
function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > 25 * 1024 * 1024) { reject(new Error("payload trop volumineux")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(new Error("JSON invalide")); }
    });
    req.on("error", reject);
  });
}
function sendJSON(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function authUser(req) {
  var h = req.headers["authorization"] || "";
  var m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  var payload = verifyToken(m[1]);
  if (!payload) return null;
  var u = (DB.users || []).filter(function (x) { return x.id === payload.sub; })[0];
  return u || null;
}

var MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(req, res, pathname) {
  if (pathname === "/") pathname = "/index.html";
  var rel = pathname.replace(/^\/+/, "");
  var full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end("interdit"); return; }
  fs.readFile(full, function (err, data) {
    if (err) { res.writeHead(404); res.end("introuvable"); return; }
    var ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------- Routes API ---------- */
function handleApi(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
    res.end(); return;
  }
  if (pathname === "/api/health" && req.method === "GET") return sendJSON(res, 200, { ok: true, name: "gaj-cava-sync", time: new Date().toISOString() });

  if (pathname === "/api/login" && req.method === "POST") {
    return readBody(req).then(function (b) {
      var u = (DB.users || []).filter(function (x) { return String(x.matricule || "").toLowerCase() === String(b.matricule || "").toLowerCase(); })[0];
      if (!u || !scryptVerify(b.password || "", u.password)) return sendJSON(res, 401, { error: "identifiants invalides" });
      u.lastLogin = new Date().toISOString(); u.loginCount = (u.loginCount || 0) + 1; saveDB();
      var token = signToken({ sub: u.id, exp: Date.now() + TOKEN_TTL_MS });
      return sendJSON(res, 200, { token: token, user: { id: u.id, matricule: u.matricule, nom: u.nom, fonction: u.fonction, role: u.role, sectors: u.sectors || [] } });
    }).catch(function (e) { sendJSON(res, 400, { error: e.message }); });
  }

  var me = authUser(req);
  if (!me) return sendJSON(res, 401, { error: "authentification requise" });

  if (pathname === "/api/db" && req.method === "GET") {
    return sendJSON(res, 200, { _gaj: 1, exportedAt: new Date().toISOString(), db: DB });
  }

  if (pathname === "/api/db/merge" && req.method === "POST") {
    return readBody(req).then(function (b) {
      if (!b || !b.db) return sendJSON(res, 400, { error: "corps invalide (attendu { db: ... })" });
      var stats = mergeInto(DB, b.db);
      saveDB();
      return sendJSON(res, 200, { ok: true, stats: stats, db: { _gaj: 1, exportedAt: new Date().toISOString(), db: DB } });
    }).catch(function (e) { sendJSON(res, 400, { error: e.message }); });
  }

  if (pathname === "/api/db/replace" && req.method === "POST") {
    if (me.role !== "admin") return sendJSON(res, 403, { error: "réservé administrateur" });
    return readBody(req).then(function (b) {
      if (!b || !b.db) return sendJSON(res, 400, { error: "corps invalide (attendu { db: ... })" });
      var keepUsers = DB.users;
      DB = b.db; DB.users = keepUsers; // les comptes serveur (mots de passe scrypt) ne sont jamais remplacés par ce canal
      var d0 = defaultDB(); for (var k in d0) if (DB[k] === undefined) DB[k] = d0[k];
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }).catch(function (e) { sendJSON(res, 400, { error: e.message }); });
  }

  if (pathname === "/api/users" && req.method === "GET") {
    if (me.role !== "admin") return sendJSON(res, 403, { error: "réservé administrateur" });
    return sendJSON(res, 200, { users: (DB.users || []).map(function (u) { return { id: u.id, matricule: u.matricule, nom: u.nom, fonction: u.fonction, role: u.role, sectors: u.sectors || [], lastLogin: u.lastLogin || null }; }) });
  }

  if (pathname === "/api/users" && req.method === "POST") {
    if (me.role !== "admin") return sendJSON(res, 403, { error: "réservé administrateur" });
    return readBody(req).then(function (b) {
      if (!b.matricule) return sendJSON(res, 400, { error: "matricule requis" });
      var u = (DB.users || []).filter(function (x) { return String(x.matricule || "").toLowerCase() === String(b.matricule).toLowerCase(); })[0];
      if (!u) {
        if (!b.password) return sendJSON(res, 400, { error: "mot de passe requis à la création" });
        u = { id: "u_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), matricule: b.matricule, numero: b.numero || "", sectors: [] };
        DB.users.push(u);
      }
      u.nom = b.nom || u.nom || ""; u.fonction = b.fonction || u.fonction || ""; u.role = b.role || u.role || "responsable"; u.sectors = b.sectors || u.sectors || [];
      if (b.password) u.password = scryptHash(b.password);
      saveDB();
      return sendJSON(res, 200, { ok: true, user: { id: u.id, matricule: u.matricule, nom: u.nom, role: u.role } });
    }).catch(function (e) { sendJSON(res, 400, { error: e.message }); });
  }

  return sendJSON(res, 404, { error: "route inconnue" });
}

loadDB();
var server = http.createServer(function (req, res) {
  var pathname = decodeURIComponent(req.url.split("?")[0]);
  if (pathname.indexOf("/api/") === 0) {
    Promise.resolve(handleApi(req, res, pathname)).catch(function (e) { try { sendJSON(res, 500, { error: e.message }); } catch (e2) {} });
  } else {
    serveStatic(req, res, pathname);
  }
});
server.listen(PORT, function () {
  console.log("GAJ CAVA — serveur de synchronisation sur http://localhost:" + PORT);
});
