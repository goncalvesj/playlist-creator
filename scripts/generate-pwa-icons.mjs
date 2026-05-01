import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const source = resolve(root, 'public', 'favicon.svg');
const outputDir = resolve(root, 'public', 'icons');
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

async function renderIcon(size, fileName) {
  await sharp(source)
    .resize(size, size, {
      fit: 'contain',
      background: transparent,
    })
    .png()
    .toFile(resolve(outputDir, fileName));
}

async function renderMaskableIcon() {
  const size = 512;
  const safeZoneSize = Math.round(size * 0.8);
  const glyph = await sharp(source)
    .resize(safeZoneSize, safeZoneSize, {
      fit: 'contain',
      background: transparent,
    })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: '#000000',
    },
  })
    .composite([{ input: glyph, gravity: 'center' }])
    .png()
    .toFile(resolve(outputDir, 'icon-maskable-512.png'));
}

await mkdir(outputDir, { recursive: true });
await renderIcon(192, 'icon-192.png');
await renderIcon(512, 'icon-512.png');
await renderMaskableIcon();
