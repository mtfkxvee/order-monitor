require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const { ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET } = process.env;
const PORT = process.env.PORT || 3000;
const DOCTYPE = 'Sales Order Tracking';
const VIDEO_DOCTYPE = 'Order Monitor Video';
const VIDEO_CACHE_DIR = path.join(__dirname, 'video-cache');
const VIDEO_MANIFEST_FILE = path.join(VIDEO_CACHE_DIR, 'manifest.json');
const VIDEO_SYNC_INTERVAL_MS = 60_000;

if (!ERPNEXT_URL || !ERPNEXT_API_KEY || !ERPNEXT_API_SECRET) {
  console.error('Missing ERPNEXT_URL / ERPNEXT_API_KEY / ERPNEXT_API_SECRET in .env');
  process.exit(1);
}

fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });

// ERPNext status -> monitor column
const STATUS_MAP = {
  'Order Placed': 'preparing',
  'On Progress': 'preparing',
  'Complete': 'ready',
};

function erpAuthHeaders() {
  return {
    Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}`,
    'Content-Type': 'application/json',
  };
}

function todayDateStr() {
  // Explicitly compute "today" in WIB (Asia/Jakarta), independent of the
  // server OS timezone. The server this runs on is set to UTC, so relying
  // on the OS local date (getFullYear/getMonth/getDate) silently falls back
  // to UTC behavior and still misses same-day WIB orders near midnight.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

// Fallback only: last 3 digits of the transaction number, e.g.
// "SINV-2026-00123" -> "123". Used if a Sales Invoice has no order_number set.
function lastThreeDigits(name) {
  const digits = (name || '').replace(/\D/g, '');
  return digits.slice(-3).padStart(3, '0');
}

// The tracking doc is autonamed from sales_invoice, so doc.name IS the
// Sales Invoice name. Bulk-fetch order_number (a custom field on Sales
// Invoice) for all of them in one call instead of one request per order.
async function fetchOrderNumbers(salesInvoiceNames) {
  if (!salesInvoiceNames.length) return {};
  const filters = JSON.stringify([['name', 'in', salesInvoiceNames]]);
  const fields = JSON.stringify(['name', 'order_number']);
  const url = `${ERPNEXT_URL}/api/resource/Sales%20Invoice` +
    `?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent(fields)}&limit_page_length=0`;

  const res = await fetch(url, { headers: erpAuthHeaders() });
  if (!res.ok) {
    throw new Error(`ERPNext error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const map = {};
  for (const doc of body.data || []) {
    map[doc.name] = doc.order_number;
  }
  return map;
}

async function fetchTrackedOrders() {
  const filters = JSON.stringify([['posting_date', '=', todayDateStr()]]);
  const fields = JSON.stringify(['name', 'sales_invoice', 'status', 'customer', 'posting_date', 'modified', 'remarks']);
  const url = `${ERPNEXT_URL}/api/resource/${encodeURIComponent(DOCTYPE)}` +
    `?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent(fields)}` +
    `&order_by=${encodeURIComponent('modified desc')}&limit_page_length=0`;

  const res = await fetch(url, { headers: erpAuthHeaders() });
  if (!res.ok) {
    throw new Error(`ERPNext error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const docs = body.data || [];

  let orderNumbers = {};
  try {
    orderNumbers = await fetchOrderNumbers(docs.map((doc) => doc.name));
  } catch (err) {
    console.error('Failed to fetch order_number from Sales Invoice:', err.message);
  }

  return docs.map((doc) => ({
    id: doc.name,
    number: orderNumbers[doc.name] != null ? String(orderNumbers[doc.name]) : lastThreeDigits(doc.name),
    fullNumber: doc.name,
    status: STATUS_MAP[doc.status] || 'preparing',
    erpStatus: doc.status,
    customer: doc.customer,
    remarks: doc.remarks || '',
    updatedAt: doc.modified,
  }));
}

// The tracking doc is autonamed from sales_invoice, so doc.name IS the
// Sales Invoice name — fetch its item table directly.
async function fetchInvoiceItems(salesInvoiceName) {
  const url = `${ERPNEXT_URL}/api/resource/Sales%20Invoice/${encodeURIComponent(salesInvoiceName)}` +
    `?fields=${encodeURIComponent(JSON.stringify(['items']))}`;
  const res = await fetch(url, { headers: erpAuthHeaders() });
  if (!res.ok) {
    throw new Error(`ERPNext error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return (body.data.items || []).map((item) => ({
    itemCode: item.item_code,
    itemName: item.item_name,
    qty: item.qty,
  }));
}

async function updateOrder(id, updates) {
  const url = `${ERPNEXT_URL}/api/resource/${encodeURIComponent(DOCTYPE)}/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: erpAuthHeaders(),
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error(`ERPNext error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- Video playlist: mirrored from ERPNext "Order Monitor Video" doctype,
// downloaded once and cached on disk so playback doesn't depend on ERPNext
// being reachable on every loop.

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(VIDEO_MANIFEST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  fs.writeFileSync(VIDEO_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

// In-memory playlist served to the frontend; refreshed by syncVideos().
let videoPlaylist = [];

async function fetchVideoDocs() {
  const filters = JSON.stringify([['is_active', '=', 1]]);
  const fields = JSON.stringify(['name', 'title', 'video', 'sort_order', 'modified']);
  const url = `${ERPNEXT_URL}/api/resource/${encodeURIComponent(VIDEO_DOCTYPE)}` +
    `?filters=${encodeURIComponent(filters)}&fields=${encodeURIComponent(fields)}` +
    `&order_by=${encodeURIComponent('sort_order asc')}&limit_page_length=0`;

  const res = await fetch(url, { headers: erpAuthHeaders() });
  if (!res.ok) {
    throw new Error(`ERPNext error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return body.data || [];
}

async function downloadVideoFile(erpPath, destPath) {
  const fileUrl = /^https?:\/\//i.test(erpPath) ? erpPath : `${ERPNEXT_URL}${erpPath}`;
  const res = await fetch(fileUrl, {
    headers: { Authorization: `token ${ERPNEXT_API_KEY}:${ERPNEXT_API_SECRET}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download ${fileUrl}: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function syncVideos() {
  let docs;
  try {
    docs = await fetchVideoDocs();
  } catch (err) {
    console.error('Video sync: failed to reach ERPNext, keeping cached playlist', err.message);
    return;
  }

  const manifest = loadManifest();
  const nextManifest = {};
  const nextPlaylist = [];

  for (const doc of docs) {
    if (!doc.video) continue;
    const ext = path.extname(doc.video.split('?')[0]) || '.mp4';
    const filename = `${doc.name}${ext}`;
    const destPath = path.join(VIDEO_CACHE_DIR, filename);

    const cached = manifest[doc.name];
    const isCached = cached && cached.modified === doc.modified && fs.existsSync(destPath);

    if (!isCached) {
      try {
        console.log(`Video sync: downloading "${doc.title}" (${doc.name})`);
        await downloadVideoFile(doc.video, destPath);
      } catch (err) {
        console.error(`Video sync: failed to download ${doc.name}:`, err.message);
        // Fall back to whatever is already on disk, if anything.
        if (!fs.existsSync(destPath)) continue;
      }
    }

    nextManifest[doc.name] = { modified: doc.modified, filename };
    nextPlaylist.push({
      id: doc.name,
      title: doc.title,
      sortOrder: doc.sort_order,
      url: `/media/${filename}`,
    });
  }

  // Drop cached files that are no longer referenced by an active video doc.
  for (const [name, entry] of Object.entries(manifest)) {
    if (!nextManifest[name]) {
      const stalePath = path.join(VIDEO_CACHE_DIR, entry.filename);
      fs.rm(stalePath, { force: true }, () => {});
    }
  }

  saveManifest(nextManifest);
  videoPlaylist = nextPlaylist;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(VIDEO_CACHE_DIR, { maxAge: '1d' }));

app.get('/api/videos', (req, res) => {
  res.json(videoPlaylist);
});

// List orders tracked today, optionally filtered by ?status=preparing,ready
// Pass ?include=items to also attach each order's line items + qty (used by
// the admin panel; skipped for the monitor screen to keep polling cheap).
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await fetchTrackedOrders();
    const statusFilter = req.query.status ? String(req.query.status).split(',') : null;
    let result = statusFilter ? orders.filter((o) => statusFilter.includes(o.status)) : orders;

    if (req.query.include === 'items') {
      result = await Promise.all(result.map(async (order) => {
        try {
          const items = await fetchInvoiceItems(order.id);
          return { ...order, items };
        } catch (err) {
          console.error(`Failed to fetch items for ${order.id}:`, err.message);
          return { ...order, items: [] };
        }
      }));
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'failed to fetch orders from ERPNext' });
  }
});

// Update a tracking record's ERPNext status and/or remarks
// body: { erpStatus?: "Order Placed" | "On Progress" | "Complete", remarks?: string }
app.patch('/api/orders/:id', async (req, res) => {
  const { erpStatus, remarks } = req.body;
  const updates = {};

  if (erpStatus !== undefined) {
    if (!Object.keys(STATUS_MAP).includes(erpStatus)) {
      return res.status(400).json({ error: 'invalid erpStatus' });
    }
    updates.status = erpStatus;
  }
  if (remarks !== undefined) {
    updates.remarks = remarks;
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'nothing to update' });
  }

  try {
    await updateOrder(req.params.id, updates);
    res.json({ id: req.params.id, ...updates });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'failed to update order in ERPNext' });
  }
});

app.listen(PORT, () => {
  console.log(`Order monitor server running at http://localhost:${PORT}`);
  console.log(`Reading "${DOCTYPE}" from ${ERPNEXT_URL}`);
});

syncVideos();
setInterval(syncVideos, VIDEO_SYNC_INTERVAL_MS);
