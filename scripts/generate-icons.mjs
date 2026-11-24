import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const ROOT = '/app/applet';
const ICON_SRC = path.join(
  ROOT,
  'public/assets/aistudio/Gemini_Generated_Image_snji2ysnji2ysnji_27c59abb.jpg'
);
const FULL_SRC = path.join(
  ROOT,
  'public/assets/aistudio/Gemini_Generated_Image_vufb2avufb2avufb_80c4839e.jpg'
);

const TMP_DIR = '/tmp/sentra-icon-gen';
fs.mkdirSync(TMP_DIR, { recursive: true });

if (!fs.existsSync(ICON_SRC) || !fs.existsSync(FULL_SRC)) {
  throw new Error('Official Sentra logo source images not found in public/assets/aistudio/');
}

const iconDataUrl = `data:image/jpeg;base64,${fs.readFileSync(ICON_SRC).toString('base64')}`;
const fullDataUrl = `data:image/jpeg;base64,${fs.readFileSync(FULL_SRC).toString('base64')}`;

// Pack array of { size, buffer } into a valid Windows multi-layer .ICO buffer
function packIco(entries) {
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + dirEntrySize * entries.length;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dirBuffers = [];
  const dataBuffers = [];

  for (const { size, buffer } of entries) {
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(size >= 256 ? 0 : size, 0);
    dir.writeUInt8(size >= 256 ? 0 : size, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(buffer.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirBuffers.push(dir);
    dataBuffers.push(buffer);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...dirBuffers, ...dataBuffers]);
}

const sizes = [16, 24, 32, 48, 64, 72, 96, 128, 144, 192, 256, 512];

const htmlContent = `<!doctype html>
<html>
<body style="margin:0;background:transparent;">
<img id="iconSrc" src="${iconDataUrl}" />
<img id="fullSrc" src="${fullDataUrl}" />
<script>
function extractCroppedInkCanvas(img, rgb) {
  const src = document.createElement('canvas');
  src.width = img.naturalWidth;
  src.height = img.naturalHeight;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const imgData = sctx.getImageData(0, 0, src.width, src.height);
  const d = imgData.data;

  let minX = src.width, minY = src.height, maxX = 0, maxY = 0;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const idx = (y * src.width + x) * 4;
      const lum = 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
      // Clean background removal while preserving crisp anti-aliased strokes
      let alpha = 0;
      if (lum < 238) {
        const norm = Math.max(0, Math.min(1, (238 - lum) / 188));
        // Slight contrast curve for razor-sharp black/white logo edges
        alpha = Math.round(Math.min(1, Math.pow(norm, 0.82)) * 255);
      }
      d[idx] = rgb[0];
      d[idx + 1] = rgb[1];
      d[idx + 2] = rgb[2];
      d[idx + 3] = alpha;
      if (alpha > 18) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  sctx.putImageData(imgData, 0, 0);

  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(src.width - 1, maxX + pad);
  maxY = Math.min(src.height - 1, maxY + pad);

  const cw = Math.max(1, maxX - minX + 1);
  const ch = Math.max(1, maxY - minY + 1);
  const cropped = document.createElement('canvas');
  cropped.width = cw;
  cropped.height = ch;
  const cctx = cropped.getContext('2d');
  cctx.drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
  return cropped;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function renderFittedSquare(sourceCanvas, size, fillRatio, bgColor, rounded) {
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (bgColor) {
    ctx.fillStyle = bgColor;
    if (rounded) {
      drawRoundedRect(ctx, 0, 0, size, size, size * 0.22);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, size, size);
    }
  }

  const maxSide = size * fillRatio;
  const scale = Math.min(maxSide / sourceCanvas.width, maxSide / sourceCanvas.height);
  const dw = sourceCanvas.width * scale;
  const dh = sourceCanvas.height * scale;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;
  ctx.drawImage(sourceCanvas, dx, dy, dw, dh);
  return out.toDataURL('image/png').split(',')[1];
}

function renderProportional(sourceCanvas, targetWidth) {
  const scale = targetWidth / sourceCanvas.width;
  const w = Math.round(targetWidth);
  const h = Math.round(sourceCanvas.height * scale);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  return out.toDataURL('image/png').split(',')[1];
}

window.renderAll = async () => {
  const iconImg = document.getElementById('iconSrc');
  const fullImg = document.getElementById('fullSrc');
  if (!iconImg.complete) await new Promise(r => iconImg.onload = r);
  if (!fullImg.complete) await new Promise(r => fullImg.onload = r);

  const iconDark = extractCroppedInkCanvas(iconImg, [11, 18, 32]);    // #0B1220 obsidian
  const iconLight = extractCroppedInkCanvas(iconImg, [248, 250, 252]); // #F8FAFC crisp white
  const fullDark = extractCroppedInkCanvas(fullImg, [11, 18, 32]);
  const fullLight = extractCroppedInkCanvas(fullImg, [248, 250, 252]);

  const sizes = ${JSON.stringify(sizes)};
  const squircles = {};
  for (const sz of sizes) {
    squircles[sz] = renderFittedSquare(iconDark, sz, 0.76, '#FFFFFF', true);
  }

  return {
    squircles,
    androidForeground: renderFittedSquare(iconDark, 192, 0.62, null, false),
    iconDarkTransparent: renderFittedSquare(iconDark, 512, 0.88, null, false),
    iconLightTransparent: renderFittedSquare(iconLight, 512, 0.88, null, false),
    fullDarkTransparent: renderProportional(fullDark, 640),
    fullLightTransparent: renderProportional(fullLight, 640),
    fullCard: renderFittedSquare(fullDark, 512, 0.82, '#FFFFFF', true),
  };
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
const jsonOutPath = path.join(TMP_DIR, 'official-logos.json');

try {
  await execAsync(
    `playwright-cli open "http://127.0.0.1:${port}/" && playwright-cli eval "window.renderAll()" > "${jsonOutPath}.raw"`,
    { timeout: 45000, maxBuffer: 40 * 1024 * 1024 }
  );
} finally {
  try {
    await execAsync('playwright-cli close', { timeout: 10000 });
  } catch {}
  server.close();
}

const rawOutput = fs.readFileSync(`${jsonOutPath}.raw`, 'utf8');
const startIdx = rawOutput.indexOf('{');
const endIdx = rawOutput.lastIndexOf('}');
if (startIdx === -1 || endIdx === -1) {
  throw new Error('Failed to parse rendered logo JSON: ' + rawOutput.slice(0, 400));
}
const result = JSON.parse(rawOutput.slice(startIdx, endIdx + 1));

const sqBuf = (sz) => Buffer.from(result.squircles[String(sz)], 'base64');

// 1. Tauri Windows & Desktop icons
const tauriIconsDir = path.join(ROOT, 'sentra-client/src-tauri/icons');
fs.mkdirSync(tauriIconsDir, { recursive: true });
fs.writeFileSync(path.join(tauriIconsDir, '32x32.png'), sqBuf(32));
fs.writeFileSync(path.join(tauriIconsDir, '128x128.png'), sqBuf(128));
fs.writeFileSync(path.join(tauriIconsDir, '128x128@2x.png'), sqBuf(256));
fs.writeFileSync(path.join(tauriIconsDir, 'icon.png'), sqBuf(512));

// Multi-layer Windows ICO: 16, 24, 32, 48, 64, 256
const icoLayers = [16, 24, 32, 48, 64, 256].map((size) => ({ size, buffer: sqBuf(size) }));
const icoBuffer = packIco(icoLayers);
fs.writeFileSync(path.join(tauriIconsDir, 'icon.ico'), icoBuffer);

// 2. Client transparent & card brand assets
const clientAssetsDir = path.join(ROOT, 'sentra-client/src/assets');
fs.mkdirSync(clientAssetsDir, { recursive: true });
fs.writeFileSync(path.join(clientAssetsDir, 'logo-icon.png'), sqBuf(256));
fs.writeFileSync(path.join(clientAssetsDir, 'logo-icon-dark.png'), Buffer.from(result.iconDarkTransparent, 'base64'));
fs.writeFileSync(path.join(clientAssetsDir, 'logo-icon-light.png'), Buffer.from(result.iconLightTransparent, 'base64'));
fs.writeFileSync(path.join(clientAssetsDir, 'logo-full.png'), Buffer.from(result.fullCard, 'base64'));
fs.writeFileSync(path.join(clientAssetsDir, 'logo-full-dark.png'), Buffer.from(result.fullDarkTransparent, 'base64'));
fs.writeFileSync(path.join(clientAssetsDir, 'logo-full-light.png'), Buffer.from(result.fullLightTransparent, 'base64'));

// 3. Web public favicons
const publicDir = path.join(ROOT, 'sentra-client/public');
fs.mkdirSync(publicDir, { recursive: true });
fs.writeFileSync(path.join(publicDir, 'favicon.png'), sqBuf(64));
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), sqBuf(192));

// 4. Android mipmap launcher icons
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
    fs.writeFileSync(path.join(targetDir, 'ic_launcher.png'), sqBuf(sz));
    fs.writeFileSync(path.join(targetDir, 'ic_launcher_round.png'), sqBuf(sz));
    fs.writeFileSync(path.join(targetDir, 'ic_launcher_foreground.png'), sqBuf(sz));
  }
}

console.log(
  `Generated all official Sentra brand assets & icons! icon.ico=${icoBuffer.length} bytes (${icoLayers.length} layers)`
);
