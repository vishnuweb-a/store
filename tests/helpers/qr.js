/** Shared by the PayIn suites: QR rendering exactly as the success page does it. */
import jsQR from 'jsqr';
import { QRCodeSVG } from 'qrcode.react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Renders the same QRCodeSVG props the success page uses, rasterises the SVG and decodes it like a scanner would. */
export function decodeRenderedQr(value, { scale = 6 } = {}) {
  const svg = renderToStaticMarkup(
    createElement(QRCodeSVG, { value, size: 320, level: 'M', marginSize: 4, bgColor: '#ffffff', fgColor: '#000000' }),
  );
  const cells = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
  const dark = svg.split('<path')[2];
  const side = cells * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);

  for (const [, x, y, w] of dark.matchAll(/M(\d+)[ ,](\d+) ?h(\d+)v1H\d+z/g)) {
    for (let row = 0; row < scale; row += 1) {
      for (let col = 0; col < Number(w) * scale; col += 1) {
        const at = ((Number(y) * scale + row) * side + Number(x) * scale + col) * 4;
        pixels[at] = 0;
        pixels[at + 1] = 0;
        pixels[at + 2] = 0;
      }
    }
  }

  return jsQR(pixels, side, side);
}
