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

async function main() {
  const target = new URL(suppliedUrl);
  requireTrue(['http:', 'https:'].includes(target.protocol), 'QA URL must use HTTP or HTTPS');
  requireTrue(!target.username && !target.password && !target.search && !target.hash,
    'QA URL must not contain credentials, query parameters or a fragment');
  requireTrue(target.pathname === '/', 'QA URL must identify the Site root');
  requireTrue(!/[\r\n]/.test(token), 'QA token must be a single header value');
  const origin = target.origin;
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  output = path.join(project, 'outputs', `speed-weather-qa-${local ? 'local' : 'hosted'}-${stamp}`);
  fs.mkdirSync(output, {recursive: true});

  // Explicit manual redirects prevent a bearer header following a response to
  // another origin. Browser requests receive the same boundary below. Neither
  // API response bodies, headers nor the token are saved in QA artifacts.
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

  const api = JSON.parse((await getBytes('/api/ledger', 16 * 1024 * 1024)).toString('utf8'));
  const weather = api.analysis?.find(row => row.id === 'weather-current');
  requireTrue(weather?.ledger_sha256 === api.ledger?.ledger_sha256,
    'weather-current must match the real evaluated requirements snapshot');
  const data = weather?.summary;
  requireTrue(data?.summary?.case_count === 441 && data.kinematic_cases?.length === 441,
    'Expected the actual 441-case weather study');
  requireTrue(data.monitor_demonstrations?.length === 15,
    'Expected the actual 15 receive-only monitor cases');
  requireTrue(data.flight_ready === false && data.hardware_outputs === false &&
    data.summary.top_speed_qualified === false && data.gates.top_speed_qualified === false,
    'Weather view must preserve unqualified capability and receive-only scope');
  requireTrue(data.monitor_demonstrations.every(row =>
    row.flight_authorization === false && row.hardware_outputs === false),
    'A monitor example must never authorize flight or produce hardware outputs');

  const expectedCase = data.kinematic_cases.find(row =>
    row.pressure_altitude_m === 0 && row.ambient_temperature_c === -10 &&
    row.gust_id === 'adverse_sensitivity' && row.baseline_tas_m_s === 45);
  requireTrue(expectedCase && Math.abs(expectedCase.dynamic_pressure_pa - 2632.455328231742) < 1e-6,
    'Cold sea-level combined-gust pressure does not match the evaluated calculation');

  const browser = await webkit.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100},
    serviceWorkers: 'block'});
  const errors = [];
  const consoleErrors = [];
  const blockedOrigins = new Set();
  const result = {passed: false, browser: 'WebKit', url: origin,
    authentication_supplied: Boolean(token), snapshot: api.ledger.ledger_sha256,
    weather_study_id: data.study_id};
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
      // Do not use continue({headers}): Playwright can carry an override through
      // redirects. Resolve bounded same-origin redirects explicitly; never let
      // the client forward the credential to an unverified location.
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
    await page.getByRole('button', {name: /Speed & weather/}).click();
    await page.getByRole('heading', {name: 'Speed & weather', exact: true}).waitFor();

    const count = await page.getByText('Air/gust cases', {exact: true})
      .locator('xpath=..').locator('strong').innerText();
    requireTrue(count.trim() === '441', 'Displayed air/gust count differs from real study');
    const monitor = page.locator('section.panel').filter({has:
      page.getByRole('heading', {name: 'Receive-only diagnostic cases', exact: true})});
    requireTrue(await monitor.locator('.issue').count() === 15,
      'Displayed monitor row count differs from the real study');
    requireTrue(await page.getByText('Top speed unqualified', {exact: true}).isVisible(),
      'Unqualified top-speed status must remain visible');

    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.main .asset-grid img')];
      return images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0);
    }, null, {timeout: 30000});
    const images = await page.locator('.main .asset-grid img').evaluateAll(nodes =>
      nodes.map(image => ({path: new URL(image.currentSrc).pathname,
        width: image.naturalWidth, height: image.naturalHeight})));
    requireTrue(['/assets/speed-root.png', '/assets/speed-support.png', '/assets/speed-root-stress.png']
      .every(asset => images.some(image => image.path === asset)),
    'Expected all three real current CAD/support/FEA images');

    async function screenshot(name) {
      // Refuse artifact capture if an unexpected response put the credential in
      // document content. The credential is never supplied to page scripts.
      if (token) {
        const html = await page.content();
        requireTrue(!html.includes(token), 'Credential unexpectedly appeared in document; capture refused');
      }
      await page.screenshot({path: path.join(output, name), fullPage: true});
    }
    await screenshot('speed-weather-desktop.png');
    await page.getByLabel('Pressure altitude', {exact: true}).selectOption('0');
    await page.getByLabel('Ambient temperature', {exact: true}).selectOption('-10');
    await page.getByLabel('Gust case', {exact: true}).selectOption('adverse_sensitivity');
    await page.getByLabel('Baseline true airspeed', {exact: true}).selectOption('45');
    await page.waitForFunction(expected => {
      const text = document.querySelector('[data-testid="weather-q"]')?.textContent || '';
      return Math.abs(parseFloat(text) - expected) < 0.051;
    }, expectedCase.dynamic_pressure_pa);
    const displayedPressure = await page.getByTestId('weather-q').innerText();
    requireTrue(displayedPressure.trim() === '2632.5 Pa', 'Pressure display must round to one decimal Pa');
    await screenshot('speed-weather-cold-gust.png');

    const downloaded = await getBytes('/assets/speed-roots.step', 32 * 1024 * 1024);
    const localStep = fs.readFileSync(path.join(project, 'public/assets/speed-roots.step'));
    const downloadedHash = digest(downloaded);
    requireTrue(downloadedHash === digest(localStep), 'Downloaded STEP differs from the actual packaged local asset');

    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('heading', {name: 'Speed & weather', exact: true}).waitFor();
    const overflow = await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1);
    requireTrue(!overflow, 'Mobile speed/weather page overflows horizontally');
    await screenshot('speed-weather-mobile.png');
    requireTrue(errors.length === 0, 'Browser runtime errors detected');
    requireTrue(consoleErrors.length === 0, 'Browser console errors detected');

    const final = JSON.parse((await getBytes('/api/ledger', 16 * 1024 * 1024)).toString('utf8'));
    const finalWeather = final.analysis?.find(row => row.id === 'weather-current');
    requireTrue(final.ledger?.ledger_sha256 === api.ledger.ledger_sha256 &&
      finalWeather?.ledger_sha256 === api.ledger.ledger_sha256 &&
      finalWeather.summary.study_id === data.study_id,
    'Evaluated snapshot changed during browser QA');
    Object.assign(result, {passed: true, real_weather_current_readback: true,
      air_gust_cases: 441, monitor_rows: 15, selectors_verified: true,
      calculated_dynamic_pressure_pa: expectedCase.dynamic_pressure_pa,
      displayed_dynamic_pressure: displayedPressure, images,
      step_download_sha256: downloadedHash, step_download_bytes: downloaded.length,
      step_matches_local_packaged_asset: true, mobile_viewport: {width: 390, height: 844},
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
