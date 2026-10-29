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

const BG = [0x0f, 0x11, 0x15];
const INK = [0xf5, 0xf2, 0xe8];
const GOLD = [0xff, 0xd2, 0x3f];

/** Shapes in a 512-unit design space. Later shapes paint over earlier ones. */
function shapes(maskable) {
  // Maskable icons keep content inside the central 80% safe zone and fill the whole square.
  const s = maskable ? 0.78 : 1;
  const o = (512 - 512 * s) / 2;
  const t = (v) => o + v * s;
  return [
    maskable ? { kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: 0, color: BG } : { kind: 'rect', x: 0, y: 0, w: 512, h: 512, r: 112, color: BG },
    { kind: 'rect', x: t(96), y: t(214), w: 320 * s, h: 44 * s, r: 22 * s, color: INK },
    { kind: 'rect', x: t(96), y: t(290), w: 220 * s, h: 44 * s, r: 22 * s, color: GOLD },
    { kind: 'circle', cx: t(370), cy: t(312), r: 22 * s, color: GOLD },
  ];
}

function inside(shape, x, y) {
  if (shape.kind === 'circle') return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
  const { x: rx, y: ry, w, h, r } = shape;
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
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
console.log(`icons written to ${out}`);
