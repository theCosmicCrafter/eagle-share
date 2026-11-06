// Eagle Share — service context.
// Owns: config.json, the gallery server (via server/server.js), and a
// loopback-only control plane the panel (and nothing else) talks to.
// Runs headless in serviceMode; also runs inside the panel window where it
// fail-softs (control port already bound) — the panel drives via fetch().
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { createGallery, lanIP } = require('../server/server.js');

const CTRL_PORT = 8320;
const cfg = { enabled: false, port: 8321, pin: '', ctrlPort: CTRL_PORT };
let pluginDir = null;
let gallery = null;
let externalUrl = null;   // another server already owns the gallery port
let libPath = null;

function configPath() { return path.join(pluginDir || process.cwd(), 'config.json'); }

function loadConfig() {
    try { Object.assign(cfg, JSON.parse(fs.readFileSync(configPath(), 'utf8'))); }
    catch (e) {}
}
function saveConfig() {
    try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); } catch (e) {}
}

function getLibraryPath() {
    try { return libPath || (typeof eagle !== 'undefined' && eagle.library && eagle.library.path) || null; }
    catch (e) { return libPath; }
}

function probeExternal(port, cb) {
    // Any HTTP response = port occupied. Ours if /api/status reports running
    // (node build) or /api/meta returns the gallery shape (python build).
    const hit = (p, done) => {
        const req = http.get({ host: lanIP(), port, path: p, timeout: 1500 }, res => {
            let b = '';
            res.on('data', d => b += d);
            res.on('end', () => done(b));
        });
        req.on('timeout', () => { req.destroy(); done(null); });
        req.on('error', () => done(null));
    };
    hit('/api/status', b => {
        if (b === null) return cb(null, { occupied: false });
        try { if (JSON.parse(b).running) return cb(null, { occupied: true, ours: true }); } catch (e) {}
        hit('/api/meta', b2 => {
            if (b2 === null) return cb(null, { occupied: true, ours: false });
            try {
                const j = JSON.parse(b2);
                if (typeof j.total === 'number' && Array.isArray(j.folders))
                    return cb(null, { occupied: true, ours: true });
            } catch (e) {}
            cb(null, { occupied: true, ours: false });
        });
    });
}

async function startGallery() {
    externalUrl = null;
    if (gallery && gallery.status().running) return { ok: true, already: true };
    // port-conflict check — maybe the standalone service (or another
    // instance) already serves this port
    const probe = await new Promise(r => probeExternal(cfg.port, (e, j) => r(j)));
    if (probe && probe.occupied) {
        if (probe.ours) {
            externalUrl = 'http://' + lanIP() + ':' + cfg.port;
            return { ok: true, external: true, url: externalUrl };
        }
        return { ok: false, error: 'port ' + cfg.port + ' is in use by another application' };
    }
    if (!gallery) {
        gallery = createGallery({
            port: cfg.port, pin: cfg.pin,
            dataDir: pluginDir || process.cwd(),
            getLibraryPath,
            onConfig: c => { cfg.pin = c.pin; cfg.port = c.port; saveConfig(); },
        });
    } else {
        gallery.cfg.port = cfg.port; gallery.cfg.pin = cfg.pin;
    }
    try {
        const r = await gallery.start();
        return { ok: true, url: r.url };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function stopGallery() {
    externalUrl = null;
    if (gallery) await gallery.stop();
    return { ok: true };
}

function statusPayload() {
    const g = gallery ? gallery.status() : {};
    return {
        enabled: cfg.enabled,
        running: !!(g.running),
        external: !!externalUrl,
        url: externalUrl || (g.running ? 'http://' + lanIP() + ':' + g.port : null),
        lanIP: lanIP(),
        port: cfg.port, pinSet: !!(g.pinSet || cfg.pin),
        libraryPath: getLibraryPath(),
        libraryName: (() => { try { return eagle.library.name; } catch (e) { return null; } })(),
        total: g.total || 0, scanning: !!g.scanning, progress: g.progress || 0,
        error: null,
    };
}

function ctrlRoute(req, res) {
    const send = (o, c) => {
        res.writeHead(c || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(o));
    };
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/control/status') return send(statusPayload());
    if (req.method === 'POST') {
        // anti-drive-by: any web page on this machine could otherwise POST
        // here cross-origin. Requiring a custom header forces a CORS preflight
        // we never grant — only the plugin panel can write.
        if (req.headers['x-es-ctrl'] !== '1') return send({ error: 'forbidden' }, 403);
        let body = '', n = 0;
        req.on('data', d => {
            n += d.length;
            if (n > 16384) { req.destroy(); return; }
            body += d;
        });
        req.on('end', async () => {
            let j = {};
            try { j = JSON.parse(body || '{}'); } catch (e) {}
            if (u.pathname === '/control/start') {
                cfg.enabled = true; saveConfig();
                return send(await startGallery());
            }
            if (u.pathname === '/control/stop') {
                cfg.enabled = false; saveConfig();
                return send(await stopGallery());
            }
            if (u.pathname === '/control/config') {
                let restart = false;
                if (typeof j.port === 'number' && j.port > 0 && j.port < 65536 && j.port !== cfg.port) {
                    cfg.port = j.port; restart = cfg.enabled;
                }
                if (typeof j.pin === 'string') { cfg.pin = j.pin; if (gallery) gallery.cfg.pin = j.pin; }
                saveConfig();
                if (restart) { await stopGallery(); await startGallery(); }
                return send({ ok: true });
            }
            send({ error: 'unknown' }, 404);
        });
        return;
    }
    send({ error: 'unknown' }, 404);
}

function boot() {
    loadConfig();
    // loopback-only control plane — never reachable off this machine
    const ctrl = http.createServer(ctrlRoute);
    ctrl.on('error', () => { /* window context: service context already owns it */ });
    ctrl.listen(CTRL_PORT, '127.0.0.1');
    if (ctrl.address()) { /* bound */ }
    if (cfg.enabled) {
        startGallery().then(() => {}).catch(() => {});
    }
    if (typeof eagle !== 'undefined' && eagle.onLibraryChanged) {
        try {
            eagle.onLibraryChanged(() => {
                libPath = null;
                if (gallery && gallery.status().running) {
                    stopGallery().then(() => startGallery());
                }
            });
        } catch (e) {}
    }
    if (typeof eagle !== 'undefined' && eagle.onPluginBeforeExit) {
        try { eagle.onPluginBeforeExit(() => { if (gallery) gallery.stop(); }); } catch (e) {}
    }
}

if (typeof eagle !== 'undefined' && eagle.onPluginCreate) {
    eagle.onPluginCreate(plugin => {
        try { pluginDir = plugin && plugin.path ? plugin.path : pluginDir; } catch (e) {}
        try { libPath = eagle.library.path; } catch (e) {}
        boot();
    });
} else {
    boot();
}
