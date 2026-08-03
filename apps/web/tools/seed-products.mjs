/**
 * Seeds Supabase products from a folder of garment images, uploading each image
 * to Cloudinary first. Product fields are derived from the image filenames
 * (brand, fit, pattern, colour); prices are placeholders — edit them in /admin.
 *
 *   node tools/seed-products.mjs <images-dir> --dry   preview, writes nothing
 *   node tools/seed-products.mjs <images-dir>         upload and insert
 *
 * Credentials are read from apps/web/.env (VITE_*), falling back to the
 * process environment. Nothing is hardcoded.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const IMAGES_DIR = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || 'clothes');

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

// Brand slug -> display name and price tier (base price in INR).
const BRANDS = [
  ['mischief-monkey', 'Mischief Monkey', 1799],
  ['rink-enterprise', 'Rink Enterprise', 1099],
  ['mast-harbour', 'Mast & Harbour', 1999],
  ['here-now', 'HERE&NOW', 1299],
  ['highlander', 'Highlander', 1199],
  ['roadster', 'Roadster', 1499],
  ['vestirio', 'Vestirio', 1399],
  ['cahoot', 'Cahoot', 1699],
  ['wrogn', 'WROGN', 2199],
  ['zombom', 'Zombom', 999],
];

const COLORS = [
  ['off-white', 'Off White'],
  ['navy-blue', 'Navy Blue'],
  ['lavender', 'Lavender'],
  ['multi', 'Multicolour'],
  ['brown', 'Brown'],
  ['green', 'Green'],
  ['white', 'White'],
  ['blue', 'Blue'],
];

const FILLERS = new Set(['men', 'the', 'co', 'life', 'lifestyle', 'front', 'back']);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function parseFile(fileName, index) {
  const slug = fileName.replace(/\.jpg$/i, '');
  const brand = BRANDS.find(([b]) => slug.startsWith(b));
  if (!brand) throw new Error(`Unknown brand for ${fileName}`);
  const [brandSlug, brandName, basePrice] = brand;

  // Filenames repeat the brand ("cahoot-cahoot-men-..."), sometimes with filler
  // words in between. Strip every leading brand/filler token.
  let tokens = slug.split('-');
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
  tokens = tokens.slice(i).filter((t) => !/^\d+$/.test(t) && !FILLERS.has(t));

  const rest = tokens.join('-');
  // A garment can name two colours ("blue-white"); keep them in filename order.
  const found = COLORS.filter(([c]) => rest.includes(c)).sort(
    (a, b) => rest.indexOf(a[0]) - rest.indexOf(b[0]),
  );
  const matched = found.filter(([c], i) => !found.some(([o], j) => j !== i && o.includes(c) && o !== c));
  const colorName = matched.length ? matched.map(([, name]) => name).join(' & ') : 'Assorted';
  const colorTokens = new Set(matched.flatMap(([c]) => c.split('-')));

  let descriptor = titleCase(tokens.filter((t) => !colorTokens.has(t)).join(' ')).trim();
  // Some source filenames are truncated mid-phrase; make the title read whole.
  if (/\bLong$/.test(descriptor)) descriptor += ' Sleeve';
  if (!/Shirts?$/.test(descriptor)) descriptor += ' Casual Shirt';

  const fit = /slim/.test(rest) ? 'Slim Fit'
    : /tailored/.test(rest) ? 'Tailored Fit'
    : /standard/.test(rest) ? 'Standard Fit'
    : /comfort/.test(rest) ? 'Comfort Fit'
    : 'Regular Fit';
  const pattern = /checked|checks/.test(rest) ? 'Checked'
    : /striped/.test(rest) ? 'Striped'
    : /printed/.test(rest) ? 'Printed'
    : /solid/.test(rest) ? 'Solid'
    : /ombre|faded/.test(rest) ? 'Ombre Dyed'
    : 'Textured';

  const title = `${brandName} ${descriptor}`.replace(/\s+/g, ' ').trim();

  // Deterministic per-index variation so reseeding gives the same catalogue.
  const price = basePrice + (index % 4) * 100;
  const hasDiscount = index % 3 !== 0;
  const discount_price = hasDiscount ? Math.round((price * (0.6 + (index % 3) * 0.05)) / 10) * 10 : null;
  const ribbon = index % 5 === 0 ? 'New' : hasDiscount && index % 4 === 1 ? 'Bestseller' : null;

  const sizes = ['S', 'M', 'L', 'XL', 'XXL'].map((size, s) => ({
    size,
    stock: [4, 7, 9, 5, 2][(index + s) % 5],
  }));

  const description =
    `<p>${title} in ${colorName.toLowerCase()}. A ${fit.toLowerCase()} ${pattern.toLowerCase()} ` +
    `casual shirt cut from breathable cotton-blend fabric, finished with a classic collar and ` +
    `full sleeves — easy to dress up or down.</p>` +
    `<ul><li>Fit: ${fit}</li><li>Pattern: ${pattern}</li><li>Colour: ${colorName}</li>` +
    `<li>Fabric: Cotton blend</li><li>Care: Machine wash cold</li></ul>`;

  return {
    fileName,
    title,
    subtitle: `${fit} ${pattern} Casual Shirt`,
    description,
    ribbon,
    price,
    discount_price,
    sku: `FRV-${brandSlug.split('-')[0].slice(0, 3).toUpperCase()}-${String(index + 1).padStart(3, '0')}`,
    weight: 0.3 + ((index % 4) * 0.05),
    track_quantity: true,
    stock: 0,
    sizes,
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

const files = readdirSync(IMAGES_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
const parsed = files.map(parseFile);

if (DRY) {
  for (const p of parsed) {
    console.log(
      `${p.sku} | ${p.title}\n    ${p.subtitle} | ₹${p.price}` +
        `${p.discount_price ? ` -> ₹${p.discount_price}` : ''}${p.ribbon ? ` | ${p.ribbon}` : ''}` +
        ` | sizes ${p.sizes.map((s) => `${s.size}:${s.stock}`).join(' ')}`,
    );
  }
  console.log(`\n${parsed.length} products parsed (dry run, nothing uploaded).`);
} else {
  const rows = [];
  for (const p of parsed) {
    const image = await uploadToCloudinary(path.join(IMAGES_DIR, p.fileName));
    const { fileName, ...rest } = p;
    rows.push({ ...rest, ...image });
    console.log(`uploaded ${p.sku} ${p.title}`);
  }
  const inserted = await insertProducts(rows);
  console.log(`\nInserted ${inserted.length} products into Supabase.`);
}
