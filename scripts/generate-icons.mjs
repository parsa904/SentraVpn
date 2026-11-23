import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = '/app/applet';
const TMP_DIR = '/tmp/sentra-icon-gen';
fs.mkdirSync(TMP_DIR, { recursive: true });

// Crisp geometric Sentra S-bridge emblem filling ~78% of a white squircle (22% corner radius)
function buildIconSvg(size, rounded = true) {
  const rx = rounded ? Math.round(size * 0.22) : 0;
  // Slightly thicken stroke at very small sizes (16/24px) for Hiddify-level taskbar legibility
  const strokeScale = size <= 24 ? 1.18 : size <= 32 ? 1.08 : 1.0;
  const sWidth = (11.5 * strokeScale).toFixed(2);
  const archWidth = (8.8 * strokeScale).toFixed(2);
  const pillWidth = (6.8 * strokeScale).toFixed(2);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="sentraInk" x1="12%" y1="8%" x2="88%" y2="92%">
      <stop offset="0%" stop-color="#0B0F19"/>
      <stop offset="55%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#090D16"/>
    </linearGradient>
    <linearGradient id="bridgeAccent" x1="0%" y1="50%" x2="100%" y2="50%">
      <stop offset="0%" stop-color="#0F172A"/>
      <stop offset="50%" stop-color="#10B981"/>
      <stop offset="100%" stop-color="#0F172A"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="100" height="100" rx="${rounded ? 22 : 0}" ry="${rounded ? 22 : 0}" fill="#FFFFFF"/>
  <!-- Sentra emblem scaled to ~78% canvas fill (x: 11..89, y: 11..89) -->
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <!-- Sweeping Emerald-Obsidian Suspension Bridge Arch behind S -->
    <path d="M 12 63 Q 50 37 88 63" stroke="url(#bridgeAccent)" stroke-width="${archWidth}" />
    <!-- Subtle lower bridge horizon line -->
    <path d="M 16 74 Q 50 66 84 74" stroke="#10B981" stroke-opacity="0.32" stroke-width="${(Number(pillWidth) * 0.72).toFixed(2)}" />
    <!-- Crisp white separation knockout behind the S curve -->
    <path d="M 71 23 C 62 12, 33 12, 27 26 C 21 40, 44 45, 53 49 C 65 54, 78 60, 71 75 C 64 88, 35 88, 25 77"
          stroke="#FFFFFF" stroke-width="${(Number(sWidth) + 6.0).toFixed(2)}" />
    <!-- Iconic Sentra Geometric S Ribbon -->
    <path d="M 71 23 C 62 12, 33 12, 27 26 C 21 40, 44 45, 53 49 C 65 54, 78 60, 71 75 C 64 88, 35 88, 25 77"
          stroke="url(#sentraInk)" stroke-width="${sWidth}" />
  </g>
</svg>`;
}

// Pack array of { size, pngBuffer } into a valid Windows multi-layer .ICO buffer (PNG-compressed entries)
function packIco(entries) {
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + dirEntrySize * entries.length;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type: 1 = ICO
  header.writeUInt16LE(entries.length, 4);

  const dirBuffers = [];
  const dataBuffers = [];

  for (const { size, buffer } of entries) {
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(size >= 256 ? 0 : size, 0); // Width (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, 1); // Height (0 means 256)
    dir.writeUInt8(0, 2); // Color palette
    dir.writeUInt8(0, 3); // Reserved
    dir.writeUInt16LE(1, 4); // Color planes
    dir.writeUInt16LE(32, 6); // Bits per pixel
    dir.writeUInt32LE(buffer.length, 8); // Image data size
    dir.writeUInt32LE(offset, 12); // Offset
    dirBuffers.push(dir);
    dataBuffers.push(buffer);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...dirBuffers, ...dataBuffers]);
}

// Render PNGs using Playwright via a tiny HTML canvas page
const sizes = [16, 24, 32, 48, 64, 72, 96, 128, 144, 192, 256, 512];
const htmlItems = sizes.map((sz) => {
  const svg = buildIconSvg(sz, true);
  const b64 = Buffer.from(svg, 'utf8').toString('base64');
  return `<img id="img_${sz}" width="${sz}" height="${sz}" src="data:image/svg+xml;base64,${b64}" />`;
}).join('\n');

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
const execAsync = promisify(exec);

const htmlContent = `<!doctype html>
<html>
<body style="margin:0;background:transparent;">
${htmlItems}
<script>
window.renderAll = async () => {
  const sizes = ${JSON.stringify(sizes)};
  const out = {};
  for (const sz of sizes) {
    const img = document.getElementById('img_' + sz);
    if (!img.complete) await new Promise(r => img.onload = r);
    const canvas = document.createElement('canvas');
    canvas.width = sz;
    canvas.height = sz;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, sz, sz);
    out[sz] = canvas.toDataURL('image/png').split(',')[1];
  }
  return out;
};
</script>
</body>
</html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlContent);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const jsonOutPath = path.join(TMP_DIR, 'pngs.json');

try {
  await execAsync(
    `playwright-cli open "http://127.0.0.1:${port}/" && playwright-cli eval "window.renderAll()" > "${jsonOutPath}.raw"`,
    { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }
  );
} finally {
  try { await execAsync('playwright-cli close', { timeout: 10000 }); } catch {}
  server.close();
}

const rawOutput = fs.readFileSync(`${jsonOutPath}.raw`, 'utf8');
// Extract JSON object from playwright-cli eval output
const startIdx = rawOutput.indexOf('{');
const endIdx = rawOutput.lastIndexOf('}');
if (startIdx === -1 || endIdx === -1) {
  throw new Error('Failed to parse rendered PNG JSON from playwright-cli: ' + rawOutput.slice(0, 400));
}
const pngMap = JSON.parse(rawOutput.slice(startIdx, endIdx + 1));

const buf = (sz) => Buffer.from(pngMap[String(sz)], 'base64');

// 1. Tauri Windows & Desktop icons
const tauriIconsDir = path.join(ROOT, 'sentra-client/src-tauri/icons');
fs.mkdirSync(tauriIconsDir, { recursive: true });
fs.writeFileSync(path.join(tauriIconsDir, '32x32.png'), buf(32));
fs.writeFileSync(path.join(tauriIconsDir, '128x128.png'), buf(128));
fs.writeFileSync(path.join(tauriIconsDir, '128x128@2x.png'), buf(256));
fs.writeFileSync(path.join(tauriIconsDir, 'icon.png'), buf(512));

// Multi-layer Windows ICO: 16, 24, 32, 48, 64, 256
const icoLayers = [16, 24, 32, 48, 64, 256].map((size) => ({ size, buffer: buf(size) }));
const icoBuffer = packIco(icoLayers);
fs.writeFileSync(path.join(tauriIconsDir, 'icon.ico'), icoBuffer);

// 2. Client asset icon & favicon
fs.writeFileSync(path.join(ROOT, 'sentra-client/src/assets/logo-icon.png'), buf(256));
const publicDir = path.join(ROOT, 'sentra-client/public');
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, 'favicon.png'), buf(64));
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), buf(192));

// 3. Android mipmap launcher icons
const androidRes = path.join(ROOT, 'sentra-client/src-tauri/gen/android/app/src/main/res');
const mipmapSizes = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
];
for (const [folder, sz] of mipmapSizes) {
  const targetDir = path.join(androidRes, folder);
  if (fs.existsSync(targetDir)) {
    fs.writeFileSync(path.join(targetDir, 'ic_launcher.png'), buf(sz));
    fs.writeFileSync(path.join(targetDir, 'ic_launcher_round.png'), buf(sz));
    fs.writeFileSync(path.join(targetDir, 'ic_launcher_foreground.png'), buf(sz));
  }
}

console.log(`Generated crisp Sentra icons successfully! icon.ico size: ${icoBuffer.length} bytes (${icoLayers.length} layers: ${icoLayers.map(l => l.size).join(',')})`);
