require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS startups (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      domain     TEXT UNIQUE NOT NULL,
      description TEXT,
      country    TEXT,
      stage      TEXT,
      funding    TEXT,
      tags       TEXT,
      website    TEXT,
      source     TEXT DEFAULT 'manual',
      enriched   BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB ready');
}

app.get('/api/startups', async (req, res) => {
  const { q } = req.query;
  try {
    let result;
    if (q) {
      result = await pool.query(
        `SELECT * FROM startups WHERE name ILIKE $1 OR domain ILIKE $1 ORDER BY created_at DESC`,
        [`%${q}%`]
      );
    } else {
      result = await pool.query(`SELECT * FROM startups ORDER BY created_at DESC`);
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/startups', async (req, res) => {
  const { name, domain } = req.body;
  if (!name || !domain) return res.status(400).json({ error: 'name and domain are required' });
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  try {
    const result = await pool.query(
      `INSERT INTO startups (name, domain) VALUES ($1, $2) RETURNING *`,
      [name.trim(), clean]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Domain already registered' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/startups/:id/enrich', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(`SELECT * FROM startups WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const startup = rows[0];
    const apiKey = process.env.CRUNCHBASE_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'CRUNCHBASE_API_KEY not set' });
    const axios = require('axios');
    const response = await axios.post(
      'https://api.crunchbase.com/api/v4/searches/organizations',
      {
        field_ids: ['identifier', 'short_description', 'funding_total', 'last_funding_type', 'location_identifiers', 'categories', 'website_url'],
        query: [{ type: 'predicate', field_id: 'domain_name', operator_id: 'eq', values: [startup.domain] }],
        limit: 1
      },
      { headers: { 'X-cb-user-key': apiKey } }
    );
    const org = response.data?.entities?.[0];
    if (!org) return res.status(404).json({ error: 'Not found on Crunchbase' });
    const p = org.properties;
    const country = p.location_identifiers?.find(l => l.location_type === 'country')?.value || null;
    const funding = p.funding_total?.value_usd ? `$${(p.funding_total.value_usd / 1e6).toFixed(1)}M` : null;
    const tags = (p.categories || []).map(c => c.value).slice(0, 4).join(', ') || null;
    const updated = await pool.query(
      `UPDATE startups SET description=COALESCE($2,description), country=COALESCE($3,country), stage=COALESCE($4,stage), funding=COALESCE($5,funding), tags=COALESCE($6,tags), website=COALESCE($7,website), enriched=TRUE WHERE id=$1 RETURNING *`,
      [id, p.short_description, country, p.last_funding_type, funding, tags, p.website_url]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/startups/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM startups WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 4000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
