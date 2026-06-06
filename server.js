require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

console.log('DATABASE_URL is:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  console.log('Connecting to DB...');
  const client = await pool.connect();
  console.log('Connected! Creating table...');
  await client.query(`
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
  client.release();
  console.log('DB ready!');
}

app.get('/api/startups', async (req, res) => {
  const { q } = req.query;
  try {
    const result = q
      ? await pool.query(`SELECT * FROM startups WHERE name ILIKE $1 OR domain ILIKE $1 ORDER BY created_at DESC`, [`%${q}%`])
      : await pool.query(`SELECT * FROM startups ORDER BY created_at DESC`);
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
  console.error('Full error:', JSON.stringify(err, null, 2));
  process.exit(1);
});
