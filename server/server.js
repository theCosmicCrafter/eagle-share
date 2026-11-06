// Eagle Share — zero-dependency Node gallery server.
// Runs inside the Eagle plugin (serviceMode) or standalone via `node server.js`.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const BROWSER_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'apng']);
const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    apng: 'image/apng', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    json: 'application/json', html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8',
};

const VIRTUAL_IFACE = /vpn|wireguard|wintun|tap|tunnel|proton|tailscale|zerotier|virtual|vmware|virtualbox|hyper-v|docker|loopback|pseudo/i;

function lanIP() {
    const rank = a => a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : 2;
    const cands = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (VIRTUAL_IFACE.test(name)) continue;
        for (const ni of (list || [])) {
            if (ni.family === 'IPv4' && !ni.internal &&
                (/^192\.168\./.test(ni.address) || /^10\./.test(ni.address) ||
                 /^172\.(1[6-9]|2\d|3[01])\./.test(ni.address))) {
                cands.push(ni.address);
            }
        }
    }
    cands.sort((a, b) => rank(a) - rank(b));
    return cands[0] || '127.0.0.1';
}

function stripBOM(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
function readJSON(p) { return fsp.readFile(p, 'utf8').then(t => JSON.parse(stripBOM(t))); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const yieldLoop = () => new Promise(r => setImmediate(r));

function folderMap(folders) {
    const fmap = {};
    const walk = (nodes, parent, p) => {
        for (const n of nodes || []) {
            const full = p ? p + '/' + (n.name || '') : (n.name || '');
            fmap[n.id] = { name: n.name, parent, path: full };
            walk(n.children, n.id, full);
        }
    };
    walk(folders, null, '');
    return fmap;
}

function descendants(fid, fmap) {
    const ids = new Set([fid]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [k, v] of Object.entries(fmap)) {
            if (!ids.has(k) && v.parent && ids.has(v.parent)) { ids.add(k); grew = true; }
        }
    }
    return ids;
}

function createGallery(opts) {
    const state = {
        items: new Map(), folders: [], fmap: {},
        scanning: false, progress: 0, running: false,
        startedAt: 0, libraryPath: '', error: null,
    };
    const cfg = {
        port: opts.port || 8321,
        pin: opts.pin || '',
        dataDir: opts.dataDir || process.cwd(),
        getLibraryPath: opts.getLibraryPath || (() => opts.libraryPath),
    };
    const cacheFile = path.join(cfg.dataDir, 'index_cache.json');
    let server = null, watchTimer = null, rescanTimer = null, lastRescan = 0;

    async function loadFolderTree() {
        try { return (await readJSON(path.join(lib(''), 'metadata.json'))).folders || []; }
        catch (e) { return []; }
    }
    function lib(sub) { return path.join(state.libraryPath, sub); }

    async function scan() {
        const items = new Map();
        const imagesDir = lib('images');
        let dirs;
        try {
            dirs = (await fsp.readdir(imagesDir, { withFileTypes: true }))
                .filter(d => d.isDirectory() && d.name.endsWith('.info'));
        } catch (e) { state.error = 'readdir images: ' + e.message; return items; }
        let n = 0;
        for (const d of dirs) {
            state.progress = ++n;
            if (n % 64 === 0) await yieldLoop();   // keep Eagle's UI responsive
            const dirPath = path.join(imagesDir, d.name);
            let m;
            try { m = await readJSON(path.join(dirPath, 'metadata.json')); }
            catch (e) { continue; }
            if (m.isDeleted) continue;
            const iid = m.id || d.name.slice(0, -5);
            let asset = null, thumb = null;
            try {
                for (const f of await fsp.readdir(dirPath, { withFileTypes: true })) {
                    if (f.name.endsWith('_thumbnail.png')) thumb = f.name;
                    else if (f.name === 'metadata.json' || f.name.endsWith('.bak')) continue;
                    else if (f.isFile() && asset === null) asset = f.name;
                }
            } catch (e) {}
            items.set(iid, {
                id: iid, name: m.name || iid, ext: m.ext || '',
                tags: m.tags || [], folders: m.folders || [],
                annotation: m.annotation || '', w: m.width || 0, h: m.height || 0,
                animated: !!m.animated,
                mtime: m.modificationTime || m.mtime || 0,
                asset, thumb,
            });
        }
        return items;
    }

    async function rescan() {
        if (state.scanning) return;
        state.scanning = true; state.progress = 0; state.error = null;
        try {
            const items = await scan();
            const folders = await loadFolderTree();
            state.items = items; state.folders = folders;
            state.fmap = folderMap(folders);
            try {
                await fsp.writeFile(cacheFile, JSON.stringify({ items: [...items.values()] }));
            } catch (e) {}
        } finally { state.scanning = false; }
    }

    async function loadCache() {
        try {
            const data = JSON.parse(stripBOM(await fsp.readFile(cacheFile, 'utf8')));
            state.items = new Map((data.items || []).map(it => [it.id, it]));
            state.folders = await loadFolderTree();
            state.fmap = folderMap(state.folders);
            return state.items.size > 0;
        } catch (e) { return false; }
    }

    function needRescan() {
        try {
            const mt = fs.statSync(lib('mtime.json')).mtimeMs;
            const ct = fs.statSync(cacheFile).mtimeMs;
            return mt > ct;
        } catch (e) { return true; }
    }

    function watchLibrary() {
        clearInterval(watchTimer);
        watchTimer = setInterval(() => {
            if (needRescan() && !state.scanning) {
                clearTimeout(rescanTimer);
                rescanTimer = setTimeout(rescan, 3000);
            }
        }, 10000);
        watchTimer.unref && watchTimer.unref();
    }

    // ---------- auth ----------
    const pinHash = () => crypto.createHash('sha256').update(cfg.pin).digest('hex');
    function hasPin() { return !!cfg.pin; }
    function authed(req) {
        if (!hasPin()) return true;
        const c = req.headers.cookie || '';
        const m = c.match(/(?:^|;\s*)esh=([0-9a-f]{64})/);
        if (m) {
            try {
                return crypto.timingSafeEqual(Buffer.from(m[1], 'hex'), Buffer.from(pinHash(), 'hex'));
            } catch (e) { return false; }
        }
        const u = new URL(req.url, 'http://x');
        return u.searchParams.get('pin') === cfg.pin;
    }
    function isLocal(req) {
        const a = req.socket.remoteAddress || '';
        return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
    }

    // ---------- responses ----------
    function json(res, obj, code) {
        const b = JSON.stringify(obj);
        res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(b);
    }
    function sendFile(res, fp, opts2) {
        fs.stat(fp, (err, st) => {
            if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
            const ext = path.extname(fp).slice(1).toLowerCase();
            const h = {
                'Content-Type': MIME[ext] || 'application/octet-stream',
                'Content-Length': st.size,
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'",
            };
            if (opts2 && opts2.dl) h['Content-Disposition'] = 'attachment; filename="' + encodeURIComponent(opts2.dl).replace(/"/g, '') + '"';
            res.writeHead(200, h);
            fs.createReadStream(fp).pipe(res);
        });
    }
    function readBody(req, res, cb) {
        let body = '', n = 0;
        req.on('data', d => {
            n += d.length;
            if (n > 16384) { req.destroy(); json(res, { error: 'too large' }, 413); return; }
            body += d;
        });
        req.on('end', () => cb(body));
    }
    const okHosts = () => {
        const b = server && server.address() ? server.address().address : '';
        return new Set([b, 'localhost', '127.0.0.1', '::1', os.hostname().toLowerCase()]);
    };
    function hostOK(req) {
        const raw = req.headers.host;
        if (!raw) return true;
        const h = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
        return okHosts().has(h);
    }
    const itemDir = iid => path.join(lib('images'), iid + '.info');
    function serveGallery(res) {
        sendFile(res, path.join(__dirname, 'gallery.html'));
    }
    const LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Eagle Share</title><style>body{background:#1c1c1e;color:#eee;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}form{background:#262628;padding:32px;border-radius:12px;text-align:center}input{padding:10px;border-radius:8px;border:1px solid #3a3a3d;background:#1c1c1e;color:#eee;font-size:16px;width:180px}button{margin-left:8px;padding:10px 20px;border:0;border-radius:8px;background:#4f8ef7;color:#fff;font-size:15px}.err{color:#f66;margin-top:12px;font-size:13px}</style></head><body><form method=POST action="/login"><h3>Eagle Share</h3><input name=pin type=password placeholder=PIN autofocus><button>Open</button>{ERR}</form></body></html>`;

    async function route(req, res) {
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;

        // DNS-rebinding guard: only answer requests addressed to our bind IP
        // (or loopback/hostname). A foreign Host header = cross-origin page
        // rebinding to the LAN — reject before anything else.
        if (!hostOK(req)) { res.writeHead(421); res.end('misdirected'); return; }

        if (p === '/login' && req.method === 'POST') {
            readBody(req, res, body => {
                const pin = new URLSearchParams(body).get('pin') || '';
                if (pin === cfg.pin) {
                    res.writeHead(302, { 'Set-Cookie': 'esh=' + pinHash() + '; Path=/; HttpOnly; SameSite=Lax', Location: '/' });
                    res.end();
                } else {
                    res.writeHead(401, { 'Content-Type': 'text/html' });
                    res.end(LOGIN_PAGE.replace('{ERR}', '<div class=err>Wrong PIN</div>'));
                }
            });
            return;
        }

        if (!authed(req) && p !== '/api/status') {
            if (p.startsWith('/api/')) { json(res, { error: 'auth', pinRequired: true }, 401); return; }
            if (p === '/' || p === '') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(LOGIN_PAGE.replace('{ERR}', ''));
                return;
            }
            res.writeHead(401); res.end('auth required'); return;
        }

        if (p === '/' || p === '') return serveGallery(res);

        if (p === '/api/meta') {
            const tagCounts = {};
            for (const it of state.items.values())
                for (const t of it.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
            const fmapPaths = {};
            for (const [k, v] of Object.entries(state.fmap)) fmapPaths[k] = v.path;
            return json(res, {
                total: state.items.size, scanning: state.scanning,
                progress: state.progress, folders: state.folders, fmap: fmapPaths,
                tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]),
            });
        }

        if (p === '/api/items') {
            const q = (u.searchParams.get('q') || '').toLowerCase().trim();
            const tag = u.searchParams.get('tag') || '';
            const folder = u.searchParams.get('folder') || '';
            let offset = Math.max(0, parseInt(u.searchParams.get('offset')) || 0);
            let limit = Math.min(300, Math.max(1, parseInt(u.searchParams.get('limit')) || 120));
            const fset = folder ? descendants(folder, state.fmap) : null;
            const out = [];
            for (const it of state.items.values()) {
                if (tag && !it.tags.includes(tag)) continue;
                if (fset && !it.folders.some(f => fset.has(f))) continue;
                if (q && !it.name.toLowerCase().includes(q) && !it.annotation.toLowerCase().includes(q)) continue;
                out.push(it);
            }
            out.sort((a, b) => b.mtime - a.mtime);
            return json(res, { total: out.length, offset, items: out.slice(offset, offset + limit) });
        }

        if (p === '/api/status') {
            if (hasPin() && !authed(req))
                return json(res, { running: true, pinRequired: true });
            return json(res, {
                running: true, library: state.libraryPath, libraryName: path.basename(state.libraryPath, '.library'),
                total: state.items.size, scanning: state.scanning, progress: state.progress,
                startedAt: state.startedAt, uptime: state.startedAt ? Date.now() - state.startedAt : 0,
                pinRequired: hasPin(), port: cfg.port, error: state.error,
            });
        }

        if (p === '/api/rescan') {
            if (Date.now() - lastRescan < 30000)
                return json(res, { ok: true, throttled: true, scanning: state.scanning });
            lastRescan = Date.now();
            rescan();
            return json(res, { ok: true, scanning: true });
        }

        if (p === '/api/config') {
            // config writes require a PIN session (or a genuinely local client);
            // with no PIN there is no legitimate network writer — the panel
            // uses the loopback control plane instead
            if (!isLocal(req) && !(hasPin() && authed(req)))
                return json(res, { error: 'forbidden' }, 403);
            if (req.method === 'GET') return json(res, { port: cfg.port, pinSet: hasPin(), enabled: true });
            if (req.method === 'POST') {
                readBody(req, res, async body => {
                    try {
                        const j = JSON.parse(body || '{}');
                        if (typeof j.pin === 'string') cfg.pin = j.pin;
                        if (typeof j.port === 'number' && j.port !== cfg.port && j.port > 0 && j.port < 65536) {
                            cfg.port = j.port;
                            if (server) { await stop(); await start(); }
                        }
                        if (opts.onConfig) opts.onConfig({ port: cfg.port, pin: cfg.pin });
                        json(res, { ok: true, port: cfg.port, pinSet: hasPin() });
                    } catch (e) { json(res, { error: e.message }, 400); }
                });
                return;
            }
        }

        const m = p.match(/^\/(thumb|img|dl)\/([A-Za-z0-9]+)$/);
        if (m) {
            const it = state.items.get(m[2]);
            const d = itemDir(m[2]);
            if (!it || !fs.existsSync(d)) { res.writeHead(404); res.end('not found'); return; }
            if (m[1] === 'thumb') {
                if (it.thumb) return sendFile(res, path.join(d, it.thumb));
                if (it.asset && BROWSER_EXTS.has(it.ext.toLowerCase())) return sendFile(res, path.join(d, it.asset));
            } else if (m[1] === 'img') {
                if (it.asset) return sendFile(res, path.join(d, it.asset));
            } else if (m[1] === 'dl') {
                if (it.asset) return sendFile(res, path.join(d, it.asset), { dl: it.name + '.' + it.ext });
            }
            res.writeHead(404); res.end('not found'); return;
        }

        res.writeHead(404); res.end('not found');
    }

    async function start() {
        if (server) return { already: true };
        state.libraryPath = cfg.getLibraryPath();
        if (!state.libraryPath) throw new Error('no library path');
        const had = await loadCache();
        const bound = lanIP();
        server = http.createServer((req, res) => {
            route(req, res).catch(e => { try { res.writeHead(500); res.end('error'); } catch (_) {} });
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(cfg.port, bound, () => { server.off('error', reject); resolve(); });
        });
        state.running = true; state.startedAt = Date.now();
        if (!had || needRescan()) rescan();
        watchLibrary();
        return { url: 'http://' + bound + ':' + cfg.port, cached: had };
    }

    async function stop() {
        clearInterval(watchTimer);
        if (server) { const s = server; server = null; await new Promise(r => s.close(r)); }
        state.running = false;
    }

    function status() {
        return {
            running: state.running, port: cfg.port, total: state.items.size,
            scanning: state.scanning, progress: state.progress,
            pinSet: hasPin(), libraryPath: state.libraryPath,
        };
    }

    return { start, stop, status, rescan, cfg };
}

module.exports = { createGallery, lanIP };

if (require.main === module) {
    const libPath = process.argv[2];
    const port = parseInt(process.argv[3]) || 8321;
    const g = createGallery({ libraryPath: libPath, port, dataDir: process.cwd() });
    g.start().then(r => console.log('serving', JSON.stringify(r))).catch(e => { console.error(e.message); process.exit(1); });
}
