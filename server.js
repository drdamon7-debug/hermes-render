// Hermes Render Service — self-hosted ffmpeg assembler for the v2 long-form hybrid.
// POST /render -> returns an assembled MP4 (video/mp4)
const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json({ limit: '64mb' }));
const TOKEN = process.env.RENDER_TOKEN || '';

function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(err) : reject(new Error(cmd + ' exited ' + code + '\n' + err.slice(-4000))));
  });
}
async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('download ' + r.status + ' for ' + url);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}
async function ffprobeDuration(file) {
  const out = await new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', file]);
    let s = ''; p.stdout.on('data', d => s += d); p.on('close', () => resolve(s)); p.on('error', reject);
  });
  const d = parseFloat(String(out).trim());
  return isFinite(d) && d > 0 ? d : 0;
}

app.get('/', (_q, r) => r.json({ ok: true, service: 'hermes-render', ffmpeg: true }));
app.get('/health', (_q, r) => r.json({ ok: true }));

app.post('/render', async (req, res) => {
  if (TOKEN) {
    if ((req.headers.authorization || '') !== 'Bearer ' + TOKEN) return res.status(401).json({ error: 'unauthorized' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-' + randomUUID() + '-'));
  try {
    const b = req.body || {};
    const W = b.width || 1280, H = b.height || 720, FPS = b.fps || 30;
    const bg = (b.bg || '#0B0B0B').replace('#', '0x');
    const accent = b.accent === '' ? '' : (b.accent || '#16D6C6').replace('#', '0x');

    const audioPath = path.join(dir, 'audio.mp3');
    if (b.audioBase64) fs.writeFileSync(audioPath, Buffer.from(b.audioBase64, 'base64'));
    else if (b.audioUrl) await download(b.audioUrl, audioPath);
    else throw new Error('audioUrl or audioBase64 required');
    const dur = await ffprobeDuration(audioPath);
    if (!dur) throw new Error('could not read audio duration');

    const clips = Array.isArray(b.clips) ? b.clips : [];
    const clipPaths = [];
    for (let i = 0; i < clips.length; i++) clipPaths.push(await download(clips[i].url, path.join(dir, 'clip' + i + '.mp4')));

    const args = ['-y'];
    args.push('-f','lavfi','-i', 'color=c=' + bg + ':s=' + W + 'x' + H + ':r=' + FPS + ':d=' + dur.toFixed(3));
    args.push('-i', audioPath);
    clipPaths.forEach(cp => args.push('-i', cp));

    const fc = [];
    if (accent) {
      const barH = Math.max(4, Math.round(H * 0.012));
      fc.push('[0:v]drawbox=x=0:y=' + (H - barH) + ':w=' + W + ':h=' + barH + ':color=' + accent + '@1.0:t=fill[bg]');
    } else fc.push('[0:v]null[bg]');
    let last = '[bg]';
    clips.forEach((c, i) => {
      const inIdx = 2 + i;
      const at = Number(c.atSec || 0), d = Number(c.durSec || 4);
      fc.push('[' + inIdx + ':v]scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,crop=' + W + ':' + H + ',fps=' + FPS + ',setpts=PTS-STARTPTS+' + at + '/TB[c' + i + ']');
      const out = (i === clips.length - 1) ? '[vout]' : '[v' + i + ']';
      fc.push(last + '[c' + i + "]overlay=enable='between(t," + at + ',' + (at + d).toFixed(3) + ")':eof_action=pass" + out);
      last = out;
    });
    if (clips.length === 0) fc.push(last + 'null[vout]');

    args.push('-filter_complex', fc.join(';'));
    args.push('-map','[vout]','-map','1:a');
    args.push('-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-r', String(FPS));
    args.push('-c:a','aac','-b:a','192k','-shortest','-movflags','+faststart');
    const outPath = path.join(dir, 'out.mp4');
    args.push(outPath);

    await sh('ffmpeg', args);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="hermes.mp4"');
    fs.createReadStream(outPath).on('close', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }).pipe(res);
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    console.error('render error:', e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('hermes-render listening on ' + PORT));
