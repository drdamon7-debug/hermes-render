/**
 * GLP BodyGuard — T1 RENDER SERVICE
 * =================================
 * Add to the existing `hermes-render` Express app.
 *
 *   POST /render/deck  → Format A (Insight Deck) + Format C (Mockup Breakdown) → PNGs (base64)
 *   POST /render/loop  → Format B (Typographic Loop) → PNG frames → ffmpeg → MP4 (base64)
 *   GET  /render/health
 *
 * Returns base64. n8n uploads to Google Drive, shares public, feeds the URL to Blotato.
 * No new storage layer — reuses the Drive pattern already wired in the pipeline.
 *
 * DESIGN CONTRACT (do not violate):
 *   - Disclaimer is ALWAYS footer small print. Never spoken. Never in a headline.
 *   - NO red. No alerts. No warning iconography. The product does not diagnose, flag, or triage.
 *   - layout_style is PER-SLIDE → maximum structural variance → no visual-similarity fingerprint.
 *   - Format B is SILENT. No TTS, ever. A repeated synthetic voice is an audio fingerprint
 *     and Meta's duplicate detection matches on audio.
 */

const express = require('express');
const puppeteer = require('puppeteer');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const router = express.Router();

/* ─────────────────────────── DESIGN TOKENS ─────────────────────────── */
const T = {
  bg: '#0B0B0B', fg: '#F5F7F8', accent: '#16D6C6', accent2: '#00B4D8',
  muted: '#A8B4B7', dim: '#5C6B6E', rule: '#1F2A2B', faint: '#3E4A4C',
};
const DISCLAIMER = 'Educational self-tracking tool. Not medical advice.';
const FONTS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&display=swap';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Deterministic PRNG so variance_seed reproduces exactly. */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

/* ─────────────────────────── SHARED CSS ─────────────────────────── */
function css(w, h) {
  return `
@import url('${FONTS}');
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111;display:flex;flex-direction:column;align-items:center;gap:20px;padding:20px}
.slide{position:relative;width:${w}px;height:${h}px;background:${T.bg};overflow:hidden;font-family:'Inter',sans-serif;color:${T.fg}}
.glow{position:absolute;border-radius:50%;filter:blur(140px)}
.pad{position:absolute;inset:0;padding:96px 88px;display:flex;flex-direction:column}
.spacer{flex:1}
.eyebrow{font-size:20px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:${T.accent}}
.eyebrow .dim{color:${T.dim}}

.hero{font-family:'Instrument Serif',serif;font-size:108px;line-height:1.0;letter-spacing:-.015em}
.hero .accent{color:${T.accent};font-style:italic}

.split-title{font-size:52px;font-weight:700;line-height:1.18;letter-spacing:-.02em}
.split-body{font-size:29px;line-height:1.55;color:${T.muted}}
.split-rule{height:3px;background:${T.accent};width:88px}

.num{font-family:'Instrument Serif',serif;font-size:150px;line-height:1;color:${T.accent}}
.stack-title{font-size:54px;font-weight:700;line-height:1.15;letter-spacing:-.02em}
.stack-body{font-size:29px;line-height:1.55;color:${T.muted}}

.quote{font-family:'Instrument Serif',serif;font-style:italic;font-size:64px;line-height:1.22}

.ladder-row{display:flex;align-items:baseline;gap:28px;padding:22px 0;border-bottom:1px solid ${T.rule}}
.ladder-key{font-family:'Instrument Serif',serif;font-size:44px;color:${T.accent};min-width:90px}
.ladder-val{font-size:31px;line-height:1.45;color:${T.fg}}

.send{border:2px solid ${T.accent};border-radius:100px;padding:26px 46px;display:inline-flex;
      align-items:center;gap:14px;font-size:27px;font-weight:600;color:${T.accent}}

/* FOOTER — the disclaimer lives here. Small print. Never spoken. Costs zero content words. */
.foot{position:absolute;left:88px;right:88px;bottom:56px;display:flex;justify-content:space-between;
      align-items:flex-end;font-size:18px;font-weight:500;color:${T.faint}}
.foot .brand{color:${T.accent};font-weight:600;font-size:19px}
.foot .legal{text-align:right;line-height:1.45;max-width:520px}
.swipe{font-size:21px;font-weight:600;color:${T.accent};letter-spacing:.04em}

/* ── Format C: mockup spotlight ── */
.shot-wrap{position:relative;flex:1;display:flex;align-items:center;justify-content:center;padding:24px 0}
.shot{max-width:100%;max-height:100%;border-radius:28px;border:1px solid ${T.rule}}
.shot-dim{position:absolute;inset:0;background:rgba(11,11,11,.72)}
.shot-focus{position:absolute;border:2px solid ${T.accent};border-radius:14px;
            box-shadow:0 0 0 9999px rgba(11,11,11,.72)}
.anno{position:absolute;font-size:24px;font-weight:600;color:${T.fg};background:${T.bg};
      border:1px solid ${T.accent};border-radius:12px;padding:14px 20px;max-width:420px;line-height:1.4}
.guardrail{font-size:22px;color:${T.accent};font-weight:600;letter-spacing:.01em}

/* ── Format B: typographic loop ── */
.frame{position:relative;width:${w}px;height:${h}px;background:${T.bg};overflow:hidden;
       display:flex;align-items:center;justify-content:center;padding:150px 96px;
       font-family:'Inter',sans-serif;text-align:center}
.ftext{font-size:104px;line-height:1.06;letter-spacing:-.02em;font-weight:800;text-transform:uppercase}
.ftext.serif{font-family:'Instrument Serif',serif;font-weight:400;text-transform:none;
             font-size:112px;letter-spacing:-.01em}
.ftext.mono{font-family:'Inter',sans-serif;font-weight:600;font-size:76px;letter-spacing:.02em}
.floor{position:absolute;left:96px;right:96px;bottom:60px;font-size:20px;color:${T.faint};
       font-weight:500;text-align:center}
`;
}

function glow(r, strong) {
  const a = strong ? 0.13 : pick(r, [0.06, 0.07, 0.08]);
  const b = strong ? 0.09 : pick(r, [0.04, 0.05, 0.06]);
  const [ax, ay] = pick(r, [[-200, -220], [-160, -260], [-240, -180]]);
  const [bx, by] = pick(r, [[-180, -200], [-220, -160], [-140, -240]]);
  return `<div class="glow" style="width:640px;height:640px;background:${T.accent};top:${ay}px;right:${ax}px;opacity:${a}"></div>
          <div class="glow" style="width:520px;height:520px;background:${T.accent2};bottom:${by}px;left:${bx}px;opacity:${b}"></div>`;
}

const foot = (swipe) =>
  `${swipe ? '<div class="swipe">Swipe →</div>' : ''}
   <div class="foot"><span class="brand">glpbodyguard.com</span><div class="legal">${DISCLAIMER}</div></div>`;

/* ─────────────────── FORMAT A / C — slide dispatch ─────────────────── */
function slideHTML(p, idx, total, r) {
  const style = p.layout_style || 'numbered_stack';
  const head = esc(p.headline);
  const sub = esc(p.sub_text);
  const cover = idx === 1;
  const eyebrow = p.eyebrow
    ? esc(p.eyebrow)
    : cover
      ? 'GLP BodyGuard'
      : `${String(idx - 1).padStart(2, '0')} <span class="dim">/ ${String(total - 1).padStart(2, '0')}</span>`;

  let body;
  switch (style) {
    case 'bold_contrarian_center': {
      const parts = head.split(' ');
      const head2 = parts.length > 3
        ? `${parts.slice(0, -2).join(' ')}<br/><span class="accent">${parts.slice(-2).join(' ')}</span>`
        : head;
      body = `<div class="spacer"></div><div class="hero">${head2}</div>
              ${sub ? `<div style="height:40px"></div><div class="split-body">${sub}</div>` : ''}
              <div class="spacer"></div>`;
      break;
    }
    case 'two_column_data_split':
      body = `<div class="spacer"></div><div class="split-rule"></div><div style="height:36px"></div>
              <div class="split-title">${head}</div>
              ${sub ? `<div style="height:32px"></div><div class="split-body">${sub}</div>` : ''}
              <div class="spacer"></div>`;
      break;
    case 'quote_led':
      body = `<div class="spacer"></div><div class="quote">${head}</div>
              ${sub ? `<div style="height:36px"></div><div class="split-body">${sub}</div>` : ''}
              <div class="spacer"></div>`;
      break;
    case 'data_ladder': {
      const rows = String(sub || '').split('|').filter(x => x.trim()).map((l, i) =>
        `<div class="ladder-row"><div class="ladder-key">${String(i + 1).padStart(2, '0')}</div>
         <div class="ladder-val">${l.trim()}</div></div>`).join('');
      body = `<div class="spacer"></div><div class="split-title">${head}</div>
              <div style="height:36px"></div>${rows}<div class="spacer"></div>`;
      break;
    }
    case 'mockup_spotlight': {
      // Format C. screenshot MUST be a real capture — never a mockup, never fake data.
      const f = p.spotlight?.focus_rect;
      const focus = f
        ? `<div class="shot-focus" style="left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%"></div>`
        : '';
      const annos = (p.annotations || []).map(a =>
        `<div class="anno" style="left:${(a.anchor?.x ?? .5) * 100}%;top:${(a.anchor?.y ?? .6) * 100}%;transform:translate(-50%,0)">${esc(a.text)}</div>`
      ).join('');
      body = `<div style="height:28px"></div><div class="split-title">${head}</div>
              <div class="shot-wrap">
                <img class="shot" src="${p.screenshot_data_uri || p.screenshot_url || ''}" />
                ${focus}${annos}
              </div>
              ${sub ? `<div class="split-body">${sub}</div><div style="height:18px"></div>` : ''}
              <div class="guardrail">${esc(p.guardrail_line || "It doesn't diagnose you. It doesn't flag you. It doesn't triage you.")}</div>
              <div style="height:40px"></div>`;
      break;
    }
    case 'close':
      body = `<div class="spacer"></div><div class="hero">${head}</div>
              ${sub ? `<div style="height:36px"></div><div class="split-body">${sub}</div>` : ''}
              <div style="height:52px"></div>
              <div class="send">${esc(p.send_trigger || "Send this to whoever's tracking with you →")}</div>
              <div class="spacer"></div>`;
      break;
    default: // numbered_stack
      body = `<div class="spacer"></div><div class="num">${String(idx - 1).padStart(2, '0')}</div>
              <div style="height:20px"></div><div class="stack-title">${head}</div>
              ${sub ? `<div style="height:32px"></div><div class="stack-body">${sub}</div>` : ''}
              <div class="spacer"></div>`;
  }

  return `<div class="slide">${glow(r, cover)}<div class="pad">
            <div class="eyebrow">${eyebrow}</div>${body}${foot(cover)}
          </div></div>`;
}

/* ─────────────────── FORMAT B — frame rasterization ─────────────────── */
function frameHTML(f) {
  const cls = f.style === 'display_serif' ? 'serif' : f.style === 'mono_data' ? 'mono' : '';
  const color = f.color === 'accent' ? T.accent : T.fg;
  const scale = f.motion === 'push_2pct' ? 'transform:scale(1.02);' : '';
  return `<div class="frame">
            <div class="ftext ${cls}" style="color:${color};${scale}">${esc(f.text)}</div>
            <div class="floor">${DISCLAIMER}</div>
          </div>`;
}

/* ─────────────────────────── BROWSER (reuse) ─────────────────────────── */
let _browser = null;
async function browser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });
  return _browser;
}

async function shoot(html, w, h, scale, selector) {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    // Webfonts MUST land or Instrument Serif silently falls back and the brand breaks.
    await page.evaluateHandle('document.fonts.ready');
    await new Promise(r => setTimeout(r, 600));
    const els = await page.$$(selector);
    const out = [];
    for (const el of els) out.push(await el.screenshot({ type: 'png', encoding: 'base64' }));
    return out;
  } finally {
    await page.close();
  }
}

/* ─────────────────────────── ROUTES ─────────────────────────── */

router.get('/render/health', async (_req, res) => {
  try {
    const b = await browser();
    res.json({ ok: true, chromium: await b.version(), ffmpeg: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/** Format A + C → PNGs */
router.post('/render/deck', async (req, res) => {
  try {
    const spec = req.body || {};
    const slides = spec.data_packets || [];
    if (!slides.length) return res.status(400).json({ error: 'data_packets is empty' });

    const w = spec.canvas?.w ?? 1080;
    const h = spec.canvas?.h ?? 1350;
    const scale = spec.canvas?.scale ?? 2;
    const seed = spec.variance_seed
      ?? parseInt(crypto.createHash('sha1').update(String(spec.content_id ?? 'x')).digest('hex').slice(0, 6), 16);
    const r = rng(seed);

    const body = slides.map((p, i) => slideHTML(p, i + 1, slides.length, r)).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css(w, h)}</style></head><body>${body}</body></html>`;

    const pngs = await shoot(html, w, h, scale, '.slide');
    res.json({
      content_id: spec.content_id,
      format: 'A_or_C',
      slide_count: pngs.length,
      images_b64: pngs,
    });
  } catch (e) {
    console.error('[render/deck]', e);
    res.status(500).json({ error: String(e) });
  }
});

/** Format B → frames → ffmpeg → MP4 */
router.post('/render/loop', async (req, res) => {
  const tmp = path.join(os.tmpdir(), 'loop_' + crypto.randomBytes(6).toString('hex'));
  try {
    const spec = req.body || {};
    const frames = spec.frames || [];
    if (!frames.length) return res.status(400).json({ error: 'frames is empty' });

    const w = spec.canvas?.w ?? 1080;
    const h = spec.canvas?.h ?? 1920;
    const fps = spec.canvas?.fps ?? 30;
    const dur = spec.duration_sec ?? 6.0;

    // HARD RULE: Format B is silent. Reject any attempt to attach a voice track.
    if (spec.audio && spec.audio !== 'silent' && spec.audio !== 'licensed_bed') {
      return res.status(400).json({
        error: 'Format B is silent by design. A repeated synthetic voice is an audio fingerprint ' +
               'and Meta duplicate-detection matches on audio. audio must be "silent" or "licensed_bed".',
      });
    }

    await fs.mkdir(tmp, { recursive: true });

    const body = frames.map(frameHTML).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css(w, h)}</style></head><body>${body}</body></html>`;
    const stills = await shoot(html, w, h, 1, '.frame');

    // Expand each text-state into its held frames at fps.
    let n = 0;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const hold = Math.max(1, Math.round(((f.t_out - f.t_in) || (dur / frames.length)) * fps));
      const buf = Buffer.from(stills[i], 'base64');
      for (let k = 0; k < hold; k++) {
        await fs.writeFile(path.join(tmp, `f_${String(++n).padStart(5, '0')}.png`), buf);
      }
    }

    const mp4 = path.join(tmp, 'loop.mp4');
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y',
        '-framerate', String(fps),
        '-i', path.join(tmp, 'f_%05d.png'),
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-vf', `scale=${w}:${h}`,
        '-movflags', '+faststart',
        mp4,
      ], (err, _so, se) => (err ? reject(new Error(se || err.message)) : resolve()));
    });

    const b64 = (await fs.readFile(mp4)).toString('base64');
    res.json({
      content_id: spec.content_id,
      format: 'B_typographic_loop',
      duration_sec: n / fps,
      frame_count: n,
      loop_closed: spec.loop_closed !== false,
      audio: 'silent',
      video_b64: b64,
    });
  } catch (e) {
    console.error('[render/loop]', e);
    res.status(500).json({ error: String(e) });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

module.exports = router;
