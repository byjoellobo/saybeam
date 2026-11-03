#!/usr/bin/env node
/**
 * Renders the PWA icons (same design as public/icons/icon.svg) to PNG with no
 * native dependencies: a tiny rasteriser with 4x supersampling and a minimal
 * PNG encoder on top of node:zlib.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(out, { recursive: true });

const INK = [0x16, 0x16, 0x16];
const BEAM = [0xff, 0xd4, 0x3b];
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * The Saybeam mark in a 512-unit design space: a beam-yellow speech bubble
 * holding two caption lines and a text cursor. Later shapes paint over earlier ones.
 */
function shapes(maskable) {
  // Maskable icons fill the whole square and keep the mark inside the central safe circle.
  const s = maskable ? 0.86 : 1;
  const o = (512 - 512 * s) / 2;
  const t = (v) => o + v * s;
  const rect = (x, y, w, h, r, color) => ({ kind: 'rect', x: t(x), y: t(y), w: w * s, h: h * s, r: r * s, color });
  return [
    maskable ? { kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: 0, color: INK } : { kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: 112, color: INK },
    rect(88, 100, 336, 244, 64, BEAM),
    {
      kind: 'poly',
      points: [
        [140, 316],
        [140, 420],
        [252, 316],
      ].map(([x, y]) => [t(x), t(y)]),
      color: BEAM,
    },
    rect(144, 162, 224, 42, 21, INK),
    rect(144, 238, 128, 42, 21, INK),
    rect(294, 226, 22, 66, 8, INK),
  ];
}

function inside(shape, x, y) {
  if (shape.kind === 'circle') return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
  if (shape.kind === 'poly') {
    // Even-odd ray casting.
    let hit = false;
    const p = shape.points;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i];
      const [xj, yj] = p[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  const { x: rx, y: ry, w, h, r } = shape;
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const NL = String.fromCharCode(10);

/** The same shapes as SVG, so public/icons/icon.svg can never drift from the PNGs. */
function svg() {
  const body = shapes(false)
    .map((sh) =>
      sh.kind === 'poly'
        ? `  <polygon points="${sh.points.map((pt) => pt.join(',')).join(' ')}" fill="${hex(sh.color)}"/>`
        : `  <rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" rx="${sh.r}" fill="${hex(sh.color)}"/>`,
    )
    .join(NL);
  return ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Saybeam">', body, '</svg>', ''].join(NL);
}

function render(size, maskable) {
  const ss = 4;
  const list = shapes(maskable);
  const px = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((pxl + (sx + 0.5) / ss) / size) * 512;
          const y = ((py + (sy + 0.5) / ss) / size) * 512;
          let color = null;
          for (const shape of list) if (inside(shape, x, y)) color = shape.color;
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }
      const n = ss * ss;
      const i = (py * size + pxl) * 4;
      const alpha = a / n;
      // Store straight (non-premultiplied) colour.
      px[i] = alpha ? Math.round((r / n) * (255 / alpha)) : 0;
      px[i + 1] = alpha ? Math.round((g / n) * (255 / alpha)) : 0;
      px[i + 2] = alpha ? Math.round((b / n) * (255 / alpha)) : 0;
      px[i + 3] = Math.round(alpha);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  writeFileSync(join(out, name), png(size, render(size, maskable)));
}
writeFileSync(join(out, 'icon.svg'), svg());
console.log(`icons written to ${out}`);
