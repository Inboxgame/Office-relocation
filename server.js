const express = require('express');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Cloud Run only allows writing to /tmp
const DB_FILE = '/tmp/server_assets.json';

// Ensure DB file exists
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, '[]');
}

const readDb = () => {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
};

const writeDb = (data) => {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/assets', (req, res) => {
  res.json(readDb());
});

// POST now MERGES new assets instead of overwriting
app.post('/api/assets', (req, res) => {
  const existingAssets = readDb();
  const newAssets = req.body;

  if (!Array.isArray(newAssets)) {
    return res.status(400).json({ error: 'Expected array of assets' });
  }

  // Create a map of existing assets by ID for fast lookup
  const assetMap = new Map(existingAssets.map(asset => [asset.id, asset]));

  // Add or update assets from the request
  for (const asset of newAssets) {
    assetMap.set(asset.id, asset);
  }

  // Convert back to array, with newest first
  const mergedAssets = Array.from(assetMap.values());

  // Sort by ID to keep newer items (with timestamps) at top, or maintain insertion order
  // Since new assets are added to the map last, we reverse to get newest first
  writeDb(mergedAssets);

  res.json({ success: true, count: mergedAssets.length });
});

app.delete('/api/assets', (req, res) => {
  const db = readDb();
  const idsToDelete = new Set(req.body.ids);
  const filtered = db.filter((asset) => !idsToDelete.has(asset.id));
  writeDb(filtered);
  res.json({ success: true, remaining: filtered.length });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
