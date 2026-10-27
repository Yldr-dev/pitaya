// Generates PNG/ICO icons from assets/logo.svg. Run: npm run icons
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'));
const out = (name) => path.join(root, 'assets', name);

async function png(size) {
  return sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
}

(async () => {
  const { default: pngToIco } = await import('png-to-ico');

  fs.writeFileSync(out('icon.png'), await png(512));
  fs.writeFileSync(out('logo-128.png'), await png(128));

  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const icoPngs = await Promise.all(icoSizes.map(png));
  fs.writeFileSync(out('icon.ico'), await pngToIco(icoPngs));

  // Tray icon: same mark, sizes Windows picks from at 100–200% scaling.
  const trayPngs = await Promise.all([16, 20, 24, 32, 40, 48].map(png));
  fs.writeFileSync(out('tray.ico'), await pngToIco(trayPngs));

  console.log('Icons written to assets/');
})();
