const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ────────────────────────────────────────────────────────────────
const db = new Database('/data/energietracker.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    address    TEXT DEFAULT '',
    notes      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS meters (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id       INTEGER NOT NULL,
    type              TEXT NOT NULL CHECK(type IN ('strom','gas','wasser')),
    name              TEXT NOT NULL,
    meter_number      TEXT DEFAULT '',
    unit              TEXT DEFAULT '',
    notes             TEXT DEFAULT '',
    conversion_factor REAL DEFAULT 1.0,
    created_at        TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS readings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meter_id   INTEGER NOT NULL,
    date       TEXT NOT NULL,
    value      REAL NOT NULL,
    notes      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (meter_id) REFERENCES meters(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tariffs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    meter_id            INTEGER NOT NULL,
    provider            TEXT DEFAULT '',
    tariff_name         TEXT DEFAULT '',
    working_price       REAL DEFAULT 0,
    base_price          REAL DEFAULT 0,
    grid_working_price  REAL DEFAULT 0,
    grid_base_price     REAL DEFAULT 0,
    meter_fee           REAL DEFAULT 0,
    sewage_price        REAL DEFAULT 0,
    other_levies        REAL DEFAULT 0,
    tax_rate            REAL DEFAULT 19,
    valid_from          TEXT DEFAULT '',
    valid_to            TEXT DEFAULT '',
    prices_gross        INTEGER DEFAULT 0,
    notes               TEXT DEFAULT '',
    created_at          TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (meter_id) REFERENCES meters(id) ON DELETE CASCADE
  );
`);

// Migrations
try { db.exec('ALTER TABLE tariffs ADD COLUMN prices_gross INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE meters ADD COLUMN conversion_factor REAL DEFAULT 1.0'); } catch(e) {}

// ── Properties ───────────────────────────────────────────────────────────────
app.get('/api/properties', (req, res) => {
  res.json(db.prepare('SELECT * FROM properties ORDER BY name').all());
});

app.post('/api/properties', (req, res) => {
  const { name, address = '', notes = '' } = req.body;
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  const r = db.prepare('INSERT INTO properties (name,address,notes) VALUES (?,?,?)').run(name, address, notes);
  res.json({ id: r.lastInsertRowid, name, address, notes });
});

app.put('/api/properties/:id', (req, res) => {
  const { name, address = '', notes = '' } = req.body;
  db.prepare('UPDATE properties SET name=?,address=?,notes=? WHERE id=?').run(name, address, notes, req.params.id);
  res.json({ success: true });
});

app.delete('/api/properties/:id', (req, res) => {
  db.prepare('DELETE FROM properties WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Meters ───────────────────────────────────────────────────────────────────
app.get('/api/meters', (req, res) => {
  const { property_id } = req.query;
  if (property_id) {
    res.json(db.prepare('SELECT * FROM meters WHERE property_id=? ORDER BY type,name').all(property_id));
  } else {
    res.json(db.prepare(
      'SELECT m.*, p.name as property_name FROM meters m JOIN properties p ON m.property_id=p.id ORDER BY p.name,m.type,m.name'
    ).all());
  }
});

app.post('/api/meters', (req, res) => {
  const { property_id, type, name, meter_number = '', unit = '', notes = '', conversion_factor = 1.0 } = req.body;
  if (!property_id || !type || !name) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  const defaultUnit = type === 'strom' ? 'kWh' : 'm³';
  const cf = +conversion_factor || 1.0;
  const r = db.prepare(
    'INSERT INTO meters (property_id,type,name,meter_number,unit,notes,conversion_factor) VALUES (?,?,?,?,?,?,?)'
  ).run(property_id, type, name, meter_number, unit || defaultUnit, notes, cf);
  res.json({ id: r.lastInsertRowid, property_id, type, name, meter_number, unit: unit || defaultUnit, notes, conversion_factor: cf });
});

app.put('/api/meters/:id', (req, res) => {
  const { type, name, meter_number = '', unit = '', notes = '', conversion_factor = 1.0 } = req.body;
  db.prepare('UPDATE meters SET type=?,name=?,meter_number=?,unit=?,notes=?,conversion_factor=? WHERE id=?')
    .run(type, name, meter_number, unit, notes, +conversion_factor || 1.0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/meters/:id', (req, res) => {
  db.prepare('DELETE FROM meters WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Readings ─────────────────────────────────────────────────────────────────
app.get('/api/readings', (req, res) => {
  const { meter_id, limit = 200 } = req.query;
  if (meter_id) {
    res.json(db.prepare('SELECT * FROM readings WHERE meter_id=? ORDER BY date DESC LIMIT ?').all(meter_id, +limit));
  } else {
    res.json(db.prepare(
      'SELECT r.*,m.name as meter_name,m.type,m.unit,p.name as property_name FROM readings r JOIN meters m ON r.meter_id=m.id JOIN properties p ON m.property_id=p.id ORDER BY r.date DESC LIMIT ?'
    ).all(+limit));
  }
});

app.post('/api/readings', (req, res) => {
  const { meter_id, date, value, notes = '' } = req.body;
  if (!meter_id || !date || value === undefined) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  const r = db.prepare('INSERT INTO readings (meter_id,date,value,notes) VALUES (?,?,?,?)').run(meter_id, date, value, notes);
  res.json({ id: r.lastInsertRowid, meter_id, date, value, notes });
});

app.put('/api/readings/:id', (req, res) => {
  const { date, value, notes = '' } = req.body;
  db.prepare('UPDATE readings SET date=?,value=?,notes=? WHERE id=?').run(date, value, notes, req.params.id);
  res.json({ success: true });
});

app.delete('/api/readings/:id', (req, res) => {
  db.prepare('DELETE FROM readings WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Tariffs ──────────────────────────────────────────────────────────────────
app.get('/api/tariffs', (req, res) => {
  const { meter_id } = req.query;
  if (meter_id) {
    res.json(db.prepare('SELECT * FROM tariffs WHERE meter_id=? ORDER BY valid_from DESC,created_at DESC').all(meter_id));
  } else {
    res.json(db.prepare('SELECT * FROM tariffs ORDER BY created_at DESC').all());
  }
});

app.post('/api/tariffs', (req, res) => {
  const f = req.body;
  if (!f.meter_id) return res.status(400).json({ error: 'meter_id erforderlich' });
  const r = db.prepare(
    `INSERT INTO tariffs (meter_id,provider,tariff_name,working_price,base_price,
     grid_working_price,grid_base_price,meter_fee,sewage_price,other_levies,
     tax_rate,valid_from,valid_to,prices_gross,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(f.meter_id, f.provider||'', f.tariff_name||'', +f.working_price||0, +f.base_price||0,
    +f.grid_working_price||0, +f.grid_base_price||0, +f.meter_fee||0,
    +f.sewage_price||0, +f.other_levies||0, +f.tax_rate||19,
    f.valid_from||'', f.valid_to||'', f.prices_gross?1:0, f.notes||'');
  res.json({ id: r.lastInsertRowid, ...f });
});

app.put('/api/tariffs/:id', (req, res) => {
  const f = req.body;
  db.prepare(
    `UPDATE tariffs SET provider=?,tariff_name=?,working_price=?,base_price=?,
     grid_working_price=?,grid_base_price=?,meter_fee=?,sewage_price=?,
     other_levies=?,tax_rate=?,valid_from=?,valid_to=?,prices_gross=?,notes=? WHERE id=?`
  ).run(f.provider||'', f.tariff_name||'', +f.working_price||0, +f.base_price||0,
    +f.grid_working_price||0, +f.grid_base_price||0, +f.meter_fee||0,
    +f.sewage_price||0, +f.other_levies||0, +f.tax_rate||19,
    f.valid_from||'', f.valid_to||'', f.prices_gross?1:0, f.notes||'', req.params.id);
  res.json({ success: true });
});

app.delete('/api/tariffs/:id', (req, res) => {
  db.prepare('DELETE FROM tariffs WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Tariff Extraction from Document ─────────────────────────────────────────
function deNum(s) {
  // Convert German number format (1.234,56 or 1234,56 or 1234.56) to float
  if (!s) return 0;
  s = s.trim();
  // If has both . and , — German thousands separator: 1.234,56
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  return parseFloat(s) || 0;
}

function findNum(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return deNum(m[1]);
  }
  return 0;
}

function findDate(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      // Convert DD.MM.YYYY to YYYY-MM-DD
      if (m[1] && m[1].includes('.')) {
        const parts = m[1].split('.');
        if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
      }
      return m[1] || '';
    }
  }
  return '';
}

function extractTariffFromText(text) {
  const t = text.replace(/\s+/g, ' ');

  // Detect type
  let type = 'strom';
  if (/\bgas\b|\berdgas\b|\bnatural.?gas\b/i.test(t)) type = 'gas';
  else if (/\bwasser\b|\btrinkwasser\b|\bfrischwasser\b/i.test(t)) type = 'wasser';

  // Provider: first non-empty line often contains it, or look for known patterns
  const providerMatch = t.match(/(?:Anbieter|Lieferant|Versorger)[:\s]+([^\n,;]{3,40})/i)
    || t.match(/^([A-ZÄÖÜ][a-zA-ZÄÖÜäöüß\s&.\-]{2,35}(?:GmbH|AG|KG|Werke|Energie|Strom|Gas|Power))/m);
  const provider = providerMatch ? providerMatch[1].trim() : '';

  // Tariff name
  const tariffMatch = t.match(/(?:Tarif(?:name)?|Produkt(?:name)?|Bezeichnung)[:\s]+([^\n,;]{3,50})/i);
  const tariff_name = tariffMatch ? tariffMatch[1].trim() : '';

  // Working price (ct/kWh for Strom/Gas, €/m³ for Wasser)
  let working_price = 0;
  if (type === 'wasser') {
    working_price = findNum(t, [
      /(?:Frischwasser|Wasserpreis|Arbeitspreis)[^0-9]*?([\d.,]+)\s*€\s*\/\s*m[³3]/i,
      /([\d.,]+)\s*€\s*\/\s*m[³3](?!\s*Abwasser)/i,
    ]);
  } else {
    working_price = findNum(t, [
      /Arbeitspreis[^0-9]*?([\d.,]+)\s*(?:ct|Cent|¢)\s*\/\s*kWh/i,
      /([\d.,]+)\s*(?:ct|Cent)\s*\/\s*kWh/i,
      /Arbeitspreis[^0-9]*?([\d.,]+)/i,
    ]);
  }

  // Base price (€/Monat)
  const base_price = findNum(t, [
    /Grundpreis[^0-9]*?([\d.,]+)\s*€\s*\/\s*(?:Monat|Mon\.|mtl\.)/i,
    /Grundgebühr[^0-9]*?([\d.,]+)\s*€\s*\/\s*(?:Monat|Mon\.|mtl\.)/i,
    /Grundpreis[^0-9]*?([\d.,]+)/i,
  ]);

  // Grid fees (Netzentgelt)
  const grid_working_price = findNum(t, [
    /Netzentgelt[^\n]*?Arbeit[^0-9]*?([\d.,]+)\s*(?:ct|Cent)\s*\/\s*kWh/i,
    /Netz(?:nutzungs)?entgelt[^0-9]*?([\d.,]+)\s*(?:ct|Cent)\s*\/\s*kWh/i,
  ]);
  const grid_base_price = findNum(t, [
    /Netzentgelt[^\n]*?Grund[^0-9]*?([\d.,]+)\s*€\s*\/\s*(?:Monat|Mon\.)/i,
    /Netzgrundpreis[^0-9]*?([\d.,]+)/i,
  ]);

  // Meter fee (Messstellenentgelt)
  const meter_fee = findNum(t, [
    /Messstellen(?:entgelt|betrieb)[^0-9]*?([\d.,]+)\s*€\s*\/\s*(?:Monat|Mon\.)/i,
    /Messstellenentgelt[^0-9]*?([\d.,]+)/i,
  ]);

  // Sewage (Abwasser)
  const sewage_price = type === 'wasser' ? findNum(t, [
    /Abwasser[^0-9]*?([\d.,]+)\s*€\s*\/\s*m[³3]/i,
    /Entsorgung[^0-9]*?([\d.,]+)\s*€\s*\/\s*m[³3]/i,
  ]) : 0;

  // Tax rate
  const taxMatch = t.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:MwSt\.?|Mehrwertsteuer|USt\.?)/i);
  const tax_rate = taxMatch ? deNum(taxMatch[1]) : (type === 'wasser' ? 7 : 19);

  // Gross prices indicator
  const prices_gross = /(?:inkl\.|inklusive|einschließlich)\s*(?:MwSt|Mehrwertsteuer|USt)/i.test(t);

  // Dates
  const valid_from = findDate(t, [
    /(?:gültig\s+ab|Vertragsbeginn|Lieferbeginn)[^0-9]*([\d]{1,2}\.[\d]{1,2}\.[\d]{4})/i,
    /(?:ab|von)\s+([\d]{1,2}\.[\d]{1,2}\.[\d]{4})/i,
  ]);
  const valid_to = findDate(t, [
    /(?:gültig\s+bis|Vertragsende|Lieferende)[^0-9]*([\d]{1,2}\.[\d]{1,2}\.[\d]{4})/i,
    /(?:bis)\s+([\d]{1,2}\.[\d]{1,2}\.[\d]{4})/i,
  ]);

  return { type, provider, tariff_name, working_price, base_price, grid_working_price, grid_base_price, meter_fee, sewage_price, tax_rate, prices_gross, valid_from, valid_to };
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `et_${crypto.randomBytes(6).toString('hex')}${ext}`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function ocrImage(imageBuffer) {
  const imgPath = tmpFile('.jpg');
  const outBase = tmpFile('');
  try {
    fs.writeFileSync(imgPath, imageBuffer);
    await run('tesseract', [imgPath, outBase, '-l', 'deu+eng', '--oem', '3', '--psm', '3']);
    return fs.readFileSync(outBase + '.txt', 'utf8');
  } finally {
    for (const f of [imgPath, outBase + '.txt']) try { fs.unlinkSync(f); } catch(e) {}
  }
}

async function ocrScannedPdf(pdfBuffer) {
  const pdfPath = tmpFile('.pdf');
  const outPrefix = tmpFile('');
  let pages = [];
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    // Convert first 4 pages to JPEG (150dpi is enough for text recognition)
    await run('pdftoppm', ['-r', '150', '-jpeg', '-l', '4', pdfPath, outPrefix]);
    pages = fs.readdirSync(os.tmpdir())
      .filter(f => f.startsWith(path.basename(outPrefix)) && f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(os.tmpdir(), f));

    const texts = await Promise.all(pages.map(async p => {
      const buf = fs.readFileSync(p);
      return ocrImage(buf);
    }));
    return texts.join('\n');
  } finally {
    for (const f of [pdfPath, ...pages]) try { fs.unlinkSync(f); } catch(e) {}
  }
}

app.post('/api/tariffs/extract', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });

  const mime = req.file.mimetype;
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/tiff'];
  if (!allowed.includes(mime))
    return res.status(400).json({ error: 'Nur PDF, JPG, PNG oder WEBP erlaubt' });

  try {
    let text = '';

    if (mime === 'application/pdf') {
      // Try text extraction first (fast, no OCR needed)
      const pdf = await pdfParse(req.file.buffer);
      if (pdf.text && pdf.text.trim().length > 80) {
        text = pdf.text;
      } else {
        // Scanned PDF → convert to images → OCR
        text = await ocrScannedPdf(req.file.buffer);
      }
    } else {
      // Image → OCR directly
      text = await ocrImage(req.file.buffer);
    }

    if (!text || text.trim().length < 30)
      return res.status(422).json({ error: 'Kein Text erkannt. Bitte ein klareres Bild oder eine bessere PDF-Qualität verwenden.' });

    const data = extractTariffFromText(text);
    res.json({ ...data, _source: mime === 'application/pdf' ? 'pdf' : 'ocr' });
  } catch(e) {
    res.status(500).json({ error: 'Dokument konnte nicht verarbeitet werden: ' + e.message });
  }
});

// ── Consumption Calculation ──────────────────────────────────────────────────
app.get('/api/consumption', (req, res) => {
  const { meter_id, from_id, to_id } = req.query;
  if (!meter_id || !from_id || !to_id) return res.status(400).json({ error: 'Parameter fehlen' });

  const rFrom = db.prepare('SELECT * FROM readings WHERE id=?').get(from_id);
  const rTo   = db.prepare('SELECT * FROM readings WHERE id=?').get(to_id);
  const meter = db.prepare('SELECT * FROM meters WHERE id=?').get(meter_id);

  if (!rFrom || !rTo || !meter) return res.status(404).json({ error: 'Nicht gefunden' });

  const consumption = rTo.value - rFrom.value;
  const days = Math.max(1, Math.round((new Date(rTo.date) - new Date(rFrom.date)) / 86400000));

  // Find best matching tariff
  const tariff =
    db.prepare(`SELECT * FROM tariffs WHERE meter_id=?
                AND (valid_from='' OR valid_from<=?) AND (valid_to='' OR valid_to>=?)
                ORDER BY valid_from DESC LIMIT 1`).get(meter_id, rTo.date, rFrom.date)
    || db.prepare('SELECT * FROM tariffs WHERE meter_id=? ORDER BY created_at DESC LIMIT 1').get(meter_id);

  if (!tariff) return res.json({ consumption, days, meter, from: rFrom, to: rTo, tariff: null, cost: null });

  const cf = (meter.type === 'gas' && meter.conversion_factor && meter.conversion_factor !== 1.0)
    ? meter.conversion_factor : 1.0;
  const consumptionKwh = consumption * cf;
  const cfLabel = cf !== 1.0
    ? `${consumption.toFixed(3)} m³ × ${cf} = ${consumptionKwh.toFixed(3)} kWh`
    : null;

  let netto = 0;
  const details = {};

  if (meter.type === 'wasser') {
    details['Frischwasser']           = { value: consumption * tariff.working_price,      unit: `${consumption.toFixed(3)} m³ × ${tariff.working_price} €/m³` };
    details['Abwasser/Entsorgung']    = { value: consumption * tariff.sewage_price,        unit: `${consumption.toFixed(3)} m³ × ${tariff.sewage_price} €/m³` };
    details['Grundgebühr (anteilig)'] = { value: tariff.base_price * days / 30,            unit: `${tariff.base_price} €/Mon × ${days} Tage` };
    if (tariff.other_levies) details['Sonstiges'] = { value: consumption * tariff.other_levies, unit: '' };
  } else {
    const billUnit = cf !== 1.0 ? `${consumptionKwh.toFixed(3)} kWh` : `${consumption.toFixed(3)} ${meter.unit}`;
    details['Arbeitspreis']              = { value: consumptionKwh * tariff.working_price / 100,        unit: `${cfLabel || billUnit} × ${tariff.working_price} ct/kWh` };
    details['Grundpreis (anteilig)']     = { value: tariff.base_price * days / 30,                      unit: `${tariff.base_price} €/Mon × ${days} Tage` };
    details['Netzentgelt Arbeit']        = { value: consumptionKwh * tariff.grid_working_price / 100,   unit: `${billUnit} × ${tariff.grid_working_price} ct/kWh` };
    details['Netzentgelt Grundpreis']    = { value: tariff.grid_base_price * days / 30,                  unit: `${tariff.grid_base_price} €/Mon × ${days} Tage` };
    details['Messstellenentgelt']        = { value: tariff.meter_fee * days / 30,                        unit: `${tariff.meter_fee} €/Mon × ${days} Tage` };
    if (tariff.other_levies) details['Sonstige Umlagen'] = { value: consumptionKwh * tariff.other_levies / 100, unit: `${billUnit} × ${tariff.other_levies} ct/kWh` };
  }

  netto = Object.values(details).reduce((s, d) => s + d.value, 0);
  const tax    = tariff.prices_gross ? 0 : netto * tariff.tax_rate / 100;
  const brutto = netto + tax;

  res.json({ consumption, days, meter, from: rFrom, to: rTo, tariff, cost: { netto, tax, brutto, taxRate: tariff.prices_gross ? 0 : tariff.tax_rate, details } });
});

// ── Consumption Range ────────────────────────────────────────────────────────
app.get('/api/consumption/range', (req, res) => {
  const { property_id, type, from_date, to_date } = req.query;
  if (!property_id || !type || !from_date || !to_date)
    return res.status(400).json({ error: 'Parameter fehlen' });

  const property = db.prepare('SELECT * FROM properties WHERE id=?').get(property_id);
  if (!property) return res.status(404).json({ error: 'Objekt nicht gefunden' });

  const meters = db.prepare('SELECT * FROM meters WHERE property_id=? AND type=? ORDER BY created_at').all(property_id, type);

  const segments = [];
  let totalConsumption = 0, totalNetto = 0, totalTax = 0, totalBrutto = 0;

  for (const meter of meters) {
    const baseReading = db.prepare(
      'SELECT * FROM readings WHERE meter_id=? AND date<=? ORDER BY date DESC LIMIT 1'
    ).get(meter.id, from_date);
    const periodReadings = db.prepare(
      'SELECT * FROM readings WHERE meter_id=? AND date>? AND date<=? ORDER BY date ASC'
    ).all(meter.id, from_date, to_date);

    if (!baseReading && periodReadings.length < 2) continue;
    const chain = baseReading ? [baseReading, ...periodReadings] : periodReadings;
    if (chain.length < 2) continue;

    for (let i = 0; i < chain.length - 1; i++) {
      const rFrom = chain[i];
      const rTo   = chain[i + 1];
      const consumption = rTo.value - rFrom.value;
      if (consumption < 0) continue;

      const days = Math.max(1, Math.round((new Date(rTo.date) - new Date(rFrom.date)) / 86400000));

      const tariff =
        db.prepare(`SELECT * FROM tariffs WHERE meter_id=?
                    AND (valid_from='' OR valid_from<=?) AND (valid_to='' OR valid_to>=?)
                    ORDER BY valid_from DESC LIMIT 1`).get(meter.id, rTo.date, rFrom.date)
        || db.prepare('SELECT * FROM tariffs WHERE meter_id=? ORDER BY created_at DESC LIMIT 1').get(meter.id);

      let cost = null;
      if (tariff) {
        const details = {};
        const cf = (meter.type === 'gas' && meter.conversion_factor && meter.conversion_factor !== 1.0)
          ? meter.conversion_factor : 1.0;
        const consumptionKwh = consumption * cf;
        if (meter.type === 'wasser') {
          details['Frischwasser']  = consumption * tariff.working_price;
          details['Abwasser']      = consumption * tariff.sewage_price;
          details['Grundgebühr']   = tariff.base_price * days / 30;
          if (tariff.other_levies) details['Sonstiges'] = consumption * tariff.other_levies;
        } else {
          details['Arbeitspreis']         = consumptionKwh * tariff.working_price / 100;
          details['Grundpreis']           = tariff.base_price * days / 30;
          details['Netzentgelt Arbeit']   = consumptionKwh * tariff.grid_working_price / 100;
          details['Netzentgelt Grund']    = tariff.grid_base_price * days / 30;
          details['Messstellenentgelt']   = tariff.meter_fee * days / 30;
          if (tariff.other_levies) details['Sonstige Umlagen'] = consumptionKwh * tariff.other_levies / 100;
        }
        const netto  = Object.values(details).reduce((s, v) => s + v, 0);
        const tax    = tariff.prices_gross ? 0 : netto * tariff.tax_rate / 100;
        const brutto = netto + tax;
        cost = { netto, tax, brutto, taxRate: tariff.prices_gross ? 0 : tariff.tax_rate, details };
        totalNetto  += netto;
        totalTax    += tax;
        totalBrutto += brutto;
      }

      totalConsumption += consumption;
      segments.push({ meter, from: rFrom, to: rTo, consumption, days, tariff: tariff || null, cost });
    }
  }

  const unit = meters[0]?.unit || (type === 'strom' ? 'kWh' : 'm³');
  res.json({
    from_date, to_date, type, property,
    total_consumption: totalConsumption,
    unit,
    total_cost: totalBrutto > 0 ? { netto: totalNetto, tax: totalTax, brutto: totalBrutto } : null,
    segments
  });
});

// ── Dashboard ────────────────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  const stats = {
    properties: db.prepare('SELECT COUNT(*) as n FROM properties').get().n,
    meters:     db.prepare('SELECT COUNT(*) as n FROM meters').get().n,
    readings:   db.prepare('SELECT COUNT(*) as n FROM readings').get().n,
  };
  const latest = db.prepare(`
    SELECT r.id,r.date,r.value,r.meter_id,
           m.name as meter_name,m.type,m.unit,
           p.name as property_name, p.id as property_id
    FROM readings r
    JOIN meters m ON r.meter_id=m.id
    JOIN properties p ON m.property_id=p.id
    WHERE r.id=(SELECT id FROM readings WHERE meter_id=r.meter_id ORDER BY date DESC LIMIT 1)
    ORDER BY p.name,m.type,m.name
  `).all();
  const getPrev = db.prepare('SELECT * FROM readings WHERE meter_id=? AND date<? ORDER BY date DESC LIMIT 1');
  const latestWithDelta = latest.map(r => ({ ...r, prev: getPrev.get(r.meter_id, r.date) || null }));
  res.json({ stats, latest: latestWithDelta });
});

// ── Backup / Restore ─────────────────────────────────────────────────────────
app.get('/api/backup', async (req, res) => {
  const bp = tmpFile('.db');
  try {
    await db.backup(bp);
    res.download(bp, `et-backup-${new Date().toISOString().slice(0,10)}.db`, () => {
      try { fs.unlinkSync(bp); } catch(e) {}
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', upload.single('database'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  if (!req.file.buffer.slice(0,16).toString().startsWith('SQLite format 3'))
    return res.status(400).json({ error: 'Ungültige Datenbankdatei' });
  fs.writeFileSync('/data/energietracker.db', req.file.buffer);
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 500);
});

// ── CSV Export / Import ──────────────────────────────────────────────────────
app.get('/api/export/readings', (req, res) => {
  const { meter_id } = req.query;
  const q = s => `"${String(s||'').replace(/"/g,'""')}"`;
  const rows = meter_id
    ? db.prepare('SELECT r.date,p.name as prop,m.name as meter,r.value,m.unit,r.notes FROM readings r JOIN meters m ON r.meter_id=m.id JOIN properties p ON m.property_id=p.id WHERE r.meter_id=? ORDER BY r.date').all(meter_id)
    : db.prepare('SELECT r.date,p.name as prop,m.name as meter,r.value,m.unit,r.notes FROM readings r JOIN meters m ON r.meter_id=m.id JOIN properties p ON m.property_id=p.id ORDER BY p.name,m.name,r.date').all();
  const csv = ['Datum,Objekt,Zähler,Stand,Einheit,Notiz',
    ...rows.map(r => [r.date,q(r.prop),q(r.meter),r.value,r.unit,q(r.notes)].join(','))
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ablesungen-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('﻿' + csv);
});

app.post('/api/import/readings', upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.status(400).json({ error: 'Datei leer' });
  const parseLine = l => {
    const c=[]; let s='', iq=false;
    for(const ch of l){if(ch==='"'){iq=!iq}else if(ch===','&&!iq){c.push(s);s=''}else s+=ch}
    c.push(s); return c;
  };
  const findM = db.prepare('SELECT m.id FROM meters m JOIN properties p ON m.property_id=p.id WHERE p.name=? AND m.name=?');
  const ins   = db.prepare('INSERT OR IGNORE INTO readings (meter_id,date,value,notes) VALUES (?,?,?,?)');
  let imp=0, sk=0;
  db.transaction(() => {
    for(let i=1;i<lines.length;i++){
      const c=parseLine(lines[i]);
      if(c.length<4){sk++;continue;}
      const m=findM.get(c[1],c[2]);
      if(!m||!c[0]||isNaN(+c[3])){sk++;continue;}
      ins.run(m.id,c[0],+c[3],c[5]||''); imp++;
    }
  })();
  res.json({ imported: imp, skipped: sk });
});

// ── Monthly Chart Data ────────────────────────────────────────────────────────
app.get('/api/chart/monthly', (req, res) => {
  const { meter_id, year } = req.query;
  if (!meter_id) return res.status(400).json({ error: 'meter_id fehlt' });
  const y = parseInt(year) || new Date().getFullYear();
  const meter = db.prepare('SELECT * FROM meters WHERE id=?').get(meter_id);
  if (!meter) return res.status(404).json({ error: 'Nicht gefunden' });
  const cf = (meter.type==='gas' && meter.conversion_factor && meter.conversion_factor!==1.0) ? meter.conversion_factor : 1.0;
  const readings = db.prepare('SELECT * FROM readings WHERE meter_id=? AND date BETWEEN ? AND ? ORDER BY date').all(meter_id, `${y-1}-11-01`, `${y}-12-31`);
  const months = Array.from({length:12}, (_,i) => ({month:i+1, consumption:null, cost:null}));
  for(let i=0; i<readings.length-1; i++){
    const a=readings[i], b=readings[i+1];
    const bD=new Date(b.date);
    if(bD.getFullYear()!==y) continue;
    const mi=bD.getMonth();
    const cons=b.value-a.value;
    if(cons<0) continue;
    months[mi].consumption=(months[mi].consumption||0)+cons;
    const tariff=db.prepare(`SELECT * FROM tariffs WHERE meter_id=? AND (valid_from=''OR valid_from<=?) AND (valid_to=''OR valid_to>=?) ORDER BY valid_from DESC LIMIT 1`).get(meter_id,b.date,a.date)||db.prepare('SELECT * FROM tariffs WHERE meter_id=? ORDER BY created_at DESC LIMIT 1').get(meter_id);
    if(tariff){
      const ck=cons*cf, days=Math.max(1,Math.round((new Date(b.date)-new Date(a.date))/86400000));
      let n = meter.type==='wasser'
        ? cons*tariff.working_price+cons*tariff.sewage_price+tariff.base_price*days/30
        : ck*tariff.working_price/100+tariff.base_price*days/30+ck*tariff.grid_working_price/100+tariff.grid_base_price*days/30+tariff.meter_fee*days/30;
      months[mi].cost=(months[mi].cost||0)+(tariff.prices_gross?n:n*(1+tariff.tax_rate/100));
    }
  }
  res.json({meter, year:y, unit:meter.unit, months});
});

app.listen(PORT, '0.0.0.0', () => console.log(`✓ Energietracker läuft auf Port ${PORT}`));
