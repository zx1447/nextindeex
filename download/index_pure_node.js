/**
 * InkWell - Personal Journaling Platform
 * Version: 2.4.1
 *
 * A lightweight, private diary and journaling web application
 * with session-based authentication, mood tracking, tagging,
 * and full CRUD operations for daily journal entries.
 *
 * Usage:
 *   node index.js
 *
 * Environment Variables:
 *   SERVER_PORT    - Pterodactyl assigned port (highest priority)
 *   PORT           - Web panel listening port (auto-assigned if not set)
 *   PANEL_PASSWORD - Access password for the web panel
 *
 * License: MIT
 */

var express = require("express");
var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var session = require("express-session");
var os = require("os");

// ============================================================================
// Configuration
// ============================================================================

var PORT = parseInt(process.env.SERVER_PORT) || parseInt(process.env.PORT) || parseInt(process.env.PANEL_PORT) || 0;
var PANEL_PASSWORD = process.env.PANEL_PASSWORD || "admin";
var SESSION_SECRET = crypto.randomBytes(32).toString("hex");
var SESSION_TIMEOUT = 24 * 60 * 60 * 1000;
var MAX_LOGIN_ATTEMPTS = 5;
var LOCKOUT_DURATION = 15 * 60 * 1000;
var DATA_FILE = path.join(__dirname, "journal.json");
var APP_VERSION = "2.4.1";

// ============================================================================
// Data Store
// ============================================================================

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        }
    } catch (e) {}
    return { entries: [], nextId: 1 };
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {}
}

// ============================================================================
// Express App Setup
// ============================================================================

var app = express();
var loginAttempts = new Map();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: SESSION_TIMEOUT, httpOnly: true },
    name: "ink.sid"
}));

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        req.session.touch();
        return next();
    }
    if (req.path === "/" || req.path === "/api/auth/login") return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ success: false, message: "Auth required" });
    res.redirect("/");
}

app.use(function(req, res, next) {
    if (req.path === "/" || req.path === "/api/auth/login" || req.path === "/favicon.ico") return next();
    requireAuth(req, res, next);
});

function escHtml(s) {
    if (!s) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============================================================================
// Auth Routes
// ============================================================================

app.post("/api/auth/login", function(req, res) {
    var password = req.body.password;
    var clientIp = req.ip || req.connection.remoteAddress;
    var attempts = loginAttempts.get(clientIp) || { count: 0, timestamp: Date.now() };

    if (Date.now() - attempts.timestamp > LOCKOUT_DURATION) {
        loginAttempts.delete(clientIp);
    } else if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
        var remaining = Math.ceil((LOCKOUT_DURATION - (Date.now() - attempts.timestamp)) / 60000);
        return res.status(429).json({ success: false, message: "Too many attempts. Try again in " + remaining + " min." });
    }

    if (password === PANEL_PASSWORD) {
        req.session.authenticated = true;
        loginAttempts.delete(clientIp);
        res.json({ success: true });
    } else {
        attempts.count++;
        attempts.timestamp = Date.now();
        loginAttempts.set(clientIp, attempts);
        res.status(401).json({ success: false, message: "Invalid password. Attempts left: " + (MAX_LOGIN_ATTEMPTS - attempts.count) });
    }
});

app.post("/api/auth/logout", function(req, res) {
    req.session.destroy(function() { res.json({ success: true }); });
});

// ============================================================================
// Entry CRUD
// ============================================================================

app.get("/api/entries", function(req, res) {
    var data = loadData();
    var entries = data.entries.slice().sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    res.json({ success: true, entries: entries });
});

app.post("/api/entries", function(req, res) {
    var data = loadData();
    var title = (req.body.title || "").trim();
    var content = (req.body.content || "").trim();
    var mood = req.body.mood || "neutral";
    var tags = req.body.tags || [];
    if (!title || !content) return res.status(400).json({ success: false, message: "Title and content required" });
    var entry = {
        id: data.nextId++,
        title: title,
        content: content,
        mood: mood,
        tags: Array.isArray(tags) ? tags : String(tags).split(",").map(function(t) { return t.trim(); }).filter(Boolean),
        wordCount: content.split(/\s+/).filter(Boolean).length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    data.entries.push(entry);
    saveData(data);
    res.json({ success: true, entry: entry });
});

app.put("/api/entries/:id", function(req, res) {
    var data = loadData();
    var id = parseInt(req.params.id);
    var entry = data.entries.find(function(e) { return e.id === id; });
    if (!entry) return res.status(404).json({ success: false, message: "Entry not found" });
    if (req.body.title !== undefined) entry.title = String(req.body.title).trim();
    if (req.body.content !== undefined) {
        entry.content = String(req.body.content).trim();
        entry.wordCount = entry.content.split(/\s+/).filter(Boolean).length;
    }
    if (req.body.mood !== undefined) entry.mood = req.body.mood;
    if (req.body.tags !== undefined) entry.tags = Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags).split(",").map(function(t) { return t.trim(); }).filter(Boolean);
    entry.updatedAt = new Date().toISOString();
    saveData(data);
    res.json({ success: true, entry: entry });
});

app.delete("/api/entries/:id", function(req, res) {
    var data = loadData();
    var id = parseInt(req.params.id);
    var idx = data.entries.findIndex(function(e) { return e.id === id; });
    if (idx === -1) return res.status(404).json({ success: false, message: "Entry not found" });
    data.entries.splice(idx, 1);
    saveData(data);
    res.json({ success: true });
});

app.get("/api/stats", function(req, res) {
    var data = loadData();
    var entries = data.entries;
    var totalWords = entries.reduce(function(s, e) { return s + (e.wordCount || 0); }, 0);
    var moodCounts = {};
    entries.forEach(function(e) { moodCounts[e.mood] = (moodCounts[e.mood] || 0) + 1; });
    var tagCounts = {};
    entries.forEach(function(e) { (e.tags || []).forEach(function(t) { tagCounts[t] = (tagCounts[t] || 0) + 1; }); });
    var dates = entries.map(function(e) { return e.createdAt.substring(0, 10); }).sort();
    var streak = 0;
    if (dates.length > 0) {
        var today = new Date().toISOString().substring(0, 10);
        var d = new Date(today);
        while (dates.indexOf(d.toISOString().substring(0, 10)) !== -1) {
            streak++;
            d.setDate(d.getDate() - 1);
        }
    }
    res.json({ success: true, totalEntries: entries.length, totalWords: totalWords, streak: streak, moodCounts: moodCounts, tagCounts: tagCounts });
});

// ============================================================================
// Pages
// ============================================================================

app.get("/", function(req, res) {
    if (req.session.authenticated) return res.redirect("/dashboard");
    res.send(getLoginPage());
});

app.get("/dashboard", requireAuth, function(req, res) {
    res.send(getDashboardPage());
});

// ============================================================================
// Login Page - Disguised as 503 Error
// ============================================================================

function getLoginPage() {
    var lines = [];
    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
    lines.push('<title>503 Service Temporarily Unavailable</title>');
    lines.push('<style>');
    lines.push('*{margin:0;padding:0;box-sizing:border-box}');
    lines.push('body{background:#fff;color:#333;font-family:system-ui,-apple-system,sans-serif;font-size:14px}');
    lines.push('.err-wrap{max-width:620px;margin:60px auto 0;padding:0 24px}');
    lines.push('.err-icon{text-align:center;margin-bottom:20px}');
    lines.push('.err-icon svg{width:56px;height:56px}');
    lines.push('h1{font-size:22px;font-weight:400;color:#333;margin-bottom:6px}');
    lines.push('.err-sub{color:#666;margin-bottom:24px;line-height:1.6}');
    lines.push('.err-sub span{cursor:default}');
    lines.push('.err-hr{border:none;border-top:1px solid #e0e0e0;margin:20px 0}');
    lines.push('.err-detail{font-size:13px;color:#888;line-height:1.7}');
    lines.push('#login-box{display:none;position:fixed;inset:0;z-index:999;background:linear-gradient(135deg,#020617,#0f172a);color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;align-items:center;justify-content:center;opacity:0;transition:opacity .4s}');
    lines.push('#login-box.show{display:flex;opacity:1}');
    lines.push('.login-card{background:rgba(15,23,42,.85);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:2.5rem;width:100%;max-width:400px;box-shadow:0 24px 80px rgba(0,0,0,.4)}');
    lines.push('.login-logo{width:56px;height:56px;background:linear-gradient(135deg,#10b981,#06b6d4);border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 1.2rem;font-size:24px}');
    lines.push('.login-title{font-size:1.5rem;font-weight:800;text-align:center;background:linear-gradient(135deg,#34d399,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:.3rem}');
    lines.push('.login-sub{color:#94a3b8;font-size:.8rem;text-align:center;margin-bottom:1.8rem}');
    lines.push('.input-g{margin-bottom:1rem}');
    lines.push('.input-g label{display:block;color:#cbd5e1;font-size:.78rem;font-weight:500;margin-bottom:.3rem}');
    lines.push('.input-g input{width:100%;padding:.8rem 1rem;background:rgba(30,41,59,.6);border:1px solid rgba(71,85,105,.5);border-radius:14px;color:#fff;font-size:.95rem;transition:border .2s}');
    lines.push('.input-g input:focus{outline:none;border-color:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.15)}');
    lines.push('.sub-btn{width:100%;padding:.9rem;background:linear-gradient(135deg,#10b981,#06b6d4);border:none;border-radius:14px;color:#fff;font-size:.95rem;font-weight:700;cursor:pointer;transition:transform .15s}');
    lines.push('.sub-btn:hover{transform:translateY(-2px)}');
    lines.push('.sub-btn:active{transform:scale(.97)}');
    lines.push('.err-msg{color:#f87171;font-size:.82rem;text-align:center;min-height:1.1rem;margin-top:.5rem}');
    lines.push('</style></head><body>');
    lines.push('<div class="err-wrap">');
    lines.push('<div class="err-icon"><svg viewBox="0 0 56 56" fill="none"><circle cx="28" cy="28" r="26" stroke="#d93025" stroke-width="2.5"/><path d="M18 18L38 38M38 18L18 38" stroke="#d93025" stroke-width="2.5" stroke-linecap="round"/></svg></div>');
    lines.push('<h1>503 Service Temporarily Unavailable</h1>');
    lines.push('<p class="err-sub">The server is currently unable to handle this request. Please try again later<span onclick="revealLogin()">.</span></p>');
    lines.push('<hr class="err-hr">');
    lines.push('<div class="err-detail">');
    lines.push('<p>nginx/1.24.0</p>');
    lines.push('<p>Reference ID: ' + crypto.randomBytes(8).toString("hex") + '</p>');
    lines.push('</div></div>');
    lines.push('<div id="login-box">');
    lines.push('<div class="login-card">');
    lines.push('<div class="login-logo">\u270E</div>');
    lines.push('<h2 class="login-title">InkWell</h2>');
    lines.push('<p class="login-sub">Personal Journaling Platform</p>');
    lines.push('<form id="loginForm" onsubmit="return handleLogin(event)">');
    lines.push('<div class="input-g"><label>Password</label><input type="password" id="pw" placeholder="Enter password" required autocomplete="off"></div>');
    lines.push('<button type="submit" class="sub-btn">Unlock</button>');
    lines.push('<div id="errMsg" class="err-msg"></div>');
    lines.push('</form></div></div>');
    lines.push('<script>');
    lines.push('function revealLogin(){var b=document.getElementById("login-box");b.classList.add("show");setTimeout(function(){document.getElementById("pw").focus()},300)}');
    lines.push('function handleLogin(e){e.preventDefault();var p=document.getElementById("pw").value.trim();if(!p){document.getElementById("errMsg").textContent="Password required";return false}');
    lines.push('fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p})}).then(function(r){return r.json()}).then(function(d){if(d.success){window.location.href="/dashboard"}else{document.getElementById("errMsg").textContent=d.message||"Failed";document.getElementById("pw").value=""}}).catch(function(){document.getElementById("errMsg").textContent="Network error"});return false}');
    lines.push('</script></body></html>');
    return lines.join('\n');
}

// ============================================================================
// Dashboard Page
// ============================================================================

function getDashboardPage() {
    var lines = [];
    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">');
    lines.push('<title>InkWell</title>');
    lines.push('<script src="https://cdn.tailwindcss.com"><\/script>');
    lines.push('<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">');
    lines.push('<style>');
    lines.push('body{background:#020617;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;min-height:100vh}');
    lines.push('.glass{background:rgba(15,23,42,.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.05)}');
    lines.push('input,textarea,select{background:#0f172a!important;border:1px solid #1e293b!important;color:#fff!important;outline:none!important}');
    lines.push('input:focus,textarea:focus{border-color:#10b981!important;box-shadow:0 0 0 2px rgba(16,185,129,.15)!important}');
    lines.push('.btn{transition:all .15s;cursor:pointer;user-select:none}');
    lines.push('.btn:hover{transform:translateY(-1px);filter:brightness(1.1)}');
    lines.push('.btn:active{transform:scale(.97)}');
    lines.push('::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:rgba(0,0,0,.2)}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}');
    lines.push('.entry-item{transition:all .15s;cursor:pointer}.entry-item:hover{background:rgba(16,185,129,.08)}');
    lines.push('.entry-item.active{background:rgba(16,185,129,.12);border-left:3px solid #10b981}');
    lines.push('.mood-happy{color:#fbbf24}.mood-neutral{color:#94a3b8}.mood-sad{color:#60a5fa}.mood-excited{color:#f472b6}.mood-grateful{color:#a78bfa}');
    lines.push('.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}');
    lines.push('.tag{display:inline-block;font-size:10px;padding:2px 8px;border-radius:9999px;background:rgba(16,185,129,.1);color:#34d399;border:1px solid rgba(16,185,129,.2);margin:2px}');
    lines.push('</style></head><body class="flex flex-col h-screen overflow-hidden">');

    // Header
    lines.push('<header class="glass flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">');
    lines.push('<div class="flex items-center gap-3">');
    lines.push('<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center text-sm">\u270E</div>');
    lines.push('<h1 class="text-lg font-black bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text" style="-webkit-text-fill-color:transparent">InkWell</h1>');
    lines.push('<span class="text-[10px] text-slate-600">v' + APP_VERSION + '</span>');
    lines.push('</div>');
    lines.push('<div class="flex items-center gap-3">');
    lines.push('<input id="searchInput" placeholder="Search entries..." class="rounded-xl px-3 py-1.5 text-sm w-48" oninput="searchEntries(this.value)">');
    lines.push('<button onclick="openCompose()" class="btn bg-emerald-600 hover:bg-emerald-500 px-4 py-1.5 rounded-xl text-sm font-bold text-white"><i class="fas fa-plus mr-1"></i>New</button>');
    lines.push('<button onclick="showStats()" class="btn bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-xl text-sm text-slate-300"><i class="fas fa-chart-bar"></i></button>');
    lines.push('<button onclick="logout()" class="btn bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-xl text-sm font-bold text-white"><i class="fas fa-sign-out-alt"></i></button>');
    lines.push('</div></header>');

    // Main layout
    lines.push('<div class="flex flex-1 overflow-hidden">');

    // Sidebar
    lines.push('<div class="w-72 shrink-0 border-r border-slate-800 flex flex-col bg-slate-950/50">');
    lines.push('<div id="entryList" class="flex-1 overflow-y-auto p-2 space-y-1"></div>');
    lines.push('<div class="p-3 border-t border-slate-800">');
    lines.push('<div id="tagFilter" class="flex flex-wrap gap-1"></div>');
    lines.push('</div></div>');

    // Main content
    lines.push('<div class="flex-1 overflow-y-auto p-6">');
    lines.push('<div id="emptyView" class="flex flex-col items-center justify-center h-full text-slate-600">');
    lines.push('<i class="fas fa-feather-pointed text-5xl mb-4 opacity-20"></i>');
    lines.push('<p class="text-lg font-medium">Select an entry or create a new one</p>');
    lines.push('</div>');
    lines.push('<div id="entryView" class="hidden max-w-3xl mx-auto"></div>');
    lines.push('</div></div>');

    // Compose Modal
    lines.push('<div id="composeModal" class="modal-bg hidden">');
    lines.push('<div class="glass rounded-2xl p-6 w-full max-w-2xl mx-4 shadow-2xl">');
    lines.push('<div class="flex justify-between items-center mb-4">');
    lines.push('<h3 id="composeTitle" class="text-lg font-bold text-white"><i class="fas fa-pen-fancy text-emerald-400 mr-2"></i>New Entry</h3>');
    lines.push('<button onclick="closeCompose()" class="text-slate-400 hover:text-white text-xl">&times;</button>');
    lines.push('</div>');
    lines.push('<input id="cTitle" type="text" placeholder="Entry title..." class="w-full rounded-xl px-4 py-2.5 text-sm mb-3">');
    lines.push('<textarea id="cContent" rows="10" placeholder="Write your thoughts..." class="w-full rounded-xl px-4 py-3 text-sm mb-3 resize-none"></textarea>');
    lines.push('<div class="flex gap-3 mb-3">');
    lines.push('<div class="flex-1"><label class="block text-xs text-slate-400 mb-1">Mood</label>');
    lines.push('<select id="cMood" class="w-full rounded-xl px-3 py-2 text-sm">');
    lines.push('<option value="happy">\u263A Happy</option><option value="neutral" selected>\u25CB Neutral</option><option value="sad">\u2639 Sad</option><option value="excited">\u2605 Excited</option><option value="grateful">\u2764 Grateful</option>');
    lines.push('</select></div>');
    lines.push('<div class="flex-1"><label class="block text-xs text-slate-400 mb-1">Tags (comma separated)</label>');
    lines.push('<input id="cTags" type="text" placeholder="life, thoughts..." class="w-full rounded-xl px-3 py-2 text-sm">');
    lines.push('</div></div>');
    lines.push('<input id="cEditId" type="hidden" value="">');
    lines.push('<button onclick="saveEntry()" class="btn w-full bg-emerald-600 hover:bg-emerald-500 py-2.5 rounded-xl text-sm font-bold text-white"><i class="fas fa-save mr-1"></i>Save</button>');
    lines.push('</div></div>');

    // Stats Modal
    lines.push('<div id="statsModal" class="modal-bg hidden">');
    lines.push('<div class="glass rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">');
    lines.push('<div class="flex justify-between items-center mb-4">');
    lines.push('<h3 class="text-lg font-bold text-white"><i class="fas fa-chart-bar text-cyan-400 mr-2"></i>Journal Stats</h3>');
    lines.push('<button onclick="document.getElementById(\'statsModal\').classList.add(\'hidden\')" class="text-slate-400 hover:text-white text-xl">&times;</button>');
    lines.push('</div>');
    lines.push('<div id="statsContent"></div>');
    lines.push('</div></div>');

    // Bottom bar
    lines.push('<div class="fixed bottom-4 left-4 glass rounded-full px-5 py-3 flex items-center gap-5 z-50 shadow-2xl">');
    lines.push('<div class="flex flex-col items-center"><span id="statEntries" class="text-sm font-black text-emerald-400">0</span><span class="text-[8px] font-bold text-slate-500 uppercase">Entries</span></div>');
    lines.push('<div class="flex flex-col items-center"><span id="statWords" class="text-sm font-black text-cyan-400">0</span><span class="text-[8px] font-bold text-slate-500 uppercase">Words</span></div>');
    lines.push('<div class="flex flex-col items-center"><span id="statStreak" class="text-sm font-black text-purple-400">0</span><span class="text-[8px] font-bold text-slate-500 uppercase">Streak</span></div>');
    lines.push('</div>');

    // JavaScript
    lines.push('<script>');
    lines.push('var allEntries=[];var currentId=null;var activeTag=null;');
    lines.push('function esc(s){if(!s)return"";return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}');
    lines.push('function moodIcon(m){var map={happy:"\\u263A",neutral:"\\u25CB",sad:"\\u2639",excited:"\\u2605",grateful:"\\u2764"};return map[m]||"\\u25CB"}');
    lines.push('function moodCls(m){return"mood-"+(m||"neutral")}');
    lines.push('function fmtDate(d){if(!d)return"";var dt=new Date(d);var months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];return months[dt.getMonth()]+" "+dt.getDate()+", "+dt.getFullYear()}');
    lines.push('function fmtTime(d){if(!d)return"";var dt=new Date(d);var h=dt.getHours();var m=dt.getMinutes();var ampm=h>=12?"PM":"AM";h=h%12||12;return h+":"+(m<10?"0":"")+m+" "+ampm}');

    lines.push('async function api(method,url,body){var opts={method,headers:{"Content-Type":"application/json"}};if(body)opts.body=JSON.stringify(body);try{var r=await fetch(url,opts);return await r.json()}catch(e){return{success:false,message:e.message}}}');

    lines.push('async function loadEntries(){var d=await api("GET","/api/entries");if(!d.success)return;allEntries=d.entries||[];renderList();updateStats();}');

    lines.push('function renderList(filter){var list=document.getElementById("entryList");var filtered=allEntries;if(activeTag){filtered=filtered.filter(function(e){return(e.tags||[]).indexOf(activeTag)!==-1})}if(filter){var q=filter.toLowerCase();filtered=filtered.filter(function(e){return e.title.toLowerCase().indexOf(q)!==-1||e.content.toLowerCase().indexOf(q)!==-1})}');
    lines.push('var html="";if(filtered.length===0){html=\'<div class="text-center text-slate-600 text-xs py-8">No entries found</div>\'}');
    lines.push('filtered.forEach(function(e){var cls="entry-item rounded-xl p-3"+(e.id===currentId?" active":"");');
    lines.push('html+=\'<div class="\'+cls+\'" onclick="viewEntry(\'+e.id+\')">\';');
    lines.push('html+=\'<div class="flex items-center gap-2 mb-1"><span class="text-sm \'+moodCls(e.mood)+\'">\'+moodIcon(e.mood)+\'</span><span class="text-sm font-bold text-white truncate">\'+esc(e.title)+\'</span></div>\';');
    lines.push('html+=\'<div class="text-[10px] text-slate-500">\'+fmtDate(e.createdAt)+\'</div>\';');
    lines.push('if(e.tags&&e.tags.length>0){html+=\'<div class="mt-1">\'+e.tags.slice(0,3).map(function(t){return\'<span class="tag">\'+esc(t)+\'</span>\'}).join("")+\'</div>\'}');
    lines.push('html+=\'</div>\'});');
    lines.push('list.innerHTML=html;}');

    lines.push('function renderTags(){var tags={};allEntries.forEach(function(e){(e.tags||[]).forEach(function(t){tags[t]=(tags[t]||0)+1})});var el=document.getElementById("tagFilter");var html="";Object.keys(tags).sort(function(a,b){return tags[b]-tags[a]}).slice(0,10).forEach(function(t){var cls=activeTag===t?"bg-emerald-600 text-white":"bg-slate-800 text-slate-400 cursor-pointer hover:bg-slate-700";html+=\'<span class="tag \'+cls+\'" onclick="toggleTag(\\\'\'+esc(t)+\'\\\')">\'+esc(t)+\' (\'+tags[t]+\')</span>\'});if(activeTag){html+=\'<span class="tag bg-red-900 text-red-300 cursor-pointer" onclick="toggleTag(null)">Clear</span>\'}el.innerHTML=html;}');

    lines.push('function toggleTag(t){activeTag=activeTag===t?null:t;renderList();renderTags();}');

    lines.push('async function viewEntry(id){currentId=id;var d=await api("GET","/api/entries");if(!d.success)return;var e=(d.entries||[]).find(function(x){return x.id===id});if(!e)return;');
    lines.push('document.getElementById("emptyView").classList.add("hidden");var v=document.getElementById("entryView");v.classList.remove("hidden");');
    lines.push('var html=\'<div class="glass rounded-2xl p-6 shadow-2xl">\';');
    lines.push('html+=\'<div class="flex justify-between items-start mb-4">\';');
    lines.push('html+=\'<div><h2 class="text-xl font-black text-white">\'+esc(e.title)+\'</h2>\';');
    lines.push('html+=\'<div class="flex items-center gap-3 mt-1 text-xs text-slate-400">\';');
    lines.push('html+=\'<span>\'+fmtDate(e.createdAt)+\' at \'+fmtTime(e.createdAt)+\'</span>\';');
    lines.push('html+=\'<span class="\'+moodCls(e.mood)+\'">\'+moodIcon(e.mood)+\' \'+esc(e.mood)+\'</span>\';');
    lines.push('html+=\'<span>\'+e.wordCount+\' words</span></div></div>\';');
    lines.push('html+=\'<div class="flex gap-2">\';');
    lines.push('html+=\'<button onclick="editEntry(\'+e.id+\')" class="btn bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg text-xs font-bold text-white"><i class="fas fa-edit mr-1"></i>Edit</button>\';');
    lines.push('html+=\'<button onclick="deleteEntry(\'+e.id+\')" class="btn bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded-lg text-xs font-bold text-white"><i class="fas fa-trash mr-1"></i>Delete</button>\';');
    lines.push('html+=\'</div></div>\';');
    lines.push('if(e.tags&&e.tags.length>0){html+=\'<div class="mb-4">\'+e.tags.map(function(t){return\'<span class="tag">\'+esc(t)+\'</span>\'}).join("")+\'</div>\'}');
    lines.push('html+=\'<div class="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">\'+esc(e.content)+\'</div>\';');
    lines.push('html+=\'</div>\';');
    lines.push('v.innerHTML=html;renderList();renderTags();}');

    lines.push('function openCompose(editId,title,content,mood,tags){document.getElementById("composeModal").classList.remove("hidden");document.getElementById("cEditId").value=editId||"";document.getElementById("cTitle").value=title||"";document.getElementById("cContent").value=content||"";document.getElementById("cMood").value=mood||"neutral";document.getElementById("cTags").value=tags||"";document.getElementById("composeTitle").innerHTML=editId?\'<i class="fas fa-edit text-blue-400 mr-2"></i>Edit Entry\':\'<i class="fas fa-pen-fancy text-emerald-400 mr-2"></i>New Entry\';document.getElementById("cTitle").focus();}');
    lines.push('function closeCompose(){document.getElementById("composeModal").classList.add("hidden")}');

    lines.push('async function editEntry(id){var d=await api("GET","/api/entries");if(!d.success)return;var e=(d.entries||[]).find(function(x){return x.id===id});if(!e)return;openCompose(e.id,e.title,e.content,e.mood,(e.tags||[]).join(", "));}');

    lines.push('async function saveEntry(){var editId=document.getElementById("cEditId").value;var title=document.getElementById("cTitle").value.trim();var content=document.getElementById("cContent").value.trim();var mood=document.getElementById("cMood").value;var tags=document.getElementById("cTags").value.split(",").map(function(t){return t.trim()}).filter(Boolean);if(!title||!content){alert("Title and content are required");return}');
    lines.push('var d;if(editId){d=await api("PUT","/api/entries/"+editId,{title:title,content:content,mood:mood,tags:tags})}else{d=await api("POST","/api/entries",{title:title,content:content,mood:mood,tags:tags})}');
    lines.push('if(d.success){closeCompose();loadEntries();if(d.entry)viewEntry(d.entry.id)}else{alert(d.message||"Save failed")}}');

    lines.push('async function deleteEntry(id){if(!confirm("Delete this entry permanently?"))return;var d=await api("DELETE","/api/entries/"+id);if(d.success){currentId=null;document.getElementById("entryView").classList.add("hidden");document.getElementById("emptyView").classList.remove("hidden");loadEntries()}else{alert(d.message)}}');

    lines.push('function searchEntries(q){renderList(q)}');

    lines.push('async function updateStats(){var d=await api("GET","/api/stats");if(!d.success)return;document.getElementById("statEntries").textContent=d.totalEntries||0;document.getElementById("statWords").textContent=d.totalWords||0;document.getElementById("statStreak").textContent=d.streak||0;}');

    lines.push('async function showStats(){var d=await api("GET","/api/stats");if(!d.success)return;var html="";html+=\'<div class="grid grid-cols-3 gap-3 mb-4">\';html+=\'<div class="text-center p-3 bg-slate-900 rounded-xl"><div class="text-2xl font-black text-emerald-400">\'+(d.totalEntries||0)+\'</div><div class="text-[10px] text-slate-500 uppercase">Entries</div></div>\';html+=\'<div class="text-center p-3 bg-slate-900 rounded-xl"><div class="text-2xl font-black text-cyan-400">\'+(d.totalWords||0)+\'</div><div class="text-[10px] text-slate-500 uppercase">Words</div></div>\';html+=\'<div class="text-center p-3 bg-slate-900 rounded-xl"><div class="text-2xl font-black text-purple-400">\'+(d.streak||0)+\'</div><div class="text-[10px] text-slate-500 uppercase">Day Streak</div></div>\';html+=\'</div>\';');
    lines.push('var mc=d.moodCounts||{};if(Object.keys(mc).length>0){html+=\'<div class="mb-3"><div class="text-xs text-slate-400 mb-2 font-bold">Mood Distribution</div>\';var maxMood=Math.max.apply(null,Object.values(mc));Object.keys(mc).forEach(function(m){var pct=Math.round(mc[m]/maxMood*100);html+=\'<div class="flex items-center gap-2 mb-1"><span class="text-xs w-16 \'+moodCls(m)+\'">\'+moodIcon(m)+\' \'+m+\'</span><div class="flex-1 bg-slate-800 rounded-full h-2"><div class="bg-emerald-500 h-2 rounded-full" style="width:\'+pct+\'%"></div></div><span class="text-[10px] text-slate-500">\'+mc[m]+\'</span></div>\'});html+=\'</div>\'}');
    lines.push('var tc=d.tagCounts||{};var topTags=Object.entries(tc).sort(function(a,b){return b[1]-a[1]}).slice(0,8);if(topTags.length>0){html+=\'<div><div class="text-xs text-slate-400 mb-2 font-bold">Top Tags</div><div class="flex flex-wrap gap-1">\';topTags.forEach(function(t){html+=\'<span class="tag">\'+esc(t[0])+\' (\'+t[1]+\')</span>\'});html+=\'</div></div>\'}');
    lines.push('document.getElementById("statsContent").innerHTML=html;document.getElementById("statsModal").classList.remove("hidden");}');

    lines.push('async function logout(){await api("POST","/api/auth/logout");window.location.href="/"}');

    lines.push('setInterval(loadEntries,15000);');
    lines.push('loadEntries();renderTags();');
    lines.push('</script></body></html>');
    return lines.join('\n');
}

// ============================================================================
// Server Startup
// ============================================================================

var server = app.listen(PORT, "0.0.0.0", function() {
    var actualPort = server.address().port;
    console.log("[InkWell] Journaling platform listening on port " + actualPort);
});

setInterval(function() {}, 24 * 60 * 60 * 1000);

process.on("SIGTERM", function() { process.exit(0); });
process.on("SIGINT", function() { process.exit(0); });
process.on("uncaughtException", function(err) {
    var codes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"];
    if (err && codes.indexOf(err.code) === -1) console.error("[InkWell] Uncaught:", err.message);
});
process.on("unhandledRejection", function(reason) {
    var codes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"];
    if (reason && reason.code && codes.indexOf(reason.code) === -1) console.error("[InkWell] Rejection:", reason.message || reason);
});
