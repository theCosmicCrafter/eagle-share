// Eagle Share — control panel. Talks to the loopback control plane (127.0.0.1:8320)
// so it can start/stop the gallery regardless of JS-realm boundaries.
(function () {
    const CTRL = 'http://127.0.0.1:' + (typeof CFGCTRL === 'undefined' ? 8320 : CFGCTRL);
    const $ = id => document.getElementById(id);
    const msg = (t, cls) => { const m = $('msg'); m.textContent = t || ''; m.className = cls || ''; };

    async function call(path, body) {
        const r = await fetch(CTRL + path, {
            method: body ? 'POST' : 'GET',
            headers: body ? { 'Content-Type': 'application/json', 'X-ES-Ctrl': '1' } : { 'X-ES-Ctrl': '1' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return r.json();
    }

    function drawQR(text) {
        const cv = $('qr');
        if (!text) { cv.style.display = 'none'; return; }
        try {
            const q = qrcode(0, 'M');
            q.addData(text); q.make();
            const n = q.getModuleCount(), cell = Math.floor(176 / n), sz = cell * n;
            cv.width = cv.height = sz;
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sz, sz);
            ctx.fillStyle = '#000';
            for (let r = 0; r < n; r++)
                for (let c = 0; c < n; c++)
                    if (q.isDark(r, c)) ctx.fillRect(c * cell, r * cell, cell, cell);
            cv.style.display = 'block';
        } catch (e) { cv.style.display = 'none'; }
    }

    function fmtUptime(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    }

    async function refresh() {
        let st;
        try { st = await call('/control/status'); }
        catch (e) {
            $('dot').className = 'dot';
            $('state').textContent = 'Service unavailable';
            $('stateSub').textContent = 'control plane not responding';
            return;
        }
        const dot = $('dot');
        if (st.running) {
            dot.className = 'dot on';
            $('state').textContent = 'Sharing on';
            $('stateSub').textContent = 'live on your network';
        } else if (st.external) {
            dot.className = 'dot ext';
            $('state').textContent = 'Already running';
            $('stateSub').textContent = 'standalone service owns the port';
        } else {
            dot.className = 'dot';
            $('state').textContent = 'Stopped';
            $('stateSub').textContent = 'gallery is not serving';
        }
        $('url').textContent = st.url || '';
        $('inPort').value = st.port;
        $('sItems').textContent = st.total ? st.total.toLocaleString() : '—';
        $('sScan').textContent = st.scanning ? st.progress.toLocaleString() + '…' : (st.running ? 'done' : '—');
        $('sPin').textContent = st.pinSet ? 'set' : 'open';
        $('sLib').textContent = st.libraryName || '—';
        drawQR(st.url);
    }

    $('url').onclick = () => {
        const t = $('url').textContent;
        if (!t) return;
        try { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => msg('URL copied', 'ok'), () => {}); }
        catch (e) {}
    };

    $('bStart').onclick = async () => {
        msg('Starting…');
        const r = await call('/control/start', {});
        if (r.ok && r.external) msg('Standalone service already serves this port', 'ok');
        else if (r.ok) msg('Sharing on ' + (r.url || ''), 'ok');
        else msg('Failed: ' + (r.error || 'unknown'), 'err');
        refresh();
    };
    $('bStop').onclick = async () => { await call('/control/stop', {}); msg('Stopped'); refresh(); };
    $('bPort').onclick = async () => {
        const p = parseInt($('inPort').value);
        if (!p || p < 1 || p > 65535) { msg('Bad port', 'err'); return; }
        await call('/control/config', { port: p });
        msg('Port set to ' + p, 'ok'); refresh();
    };
    $('bPin').onclick = async () => {
        const v = $('inPin').value;
        await call('/control/config', { pin: v });
        $('inPin').value = '';
        msg(v ? 'PIN set' : 'PIN cleared', 'ok'); refresh();
    };
    $('bPinClear').onclick = async () => {
        await call('/control/config', { pin: '' });
        $('inPin').value = '';
        msg('PIN cleared — open on LAN', 'ok'); refresh();
    };

    refresh();
    setInterval(refresh, 2500);
})();
