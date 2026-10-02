// server.js — server lokal: penyaji cek_nik.html + proxy nama SIPOL KPU.
// Validasi struktur NIK dilakukan 100% di browser (data wilayah tertanam di cek_nik.html);
// server ini HANYA meneruskan nama pengurus/anggota parpol dari KPU SIPOL (selalu ter-mask).
// Tanpa dependensi apa pun. Butuh Node >= 18 (fetch bawaan).
// Jalankan: node server.js   →  buka http://127.0.0.1:8787/
// Env opsional: PORT=8787  KPU_URL=...
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 8787;
// HOST=0.0.0.0 dipakai bila di-deploy ke host cloud (Render/Fly/Koyeb dst.) yang
// butuh bind ke semua interface; default tetap 127.0.0.1 agar lokal tertutup.
const HOST = process.env.HOST || '127.0.0.1';
const KPU_URL = process.env.KPU_URL || 'https://infopemilu.kpu.go.id/Pemilu/Cari_nik_parpol/getDataFromAjx';
const BANSOS_URL = process.env.BANSOS_URL || 'https://cekbansos.kemensos.go.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

// ---------- masking (nama & NIK tidak pernah utuh keluar dari server) ----------
function maskNik(nik) { return nik.slice(0, 6) + '********' + nik.slice(-4); }
function maskNama(nama) {
  const p = String(nama || '').trim().split(/\s+/).filter(Boolean);
  return p.length ? p[0] + ' ****' : '';
}

// ---------- helper fetch dengan batas waktu ----------
async function req(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal, redirect: 'follow' }));
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// ---------- KPU SIPOL → nama pengurus/anggota parpol ----------
async function cekSipol(nik) {
  const kpu = await req(KPU_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://infopemilu.kpu.go.id/Pemilu/Cari_nik',
    },
    body: 'input_ajx=' + encodeURIComponent(nik),
  }, 15000);

  const hasil = {
    nikMasked: maskNik(nik),
    nama: { found: false, value: null, partai: null, jabatan: null, unit: null },
    sumber: { kpu: { status: kpu.status || 0, state: 'error', jumlah: 0 } },
    galat: [],
  };

  if (kpu.ok) {
    try {
      const arr = JSON.parse(kpu.text);
      if (Array.isArray(arr)) {
        hasil.sumber.kpu.state = arr.length ? 'found' : 'empty';
        hasil.sumber.kpu.jumlah = arr.length;
        const r = arr[0] || {};
        hasil.nama = {
          found: !!r.nama,
          value: maskNama(r.nama) || null,
          partai: r.nama_parpol || null,
          jabatan: r.jabatan || null,
          unit: r.unit || r.nama_wilayah || null,
        };
      } else {
        hasil.sumber.kpu.state = 'bad';
        hasil.galat.push('kpu: respons bukan daftar');
      }
    } catch (e) {
      hasil.sumber.kpu.state = 'bad';
      hasil.galat.push('kpu: JSON tidak terbaca');
    }
  } else {
    hasil.galat.push('kpu: ' + (kpu.error || 'HTTP ' + kpu.status));
  }
  return hasil;
}

// ---------- Cek Bansos Kemensos (DTSEN) — dipakai test.html ----------
// Situs ini TIDAK mengirim header CORS (malah Cross-Origin-Resource-Policy: same-origin),
// sehingga halaman browser tidak boleh memanggilnya langsung; lewat server lokal inilah jalurnya.
// CAPTCHA tetap diselesaikan MANUSIA lewat gambar di test.html — tidak ada OCR / bypass di sini,
// dan satu kode captcha dipakai tepat satu kali (dihapus setelah dipakai).
const SESSIONS = new Map();          // id -> { token, cookie, t }
const SESSION_TTL = 5 * 60 * 1000;   // 5 menit

function setCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const v = res.headers.get('set-cookie');
  return v ? v.split(/,(?=\s*[^;]+=)/) : [];
}
function mergeCookie(prev, res) {
  const jar = new Map();
  String(prev || '').split(';').map(s => s.trim()).filter(Boolean).forEach(p => {
    const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i), p.slice(i + 1));
  });
  setCookies(res).forEach(c => {
    const first = String(c).split(';')[0]; const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1));
  });
  return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; ');
}
async function bFetch(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 20000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}
function gcSessions() {
  const now = Date.now();
  for (const [k, v] of SESSIONS) if (now - v.t > SESSION_TTL) SESSIONS.delete(k);
}

// 1) ambil halaman (cookie + token CSRF) lalu gambar CAPTCHA-nya
async function bansosCaptcha() {
  const home = await bFetch(BANSOS_URL + '/', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'id-ID,id;q=0.9' },
  });
  if (!home.ok) throw new Error('halaman cekbansos HTTP ' + home.status);
  const html = await home.text();
  const cookie = mergeCookie('', home);
  const m = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/i) || html.match(/name=["']_token["']\s+value=["']([^"']+)["']/i);
  if (!m) throw new Error('token CSRF tidak ditemukan di halaman');

  const cap = await bFetch(BANSOS_URL + '/captcha/flat?' + Math.random().toString(36).slice(2), {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Referer': BANSOS_URL + '/', 'Accept': 'image/*,*/*' },
  });
  if (!cap.ok) throw new Error('gambar captcha HTTP ' + cap.status);
  const mime = (cap.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const buf = Buffer.from(await cap.arrayBuffer());
  if (buf.length < 100) throw new Error('gambar captcha kosong');

  gcSessions();
  const id = require('crypto').randomBytes(16).toString('hex');
  if (SESSIONS.size > 50) SESSIONS.delete(SESSIONS.keys().next().value);
  SESSIONS.set(id, { token: m[1], cookie: mergeCookie(cookie, cap), t: Date.now() });
  return { id, img: 'data:' + mime + ';base64,' + buf.toString('base64') };
}

// 2) POST /cekbansos_nik (captcha diisi manusia) -> 302 -> GET /hasil-nik -> parse tabel DTSEN
function parseHasil(html) {
  const tb = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (tb) {
    const trs = tb[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trs) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
        .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim());
      if (cells.length >= 11) return {
        state: 'found', nama: cells[0], desil: cells[1], dtsen: cells[2],
        sembako: { status: cells[3], periode: cells[4] },
        pkh: { status: cells[5], periode: cells[6] },
        pbi: { status: cells[7], periode: cells[8], ket: cells[9] },
        kpd: cells[10],
      };
    }
  }
  const alert = (html.match(/<div[^>]*class=["'][^"']*alert[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1];
  const pesan = alert ? alert.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return { state: 'empty', pesan: pesan || 'NIK tidak ditemukan dalam data DTSEN.' };
}

async function bansosCheck(id, nik, captcha) {
  gcSessions();
  const s = SESSIONS.get(id);
  if (!s) return { state: 'session', pesan: 'Sesi captcha kedaluwarsa — muat ulang captcha lalu ulangi.' };
  SESSIONS.delete(id); // satu captcha = satu percobaan

  const body = new URLSearchParams({ _token: s.token, nik_input: nik, captcha: captcha }).toString();
  const post = await bFetch(BANSOS_URL + '/cekbansos_nik', {
    method: 'POST', redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': s.cookie,
      'Origin': BANSOS_URL,
      'Referer': BANSOS_URL + '/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    body,
  });
  const cookie = mergeCookie(s.cookie, post);
  await post.arrayBuffer().catch(() => {});   // buang body 302
  const loc = post.headers.get('location') || '';

  if (loc && !/hasil-nik/i.test(loc)) {
    return { state: 'captcha', pesan: 'Permintaan ditolak (kode captcha salah / sesi kedaluwarsa / NIK tidak diterima). Muat ulang captcha lalu coba lagi.' };
  }
  if (!loc) return { state: 'error', pesan: 'Respons tidak terduga dari cekbansos (HTTP ' + post.status + ').' };

  const r = await bFetch(new URL(loc, BANSOS_URL).href, {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Referer': BANSOS_URL + '/', 'Accept': 'text/html,application/xhtml+xml' },
  });
  const html = await r.text();
  if (!r.ok) return { state: 'error', pesan: 'Gagal membaca hasil (HTTP ' + r.status + ').' };
  return Object.assign(parseHasil(html), { sumber: 'cekbansos.kemensos.go.id — DTSEN' });
}

// ---------- HTTP ----------
const server = http.createServer(async (rq, res) => {
  const u = new URL(rq.url, 'http://x');
  const cors = (r) => { r.setHeader('Access-Control-Allow-Origin', '*'); r.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); r.setHeader('Access-Control-Allow-Headers', 'Content-Type'); };
  const json = (code, obj) => { cors(res); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

  if (rq.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }
  if (u.pathname === '/api/health') return json(200, { ok: true, port: PORT });

  if (u.pathname === '/api/check') {
    const nik = (u.searchParams.get('nik') || '').trim();
    if (!/^\d{16}$/.test(nik)) return json(422, { error: 'NIK harus tepat 16 digit angka.' });
    try {
      const h = await cekSipol(nik);
      console.log(`[${new Date().toISOString()}] check nik=${maskNik(nik)} kpu=${h.sumber.kpu.state}`);
      return json(200, h);
    } catch (e) {
      return json(500, { error: 'server gagal: ' + String(e && e.message || e) });
    }
  }

  if (u.pathname === '/api/bansos/captcha') {
    try {
      const c = await bansosCaptcha();
      console.log(`[${new Date().toISOString()}] bansos captcha siap`);
      return json(200, { ok: true, id: c.id, img: c.img });
    } catch (e) {
      return json(502, { ok: false, error: 'captcha gagal: ' + String(e && e.message || e) });
    }
  }

  if (rq.method === 'POST' && u.pathname === '/api/bansos/check') {
    let raw = '';
    try {
      for await (const chunk of rq) { raw += chunk; if (raw.length > 4096) throw new Error('body terlalu besar'); }
      const b = JSON.parse(raw || '{}');
      const nik = String(b.nik || '').trim();
      const captcha = String(b.captcha || '').trim();
      const id = String(b.id || '').trim();
      if (!/^\d{16}$/.test(nik)) return json(422, { ok: false, error: 'NIK harus tepat 16 digit angka.' });
      if (!/^[A-Za-z0-9]{4,10}$/.test(captcha)) return json(422, { ok: false, error: 'Kode captcha tidak valid.' });
      const h = await bansosCheck(id, nik, captcha);
      console.log(`[${new Date().toISOString()}] bansos nik=${maskNik(nik)} state=${h.state}`);
      // NIK ditampilkan utuh ke pemiliknya (ia sendiri yang mengetiknya); log server tetap masked.
      // Nama TIDAK bisa dibuka: situs sudah mengirimnya berbintang di HTML (P******O).
      return json(200, Object.assign({ ok: true, nik: nik }, h));
    } catch (e) {
      return json(500, { ok: false, error: 'server gagal: ' + String(e && e.message || e) });
    }
  }

  if (u.pathname.startsWith('/api/')) return json(404, { error: 'not found' });

  // statis: / → cek_nik.html, sisanya file relatif (tolak traversal)
  let rel = decodeURIComponent(u.pathname === '/' ? '/cek_nik.html' : u.pathname);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  console.log('cek-nik mini server → http://' + HOST + ':' + server.address().port + '/');
  console.log('  nama SIPOL : ' + KPU_URL);
  console.log('  struktur   : di browser (data tertanam di cek_nik.html)');
});
