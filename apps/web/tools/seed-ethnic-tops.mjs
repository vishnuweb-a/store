/**
 * Seeds the Women's Wear collection from a folder of ethnic-top subfolders,
 * uploading one representative image per subfolder to Cloudinary first.
 *
 * Each immediate subfolder is one product. Product fields are derived from the
 * folder name (brand, garment, neckline, work, fabric, colour) — nothing that
 * cannot be read off the folder name is invented. Prices are placeholders in the
 * same INR band as the existing catalogue; edit them in /admin.
 *
 *   node tools/seed-ethnic-tops.mjs <folders-dir> --dry   preview, writes nothing
 *   node tools/seed-ethnic-tops.mjs <folders-dir>         upload and insert
 *
 * Re-running is safe: products already present (matched on SKU) are skipped, so
 * no duplicate row and no duplicate Cloudinary upload is created.
 *
 * Requires products.category (see supabase-schema.sql). Credentials are read
 * from apps/web/.env (VITE_*), falling back to the process environment.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const IMAGES_DIR = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || 'ethnic-tops');

// Storefront collection slug every product seeded by this script belongs to.
const CATEGORY = 'womens';
// The shirt catalogue seeded by seed-products.mjs occupies FRV-XXX-001..017, so
// this run continues the shared SKU sequence rather than colliding with it.
const SKU_SEQUENCE_START = 18;

const parseEnvFile = (file) =>
  existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
          .map((line) => {
            const i = line.indexOf('=');
            return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
          }),
      )
    : {};

const env = { ...parseEnvFile(path.join(WEB_ROOT, '.env')), ...process.env };

const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
const CLOUD_NAME = env.VITE_CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME;
const UPLOAD_PRESET = env.VITE_CLOUDINARY_UPLOAD_PRESET || 'frontiva_unsigned';

if (!SUPABASE_URL || !SUPABASE_KEY || !CLOUD_NAME) {
  console.error('Missing Supabase/Cloudinary config. Set them in apps/web/.env');
  process.exit(1);
}

if (!existsSync(IMAGES_DIR)) {
  console.error(`Images folder not found: ${IMAGES_DIR}`);
  process.exit(1);
}

// Brand slug -> display name and price tier (base price in INR). Matched
// longest-slug-first so "anouk-rustic" wins over "anouk".
const BRANDS = [
  ['jahida-comfort-with-style', 'Jahida', 1099],
  ['fusion-by-glitchez', 'Fusion by Glitchez', 1299],
  ['classy-creation', 'Classy Creation', 999],
  ['nakshkurtis', 'NakshKurtis', 1199],
  ['anouk-rustic', 'Anouk Rustic', 1699],
  ['pixie-lane', 'Pixie Lane', 1399],
  ['mythdrip', 'Mythdrip', 1499],
  ['youthnic', 'Youthnic', 1099],
  ['glitchez', 'Glitchez', 1399],
  ['janasya', 'Janasya', 1599],
  ['sangria', 'Sangria', 1899],
  ['vishudh', 'Vishudh', 1499],
  ['aaghnya', 'Aaghnya', 1099],
  ['anouk', 'Anouk', 1799],
  ['aarsi', 'Aarsi', 1199],
  ['ozia', 'Ozia', 1299],
].sort((a, b) => b[0].length - a[0].length);

// Longest-first so "off-white" beats "white" and "navy-blue" beats "blue".
const COLORS = [
  ['navy-blue', 'Navy Blue'],
  ['off-white', 'Off White'],
  ['magenta', 'Magenta'],
  ['maroon', 'Maroon'],
  ['orange', 'Orange'],
  ['purple', 'Purple'],
  ['black', 'Black'],
  ['white', 'White'],
  ['pink', 'Pink'],
  ['rust', 'Rust'],
  ['red', 'Red'],
];

// Garment type, neckline and surface design, all read off the folder name.
const GARMENTS = [
  [/crop-top/, 'Crop Top'],
  [/kurtis?/, 'Kurti'],
  [/tunic/, 'Tunic'],
  [/\btop\b/, 'Top'],
];

const NECKLINES = [
  [/mandarin-collar/, 'Mandarin Collar'],
  [/flared-collar/, 'Flared Collar'],
  [/square-neck/, 'Square Neck'],
  [/round-neck/, 'Round Neck'],
  [/v-neck/, 'V-Neck'],
];

const DESIGNS = [
  [/polka-dot/, 'Polka Dot Printed'],
  [/woven-design/, 'Woven Design'],
  [/embroidered/, 'Embroidered'],
  [/thread-work/, 'Thread Work'],
  [/paisley/, 'Paisley Printed'],
  [/floral/, 'Floral'],
  [/ethnic-motifs/, 'Ethnic Motifs'],
  [/printed/, 'Printed'],
];

// Only fabrics actually named in the folder are stated on the product.
const FABRICS = [
  [/viscose-rayon/, 'Viscose Rayon'],
  [/pure-cotton/, 'Pure Cotton'],
];

const FILLERS = new Set(['women', 's', 'the', 'co', 'by', 'with', 'style', 'front', 'back']);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const firstMatch = (table, text) => (table.find(([re]) => re.test(text)) || [])[1] || null;

/**
 * Picks the single image that best represents the garment: an explicit "-front"
 * shot, else the folder's primary image, else the lowest-numbered gallery shot.
 *
 * @param {string} dir - Absolute path to the subfolder
 * @param {string} folderName
 * @returns {string|null} File name, or null when the folder holds no images
 */
function selectImage(dir, folderName) {
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  if (files.length === 0) return null;

  const front = files.find((f) => /-front\.(jpe?g|png|webp)$/i.test(f));
  if (front) return front;

  const primary = files.find((f) => f.replace(/\.[^.]+$/, '') === folderName);
  if (primary) return primary;

  const numbered = files
    .filter((f) => /-(\d+)\.[^.]+$/.test(f))
    .sort((a, b) => Number(a.match(/-(\d+)\.[^.]+$/)[1]) - Number(b.match(/-(\d+)\.[^.]+$/)[1]));

  return numbered[0] || files.sort()[0];
}

function parseFolder(folderName, index) {
  const brand = BRANDS.find(([b]) => folderName.startsWith(b));
  if (!brand) throw new Error(`Unknown brand for ${folderName}`);
  const [brandSlug, brandName, basePrice] = brand;

  // Folder names repeat the brand ("sangria-sangria-..."); strip every leading
  // brand/filler token, the same way the shirt seeder does.
  let tokens = folderName.split('-');
  const brandTokens = brandSlug.split('-');
  let i = 0;
  while (i < tokens.length) {
    if (brandTokens.every((t, k) => tokens[i + k] === t)) {
      i += brandTokens.length;
    } else if (FILLERS.has(tokens[i])) {
      i += 1;
    } else {
      break;
    }
  }
  tokens = tokens.slice(i).filter((t) => !/^\d+$/.test(t));

  const rest = tokens.join('-');

  const matched = COLORS.filter(([c]) => rest.includes(c));
  // A colour name can contain another ("off-white" contains "white"); keep the
  // longest match only, and preserve folder order for multi-colour garments.
  const colors = matched
    .filter(([c]) => !matched.some(([o]) => o !== c && o.includes(c)))
    .sort((a, b) => rest.indexOf(a[0]) - rest.indexOf(b[0]));
  const colorName = colors.length ? colors.map(([, name]) => name).join(' & ') : 'Assorted';
  const colorTokens = new Set(colors.flatMap(([c]) => c.split('-')));

  const garment = firstMatch(GARMENTS, rest) || 'Ethnic Top';
  const neckline = firstMatch(NECKLINES, rest);
  const design = firstMatch(DESIGNS, rest) || 'Ethnic';
  const fabric = firstMatch(FABRICS, rest);

  // Drop colour and filler tokens, then make sure the title names the garment.
  let descriptor = titleCase(
    tokens.filter((t) => !colorTokens.has(t) && !FILLERS.has(t)).join(' '),
  )
    .replace(/\bV Neck\b/g, 'V-Neck')
    .replace(/\bA Line\b/g, 'A-Line')
    .replace(/\s+/g, ' ')
    .trim();

  // Several source folder names are truncated mid-phrase, which both repeats a
  // phrase ("thread-work-...-thread-work") and leaves a dangling qualifier at
  // the end ("...-flared-sleeves-pure"). Keep each word's first occurrence and
  // drop the dangling tail so the title reads whole.
  descriptor = descriptor
    .split(' ')
    .filter((word, w, all) => all.indexOf(word) === w)
    .join(' ')
    .replace(/\s+\b(Pure|Flared|Short|Straight)$/, '')
    .trim();
  if (!new RegExp(`${garment}s?$`, 'i').test(descriptor)) {
    descriptor = `${descriptor} ${garment}`.trim();
  }
  descriptor = descriptor.replace(/\bKurtis$/, 'Kurti');

  const title = `${brandName} ${descriptor}`.replace(/\s+/g, ' ').trim();
  const subtitle = [neckline, design, `Women's ${garment}`].filter(Boolean).join(' ');

  // Deterministic per-index variation so reseeding gives the same catalogue.
  const price = basePrice + (index % 4) * 100;
  const hasDiscount = index % 3 !== 0;
  const discount_price = hasDiscount ? Math.round((price * (0.6 + (index % 3) * 0.05)) / 10) * 10 : null;
  const ribbon = index % 5 === 0 ? 'New' : hasDiscount && index % 4 === 1 ? 'Bestseller' : null;

  const sizes = ['S', 'M', 'L', 'XL', 'XXL'].map((size, s) => ({
    size,
    stock: [4, 7, 9, 5, 2][(index + s) % 5],
  }));

  const specs = [
    `<li>Garment: ${garment}</li>`,
    neckline ? `<li>Neckline: ${neckline}</li>` : '',
    `<li>Design: ${design}</li>`,
    `<li>Colour: ${colorName}</li>`,
    fabric ? `<li>Fabric: ${fabric}</li>` : '',
  ]
    .filter(Boolean)
    .join('');

  const description =
    `<p>${title} in ${colorName.toLowerCase()}. A versatile ethnic ${garment.toLowerCase()} ` +
    `featuring a comfortable silhouette${neckline ? ` and a ${neckline.toLowerCase()}` : ''}, ` +
    `finished with ${design.toLowerCase()} detailing — suitable for casual and festive styling.</p>` +
    `<ul>${specs}</ul>`;

  return {
    folderName,
    title,
    subtitle,
    description,
    ribbon,
    price,
    discount_price,
    sku: `FRV-${brandSlug.split('-')[0].slice(0, 3).toUpperCase()}-${String(index + SKU_SEQUENCE_START).padStart(3, '0')}`,
    weight: 0.25 + ((index % 4) * 0.05),
    track_quantity: true,
    stock: 0,
    sizes,
    category: CATEGORY,
    active: true,
  };
}

async function uploadToCloudinary(filePath) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)]), path.basename(filePath));
  form.append('upload_preset', UPLOAD_PRESET);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Cloudinary ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { image_url: data.secure_url, cloudinary_public_id: data.public_id };
}

async function fetchExistingSkus() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/products?select=sku`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return new Set((await res.json()).map((row) => row.sku).filter(Boolean));
}

async function insertProducts(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/products`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

const folders = readdirSync(IMAGES_DIR)
  .filter((name) => statSync(path.join(IMAGES_DIR, name)).isDirectory())
  .sort();

const parsed = [];
const skipped = [];

for (const [index, folderName] of folders.entries()) {
  const fileName = selectImage(path.join(IMAGES_DIR, folderName), folderName);
  if (!fileName) {
    skipped.push(`${folderName} (no images)`);
    continue;
  }
  parsed.push({ ...parseFolder(folderName, index), fileName });
}

const duplicateSkus = parsed
  .map((p) => p.sku)
  .filter((sku, i, all) => all.indexOf(sku) !== i);
if (duplicateSkus.length > 0) {
  console.error(`Duplicate SKUs generated: ${[...new Set(duplicateSkus)].join(', ')}`);
  process.exit(1);
}

if (DRY) {
  for (const p of parsed) {
    console.log(
      `${p.sku} | ${p.title}\n    ${p.subtitle} | ₹${p.price}` +
        `${p.discount_price ? ` -> ₹${p.discount_price}` : ''}${p.ribbon ? ` | ${p.ribbon}` : ''}` +
        ` | ${p.category}\n    image: ${p.fileName}`,
    );
  }
  for (const note of skipped) console.log(`skipped ${note}`);
  console.log(`\n${parsed.length} products parsed (dry run, nothing uploaded).`);
} else {
  const existing = await fetchExistingSkus();
  const pending = parsed.filter((p) => !existing.has(p.sku));

  for (const p of parsed) {
    if (existing.has(p.sku)) console.log(`skipped ${p.sku} (already in Supabase)`);
  }

  if (pending.length === 0) {
    console.log('\nNothing to insert — every product already exists.');
  } else {
    const rows = [];
    for (const p of pending) {
      const image = await uploadToCloudinary(path.join(IMAGES_DIR, p.folderName, p.fileName));
      const { folderName, fileName, ...rest } = p;
      rows.push({ ...rest, ...image });
      console.log(`uploaded ${p.sku} ${p.title}`);
    }
    const inserted = await insertProducts(rows);
    console.log(`\nInserted ${inserted.length} products into Supabase (category: ${CATEGORY}).`);
  }
  for (const note of skipped) console.log(`skipped ${note}`);
}
