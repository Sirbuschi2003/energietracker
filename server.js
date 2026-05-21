const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('strom','gas','wasser')),
    name        TEXT NOT NULL,
    meter_number TEXT DEFAULT '',
    unit        TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime')),
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
    notes               TEXT DEFAULT '',
    created_at          TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (meter_id) REFERENCES meters(id) ON DELETE CASCADE
  );
`);

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
  const { property_id, type, name, meter_number = '', unit = '', notes = '' } = req.body;
  if (!property_id || !type || !name) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  const defaultUnit = type === 'strom' ? 'kWh' : 'm³';
  const r = db.prepare(
    'INSERT INTO meters (property_id,type,name,meter_number,unit,notes) VALUES (?,?,?,?,?,?)'
  ).run(property_id, type, name, meter_number, unit || defaultUnit, notes);
  res.json({ id: r.lastInsertRowid, property_id, type, name, meter_number, unit: unit || defaultUnit, notes });
});

app.put('/api/meters/:id', (req, res) => {
  const { type, name, meter_number = '', unit = '', notes = '' } = req.body;
  db.prepare('UPDATE meters SET type=?,name=?,meter_number=?,unit=?,notes=? WHERE id=?')
    .run(type, name, meter_number, unit, notes, req.params.id);
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
     tax_rate,valid_from,valid_to,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(f.meter_id, f.provider||'', f.tariff_name||'', +f.working_price||0, +f.base_price||0,
    +f.grid_working_price||0, +f.grid_base_price||0, +f.meter_fee||0,
    +f.sewage_price||0, +f.other_levies||0, +f.tax_rate||19,
    f.valid_from||'', f.valid_to||'', f.notes||'');
  res.json({ id: r.lastInsertRowid, ...f });
});

app.put('/api/tariffs/:id', (req, res) => {
  const f = req.body;
  db.prepare(
    `UPDATE tariffs SET provider=?,tariff_name=?,working_price=?,base_price=?,
     grid_working_price=?,grid_base_price=?,meter_fee=?,sewage_price=?,
     other_levies=?,tax_rate=?,valid_from=?,valid_to=?,notes=? WHERE id=?`
  ).run(f.provider||'', f.tariff_name||'', +f.working_price||0, +f.base_price||0,
    +f.grid_working_price||0, +f.grid_base_price||0, +f.meter_fee||0,
    +f.sewage_price||0, +f.other_levies||0, +f.tax_rate||19,
    f.valid_from||'', f.valid_to||'', f.notes||'', req.params.id);
  res.json({ success: true });
});

app.delete('/api/tariffs/:id', (req, res) => {
  db.prepare('DELETE FROM tariffs WHERE id=?').run(req.params.id);
  res.json({ success: true });
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

  let netto = 0;
  const details = {};

  if (meter.type === 'wasser') {
    details['Frischwasser']           = { value: consumption * tariff.working_price,      unit: `${consumption.toFixed(3)} m³ × ${tariff.working_price} €/m³` };
    details['Abwasser/Entsorgung']    = { value: consumption * tariff.sewage_price,        unit: `${consumption.toFixed(3)} m³ × ${tariff.sewage_price} €/m³` };
    details['Grundgebühr (anteilig)'] = { value: tariff.base_price * days / 30,            unit: `${tariff.base_price} €/Mon × ${days} Tage` };
    if (tariff.other_levies) details['Sonstiges'] = { value: consumption * tariff.other_levies, unit: '' };
  } else {
    details['Arbeitspreis']              = { value: consumption * tariff.working_price / 100,        unit: `${consumption.toFixed(3)} ${meter.unit} × ${tariff.working_price} ct` };
    details['Grundpreis (anteilig)']     = { value: tariff.base_price * days / 30,                  unit: `${tariff.base_price} €/Mon × ${days} Tage` };
    details['Netzentgelt Arbeit']        = { value: consumption * tariff.grid_working_price / 100,   unit: `${consumption.toFixed(3)} ${meter.unit} × ${tariff.grid_working_price} ct` };
    details['Netzentgelt Grundpreis']    = { value: tariff.grid_base_price * days / 30,              unit: `${tariff.grid_base_price} €/Mon × ${days} Tage` };
    details['Messstellenentgelt']        = { value: tariff.meter_fee * days / 30,                    unit: `${tariff.meter_fee} €/Mon × ${days} Tage` };
    if (tariff.other_levies) details['Sonstige Umlagen'] = { value: consumption * tariff.other_levies / 100, unit: `${consumption.toFixed(3)} ${meter.unit} × ${tariff.other_levies} ct` };
  }

  netto = Object.values(details).reduce((s, d) => s + d.value, 0);
  const tax   = netto * tariff.tax_rate / 100;
  const brutto = netto + tax;

  res.json({ consumption, days, meter, from: rFrom, to: rTo, tariff, cost: { netto, tax, brutto, taxRate: tariff.tax_rate, details } });
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
        if (meter.type === 'wasser') {
          details['Frischwasser']  = consumption * tariff.working_price;
          details['Abwasser']      = consumption * tariff.sewage_price;
          details['Grundgebühr']   = tariff.base_price * days / 30;
          if (tariff.other_levies) details['Sonstiges'] = consumption * tariff.other_levies;
        } else {
          details['Arbeitspreis']         = consumption * tariff.working_price / 100;
          details['Grundpreis']           = tariff.base_price * days / 30;
          details['Netzentgelt Arbeit']   = consumption * tariff.grid_working_price / 100;
          details['Netzentgelt Grund']    = tariff.grid_base_price * days / 30;
          details['Messstellenentgelt']   = tariff.meter_fee * days / 30;
          if (tariff.other_levies) details['Sonstige Umlagen'] = consumption * tariff.other_levies / 100;
        }
        const netto  = Object.values(details).reduce((s, v) => s + v, 0);
        const tax    = netto * tariff.tax_rate / 100;
        const brutto = netto + tax;
        cost = { netto, tax, brutto, taxRate: tariff.tax_rate, details };
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
  res.json({ stats, latest });
});

app.listen(PORT, '0.0.0.0', () => console.log(`✓ Energietracker läuft auf Port ${PORT}`));
