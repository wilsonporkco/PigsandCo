#!/usr/bin/env node
// ============================================================
// Pigs & Co — Swickers Kill Data Auto-Fetch
// Logs into swickers.com.au, downloads kill data for the
// target date, parses it, and upserts to Supabase
// (kill_pigs + kill_organs tables used by the Pigs & Co app).
//
// Secrets required (GitHub repo → Settings → Secrets):
//   PIGSCO_SUPABASE_SERVICE_KEY  — service role key for ekegmhvwtgabwnkadpow
//
// Swickers credentials are read from the Supabase table:
//   swickers_config  (columns: key text, value text)
//   rows needed:     username | <swickers username>
//                    password | <swickers password>
//
// Optional env var / Actions input:
//   KILL_DATE  — YYYY-MM-DD, defaults to today (Brisbane time)
// ============================================================

try { require('dotenv').config({ path: __dirname + '/.env' }); } catch(e) {}

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL         = 'https://ekegmhvwtgabwnkadpow.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.PIGSCO_SUPABASE_SERVICE_KEY;
const SWICKERS_DASHBOARD   = 'https://www.swickers.com.au/killdata/dashboard.aspx';
const DOWNLOAD_DIR         = path.join(os.homedir(), 'Downloads', 'pigsco-auto');

// ── Helpers ───────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  console.log(`[${ts}] ${msg}`);
}

function todayStr() {
  const now = new Date();
  const bne = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
  const y = bne.getFullYear();
  const m = String(bne.getMonth() + 1).padStart(2, '0');
  const d = String(bne.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Parse a standard Swickers CSV export
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"')      { inQ = !inQ; }
      else if (line[i] === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else                      { cur += line[i]; }
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] !== undefined ? vals[i] : '').trim(); });
    return obj;
  });
}

// Build kill_pigs + kill_organs rows from parsed CSV rows.
// Logic mirrors the app's parseKillData() so data is identical
// whether uploaded manually or auto-fetched.
function buildKillRows(rows) {
  const killStore  = {};   // pig_key → kill_pigs row
  const organStore = {};   // pig_key → [kill_organs rows]

  for (const r of rows) {
    const tattoo   = (r.tattoo   || '').trim();
    const bodyno   = (r.bodyno   || '').trim();
    const organ    = (r.organ    || '').trim();
    const hscw     = parseFloat(r.hscw)  || 0;
    const p2       = parseFloat(r.p2fat) || 0;
    const sex      = (r.sex      || '').trim();
    const kdate    = (r.killdate || '').trim();
    const name     = (r.name     || '').trim();
    const carctype = (r.carcasetype || '').trim();
    const orgdesc  = (r.organdesc   || '').trim();

    if (!tattoo || !bodyno) continue;

    // Unique pig key — must match the app's formula exactly
    const pigKey = `${bodyno}|${sex}|${hscw}|${tattoo}`;

    if (organ) {
      // Organ/condemn row — ensure the parent pig record exists
      if (!killStore[pigKey]) {
        killStore[pigKey] = { pig_key: pigKey, bodyno, tattoo, name, hscw, p2, sex, kdate, carctype };
      }
      if (!organStore[pigKey]) organStore[pigKey] = [];
      if (!organStore[pigKey].find(o => o.organ === organ)) {
        organStore[pigKey].push({ pig_key: pigKey, organ, description: orgdesc });
      }
    } else {
      killStore[pigKey] = { pig_key: pigKey, bodyno, tattoo, name, hscw, p2, sex, kdate, carctype };
    }
  }

  return { killStore, organStore };
}

// Upsert rows in chunks to stay under Supabase payload limits
async function upsertChunked(sb, table, rows, onConflict, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await sb.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`${table} upsert error: ${error.message}`);
  }
}

async function insertChunked(sb, table, rows, chunkSize = 500) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await sb.from(table).insert(chunk);
    if (error) throw new Error(`${table} insert error: ${error.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  if (!SUPABASE_SERVICE_KEY) {
    log('ERROR: PIGSCO_SUPABASE_SERVICE_KEY env var not set.');
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1. Fetch Swickers credentials from Supabase
  log('Fetching Swickers credentials from Supabase...');
  const { data: configRows, error: configErr } = await sb
    .from('swickers_config')
    .select('key, value');

  if (configErr || !configRows) {
    log('ERROR: Could not read swickers_config: ' + (configErr?.message || 'no data'));
    process.exit(1);
  }

  const config = {};
  configRows.forEach(r => { config[r.key] = r.value; });

  if (!config.username || !config.password) {
    log('ERROR: swickers_config missing username or password rows.');
    process.exit(1);
  }

  // 2. Determine target date
  const targetDate = (process.env.KILL_DATE || '').trim() || todayStr();
  log(`Target kill date: ${targetDate}`);

  // 3. Launch browser and download CSV
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  log('Launching headless browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    httpCredentials: { username: config.username, password: config.password },
  });
  const page = await context.newPage();

  let savePath = null;

  try {
    log('Navigating to Swickers dashboard...');
    await page.goto(SWICKERS_DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Format date as DD-Mon-YYYY to match the page display
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const [yyyy, mm, dd] = targetDate.split('-');
    const pageDate = `${dd}-${MONTHS[parseInt(mm, 10) - 1]}-${yyyy}`;
    log(`Looking for row: ${pageDate}`);

    // Log visible rows for debugging
    const allRows = await page.$$eval('tr', rows =>
      rows.map(r => r.innerText.trim().replace(/\s+/g, ' ')).filter(t => t.length > 0)
    );
    log('First 10 rows: ' + JSON.stringify(allRows.slice(0, 10)));

    // Find the download button for the target date
    const buttons = await page.$$('input[type=image]');
    log(`Found ${buttons.length} image button(s) on page`);

    let downloadBtn = null;
    for (const btn of buttons) {
      const row    = await btn.evaluateHandle(el => el.closest('tr'));
      const rowTxt = await row.evaluate(el => el ? el.innerText : '');
      if (rowTxt.includes(pageDate)) {
        const name = await btn.getAttribute('name') || '';
        if (!downloadBtn || name < (await downloadBtn.getAttribute('name') || '')) {
          downloadBtn = btn;
        }
      }
    }

    if (!downloadBtn) {
      log(`No download button found for ${pageDate} — data may not be available yet.`);
      await browser.close();
      process.exit(0);
    }

    log('Clicking download button...');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 300000 }),
      downloadBtn.click({ noWaitAfter: true, timeout: 30000 }),
    ]);

    const filename = download.suggestedFilename();
    savePath = path.join(DOWNLOAD_DIR, filename);
    await download.saveAs(savePath);
    log(`Downloaded: ${filename}`);

  } finally {
    await browser.close();
  }

  if (!savePath || !fs.existsSync(savePath)) {
    log('ERROR: No file was saved.');
    process.exit(1);
  }

  // 4. Parse CSV
  log('Parsing CSV...');
  const text = fs.readFileSync(savePath, 'utf-8');
  const csvRows = parseCSV(text);
  log(`CSV rows: ${csvRows.length}`);

  if (!csvRows.length) {
    log('No rows found in file. Exiting.');
    fs.unlinkSync(savePath);
    process.exit(0);
  }

  const { killStore, organStore } = buildKillRows(csvRows);
  const pigRows   = Object.values(killStore);
  const organKeys = Object.keys(organStore);
  log(`Pig records: ${pigRows.length}  |  Organ records: ${organKeys.reduce((n, k) => n + organStore[k].length, 0)}`);

  // 5. Upsert kill_pigs
  if (pigRows.length) {
    log('Upserting kill_pigs...');
    await upsertChunked(sb, 'kill_pigs', pigRows, 'pig_key');
  }

  // 6. Replace kill_organs for affected pigs (delete + re-insert)
  if (organKeys.length) {
    log('Replacing kill_organs...');
    const { error: delErr } = await sb.from('kill_organs').delete().in('pig_key', organKeys);
    if (delErr) throw new Error('kill_organs delete error: ' + delErr.message);
    const organRows = organKeys.flatMap(k => organStore[k]);
    await insertChunked(sb, 'kill_organs', organRows);
  }

  log(`Done. ${pigRows.length} pigs upserted for ${targetDate}.`);

  // 7. Clean up downloaded file
  fs.unlinkSync(savePath);
})().catch(err => {
  log('FATAL: ' + err.message);
  process.exit(1);
});
