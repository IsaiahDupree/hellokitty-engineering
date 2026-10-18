// Read-only QA against the actual evaluated database view and packaged CAD.
// Tokens stay in memory and are sent only to the explicitly selected origin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const project = path.resolve(__dirname, '..');
const suppliedUrl = process.env.SITE_QA_URL || 'http://127.0.0.1:5173/';
const token = process.env.SITE_QA_TOKEN || '';
const clean = value => String(value).split(token || '\u0000unused-token').join('[redacted]');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let output;

function requireTrue(value, message) {
  if (!value) throw new Error(message);
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assetPath(asset) {
  requireTrue(asset && typeof asset.file === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.file), 'Asset must be a single bounded file name');
  requireTrue(/^[a-f0-9]{64}$/.test(asset.sha256), 'Every QA asset requires its actual SHA256');
  return '/assets/' + asset.file;
}

async function main() {
  const target = new URL(suppliedUrl);
  requireTrue(['http:', 'https:'].includes(target.protocol), 'QA URL must use HTTP or HTTPS');
  requireTrue(!target.username && !target.password && !target.search && !target.hash,
    'QA URL must not contain credentials, query parameters or a fragment');
  requireTrue(target.pathname === '/', 'QA URL must identify the Site root');
  requireTrue(!/[\r\n]/.test(token), 'QA token must be a single header value');
  const origin = target.origin;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  output = path.join(project, 'outputs', `airfoil-modular-qa-${local ? 'local' : 'hosted'}-${stamp}`);
  fs.mkdirSync(output, {recursive: true});

  async function getBytes(relative, maximumBytes) {
    const url = new URL(relative, origin);
    requireTrue(url.origin === origin, 'Cross-origin QA fetch refused');
    const headers = token ? {'OAI-Sites-Authorization': `Bearer ${token}`} : {};
    const response = await fetch(url, {headers, redirect: 'manual',
      signal: AbortSignal.timeout(30000)});
    requireTrue(response.status === 200, `Same-origin ${url.pathname} returned HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    requireTrue(!length || length <= maximumBytes, `Oversized ${url.pathname} response`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      requireTrue(bytes <= maximumBytes, `Oversized ${url.pathname} response`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'app/airfoil-assets.json'), 'utf8'));
  requireTrue(/^[a-f0-9]{64}$/.test(manifest.native_summary_sha256), 'Native summary pin is missing');
  requireTrue(typeof manifest.native_job_id === 'string' && manifest.native_job_id.startsWith('mdl_'),
    'Actual native job identity is required');
  requireTrue(Array.isArray(manifest.images) && manifest.images.length >= 3, 'At least three actual CAD pictures are required');
  requireTrue(Array.isArray(manifest.downloads) && manifest.downloads.some(asset => /\.step$/i.test(asset.file)),
    'An actual STEP download is required');
  const allAssets = [...manifest.images, ...manifest.downloads];
  const assetUrls = allAssets.map(assetPath);
  requireTrue(new Set(assetUrls).size === assetUrls.length, 'Asset file names must be unique');
  for (const asset of allAssets) {
    const packaged = fs.readFileSync(path.join(project, 'public/assets', asset.file));
    requireTrue(digest(packaged) === asset.sha256, 'Packaged CAD asset differs from its declared hash: ' + asset.file);
  }

  const api = JSON.parse((await getBytes('/api/ledger', 16 * 1024 * 1024)).toString('utf8'));
  const current = api.analysis?.find(row => row.id === 'airfoil-modular-current');
  requireTrue(current?.ledger_sha256 === api.ledger?.ledger_sha256,
    'Candidate view must match the real evaluated requirements snapshot');
  requireTrue(api.ledger?.counts?.stale === 0 && api.ledger.evidence?.every(row => row.fresh === true),
    'The displayed candidate must have current source-bound evidence');
  const data = current?.summary;
  const aero = data?.airfoil;
  const study = aero?.summary || aero;
  const cad = data?.cad;
  requireTrue(study?.profile_count === 4 && study.regime_case_count === 5292,
    'Expected four geometric profiles and the actual 5292 flow-similarity coordinates');
  requireTrue(aero?.sampled_root_installation?.length === 8 && aero.wing_stations?.length === 10,
    'Expected eight actual root screens and ten actual section stations');
  requireTrue(new Set(aero.sampled_root_installation.map(row => row.profile)).size === 4,
    'The actual four profile alternatives must be represented');
  requireTrue(data.flight_ready === false && data.hardware_outputs === false &&
    data.baseline_analyses_qualify_candidate === false &&
    study.aerodynamic_performance_comparison_completed === false &&
    study.selected_airfoil_for_flight === false,
    'Geometry/software evidence must preserve unqualified aerodynamic performance and receive-only scope');
  requireTrue(Object.values(aero.qualification_gates || {}).length >= 9 &&
    Object.values(aero.qualification_gates).every(value => value === 'open'),
    'Airfoil qualification gates must remain explicitly open');
  requireTrue(data.native_summary_sha256 === manifest.native_summary_sha256 &&
    cad?.native_job_id === manifest.native_job_id,
    'Actual native summary/job differs from the packaged asset manifest');
  const nativePin = current.source_bindings?.find(row => row.path === 'artifacts/airfoil-modular-cad/summary.json');
  requireTrue(nativePin?.sha256 === manifest.native_summary_sha256,
    'Native summary hash must be in the actual database view source closure');
  for (const recordId of ['analysis-current', 'integration-current', 'weather-current']) {
    const prior = api.analysis.find(row => row.id === recordId);
    requireTrue(prior?.ledger_sha256 === api.ledger.ledger_sha256 &&
      prior.candidate_applicability === 'retained_baseline_only' &&
      prior.candidate_qualification_transferred === false,
      'Prior evidence must remain labelled baseline-only: ' + recordId);
  }

  const browser = await webkit.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}, serviceWorkers: 'block'});
  const errors = [];
  const consoleErrors = [];
  const blockedOrigins = new Set();
  const result = {passed: false, browser: 'WebKit', url: origin,
    authentication_supplied: Boolean(token), snapshot: api.ledger.ledger_sha256,
    native_summary_sha256: manifest.native_summary_sha256, native_job_id: manifest.native_job_id};
  let page;
  try {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        blockedOrigins.add(url.origin);
        await route.abort('blockedbyclient');
        return;
      }
      const headers = {...request.headers()};
      delete headers.authorization;
      delete headers['oai-sites-authorization'];
      if (token) headers['OAI-Sites-Authorization'] = `Bearer ${token}`;
      // Fetch each redirect manually. A bearer override must never be carried
      // by Playwright into an unverified cross-origin redirect destination.
      try {
        let destination = url;
        let response;
        for (let hop = 0; hop < 4; hop++) {
          response = await route.fetch({url: destination.href, headers, maxRedirects: 0, timeout: 30000});
          if (response.status() < 300 || response.status() >= 400) break;
          const location = response.headers().location;
          requireTrue(location, 'Redirect has no location');
          const next = new URL(location, destination);
          if (next.origin !== origin) {
            blockedOrigins.add(next.origin);
            throw new Error(`Cross-origin redirect refused for ${url.pathname}`);
          }
          requireTrue(hop < 3, 'Same-origin redirect limit exceeded');
          destination = next;
        }
        await route.fulfill({response});
      } catch (error) {
        errors.push(clean(`Same-origin request failed: ${error.message}`));
        await route.abort('failed');
      }
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(clean(error.message)));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(clean(message.text()));
    });
    page.setDefaultTimeout(20000);
    await page.goto(origin, {waitUntil: 'domcontentloaded', timeout: 30000});
    await page.getByRole('heading', {name: 'Engineering overview', exact: true}).waitFor();
    await page.getByRole('button', {name: /Airfoil & modules/}).click();
    await page.getByRole('heading', {name: 'Airfoil & modules', exact: true}).waitFor();
    requireTrue(await page.getByText('Aerodynamic performance open', {exact: true}).isVisible(),
      'Unqualified aerodynamic performance must stay visible');
    requireTrue(await page.locator('.hero-note').filter({hasText: 'Earlier CAD, stress and weather views retain their original geometry'}).isVisible(),
      'Prior-geometry baseline banner must remain visible');
    requireTrue((await page.getByText('Profiles compared geometrically', {exact: true})
      .locator('xpath=..').locator('strong').innerText()).trim() === '4', 'Displayed profile count differs');
    requireTrue((await page.getByText('Reynolds / Mach coordinates', {exact: true})
      .locator('xpath=..').locator('strong').innerText()).trim() === '5292', 'Displayed regime count differs');
    const sectionPanel = page.locator('section.panel').filter({has:
      page.getByRole('heading', {name: 'Why this wing section?', exact: true})});
    const rootsTable = sectionPanel.locator('table').first();
    requireTrue(await rootsTable.locator('tbody tr').count() === 8, 'Displayed root screen must contain eight rows');
    for (const row of aero.sampled_root_installation) {
      const matches = rootsTable.locator('tbody tr').filter({hasText: 'NACA ' + row.profile}).filter({hasText: row.wing});
      requireTrue(await matches.count() === 1, 'Displayed root row does not match the actual study');
      requireTrue((await matches.locator('td').nth(2).innerText()).trim() ===
        (row.minimum_sampled_vertical_reserve_m * 1000).toFixed(2) + ' mm',
        'Displayed root reserve differs from its actual sampled result');
      requireTrue((await matches.locator('td').nth(3).innerText()).trim() ===
        (row.sampled_pass ? 'SAMPLED FIT' : 'INSUFFICIENT SAMPLED RESERVE'),
        'Displayed root status differs from its actual sampled result');
    }
    await page.getByText('Spanwise section dimensions', {exact: true}).click();
    const stationsTable = sectionPanel.locator('details table');
    requireTrue(await stationsTable.locator('tbody tr').count() === 10, 'Displayed section table must contain ten real stations');
    for (const station of aero.wing_stations) {
      const row = stationsTable.locator('tbody tr').filter({hasText: station.wing + ' · ' + station.station_id});
      requireTrue(await row.count() === 1, 'Displayed station is missing or duplicated');
      requireTrue((await row.locator('td').nth(1).innerText()).trim() ===
        (station.chord_m * 1000).toFixed(1) + ' mm', 'Displayed chord differs from actual CAD contract');
    }
    await page.waitForFunction(expected => {
      const images = [...document.querySelectorAll('.main .asset-grid img')];
      return images.length === expected && images.every(image => image.complete && image.naturalWidth > 0);
    }, manifest.images.length, {timeout: 30000});
    const images = await page.locator('.main .asset-grid img').evaluateAll(nodes =>
      nodes.map(image => ({path: new URL(image.currentSrc).pathname, width: image.naturalWidth, height: image.naturalHeight})));
    requireTrue(manifest.images.every(asset => images.some(image => image.path === '/assets/' + asset.file)),
      'All actual packaged CAD pictures must be displayed');

    async function screenshot(name) {
      if (token) requireTrue(!(await page.content()).includes(token),
        'Credential unexpectedly appeared in document; capture refused');
      await page.screenshot({path: path.join(output, name), fullPage: true});
    }
    await screenshot('airfoil-modular-desktop.png');

    const assetResults = [];
    for (const asset of allAssets) {
      const fetched = await getBytes(assetPath(asset), 64 * 1024 * 1024);
      const actualHash = digest(fetched);
      requireTrue(actualHash === asset.sha256, 'Downloaded CAD asset differs from the actual packaged file: ' + asset.file);
      assetResults.push({file: asset.file, bytes: fetched.length, sha256: actualHash});
    }
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('heading', {name: 'Airfoil & modules', exact: true}).waitFor();
    const overflow = await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1);
    requireTrue(!overflow, 'Mobile airfoil/modules page overflows horizontally');
    await screenshot('airfoil-modular-mobile.png');
    requireTrue(errors.length === 0, 'Browser runtime errors detected');
    requireTrue(consoleErrors.length === 0, 'Browser console errors detected');
    const final = JSON.parse((await getBytes('/api/ledger', 16 * 1024 * 1024)).toString('utf8'));
    const finalCurrent = final.analysis?.find(row => row.id === 'airfoil-modular-current');
    requireTrue(final.ledger?.ledger_sha256 === api.ledger.ledger_sha256 &&
      finalCurrent?.ledger_sha256 === current.ledger_sha256 &&
      JSON.stringify(finalCurrent) === JSON.stringify(current),
      'Evaluated snapshot or candidate view changed during browser QA');
    Object.assign(result, {passed: true, real_candidate_current_readback: true,
      profile_count: 4, flow_similarity_coordinates: 5292, root_rows: 8, station_rows: 10,
      native_summary_pin_matches: true, prior_baseline_banner_visible: true,
      prior_qualification_transferred: false, images, downloaded_assets: assetResults,
      all_downloads_match_packaged_hashes: true, mobile_viewport: {width: 390, height: 844},
      mobile_horizontal_overflow: false, browser_errors: errors, console_errors: consoleErrors,
      blocked_cross_origin_request_origins: [...blockedOrigins],
      source_mutations: false, hardware_outputs: false, flight_authorization: false});
  } catch (error) {
    Object.assign(result, {error: clean(error.message), browser_errors: errors,
      console_errors: consoleErrors, blocked_cross_origin_request_origins: [...blockedOrigins]});
    throw error;
  } finally {
    await context.close();
    await browser.close();
    fs.writeFileSync(path.join(output, 'verification.json'), clean(JSON.stringify(result, null, 2)) + '\n');
  }
  console.log(clean(JSON.stringify({...result, output: path.relative(project, output)}, null, 2)));
}

main().catch(error => {
  const failure = {passed: false, error: clean(error.message)};
  if (output) {
    const file = path.join(output, 'verification.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, clean(JSON.stringify(failure, null, 2)) + '\n');
  }
  console.error(clean(JSON.stringify(failure)));
  process.exitCode = 1;
});
