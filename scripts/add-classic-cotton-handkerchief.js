/**
 * One-time insert: the Classic Cotton Handkerchief (SKU TEST-HANK-199), a
 * low-value product used to exercise the live cart -> checkout -> payment flow.
 *
 * Same architecture as scripts/import-womens-shrugs.js: Cloudinary unsigned
 * preset upload (as apps/web/src/lib/cloudinary.js) and the products payload
 * shape built by ProductForm in apps/web/src/pages/AdminPage.jsx.
 *
 * The "test" marker lives only in the SKU. Unsized + track_quantity=false means
 * the storefront never renders variant.title (= SKU) to customers.
 * Price 199.00 is the trusted record: api/_lib/pricing.js reads it server-side,
 * giving 19900 paise for SabPaisa / Frontiva PayIn and "199.00" for Airpay.
 *
 * Idempotent: skipped when a product with this SKU already exists.
 * Rollback: update public.products set active = false where sku = 'TEST-HANK-199';
 *
 * Usage:  node scripts/add-classic-cotton-handkerchief.js [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(STORE_ROOT, '..');
const IMAGE = path.join(HERE, 'assets', 'classic-cotton-handkerchief.svg');
const DRY_RUN = process.argv.includes('--dry-run');

const PRODUCT = {
  title: 'Classic Cotton Handkerchief',
  subtitle: null,
  description: 'A soft cotton handkerchief for everyday use. Lightweight, comfortable, and easy to carry. Pack of 1.',
  ribbon: null,
  price: 199,
  discount_price: null,
  sku: 'TEST-HANK-199',
  weight: null,
  track_quantity: false,
  stock: 0,
  sizes: [],
  category: 'accessories',
  active: true,
};

const readEnv = (file) => {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const env = {
  ...readEnv(path.join(REPO_ROOT, '.env')),
  ...readEnv(path.join(STORE_ROOT, '.env')),
  ...readEnv(path.join(STORE_ROOT, 'apps/web/.env')),
  ...process.env,
};

const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE;
const CLOUD_NAME = env.VITE_CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME;
const UPLOAD_PRESET = env.VITE_CLOUDINARY_UPLOAD_PRESET;

if (!SUPABASE_URL || !SUPABASE_KEY || !CLOUD_NAME || !UPLOAD_PRESET) {
  throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE / VITE_CLOUDINARY_* in .env');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

async function uploadImage() {
  const body = new FormData();
  body.append('file', new Blob([fs.readFileSync(IMAGE)], { type: 'image/svg+xml' }), path.basename(IMAGE));
  body.append('upload_preset', UPLOAD_PRESET);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, { method: 'POST', body });
  if (!response.ok) throw new Error(`Cloudinary upload failed: ${response.status} ${await response.text()}`);

  const data = await response.json();
  // Deliver as PNG (Cloudinary converts by extension) to match the raster catalogue.
  return { image_url: data.secure_url.replace(/\.svg$/, '.png'), cloudinary_public_id: data.public_id };
}

const { data: existing, error: readError } = await supabase.from('products').select('id, title, price, active').eq('sku', PRODUCT.sku);
if (readError) throw readError;

if (existing.length > 0) {
  console.log('SKIP   already present:', existing);
} else if (DRY_RUN) {
  console.log('DRY    would insert:', PRODUCT);
} else {
  const uploaded = await uploadImage();
  const { data, error } = await supabase
    .from('products')
    .insert({ ...PRODUCT, ...uploaded })
    .select('id, title, sku, price, category, active, image_url')
    .single();
  if (error) throw error;
  console.log('OK     inserted:', data);
}
