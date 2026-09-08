import { chromium } from 'playwright';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage();
const fouten = [];
page.on('console', m => { if (m.type() === 'error') fouten.push(m.text()); });
page.on('pageerror', e => fouten.push('pageerror: ' + e.message));

// Config vooraf zetten zoals een collega hem na Instellingen zou hebben.
await page.addInitScript(() => {
  localStorage.setItem('dpf_github_cfg', JSON.stringify({
    owner: 'agostinodpf', repo: 'Hs-tool', token: '', naam: 'Agostino',
    proxy: 'http://127.0.0.1:8788', apptoken: '',
  }));
  localStorage.setItem('dpf_role', 'logistiek');
});
await page.goto('http://localhost:8080/index.html');
await page.waitForTimeout(600);

// Naar het toevoegen-tabblad.
await page.evaluate(() => tab('padd', document.getElementById('nbadd')));
await page.waitForTimeout(200);

console.log('landen in AI-select:', await page.locator('#aioors option').count());
console.log('standaard oorsprong :', await page.locator('#aioors').inputValue());

// 1. Zonder oorsprong moet hij weigeren.
await page.fill('#aidesc', 'bamboe dienblad met handvatten');
await page.selectOption('#aioors', '');
await page.click('#aibtn');
await page.waitForTimeout(400);
console.log('zonder oorsprong    :', (await page.locator('#aires').innerText()).slice(0, 70));

// 2. Met oorsprong: volledige keten.
await page.selectOption('#aioors', 'CN');
await page.fill('#aimat', 'bamboe');
await page.click('#aibtn');
await page.waitForSelector('#aires button', { timeout: 15000 });
const res = await page.locator('#aires').innerText();
console.log('--- resultaatpaneel ---');
console.log(res);

// 3. Overnemen in formulier.
await page.click('#aires button');
await page.waitForTimeout(300);
const f = await page.evaluate(() => ({
  taric: document.getElementById('ftaric').value,
  naam: document.getElementById('fnaam').value,
  pct: document.getElementById('fpct').value,
  inv: document.getElementById('finv').value,
  oors: document.getElementById('foors').value,
  datum: document.getElementById('fdatum').value,
  fill: document.getElementById('tacfill').textContent,
}));
console.log('--- formulier na overnemen ---');
console.log(JSON.stringify(f, null, 2));

// 4. Opslaan en de detailweergave controleren.
await page.evaluate(() => addProduct());
await page.waitForTimeout(400);
await page.evaluate(() => { const p = db[db.length - 1]; tab('pzoek', document.getElementById('nbzoek')); showDetail(p.id); });
await page.waitForTimeout(300);
console.log('--- detail ---');
console.log('oorsprong :', await page.locator('#doors').innerText());
console.log('subtekst  :', await page.locator('#doorsd').innerText());
console.log('heffinglbl:', await page.locator('#dtl').innerText());
console.log('opgeslagen:', JSON.stringify(await page.evaluate(() => {
  const p = db[db.length - 1];
  return { naam: p.naam, taric: p.taric, oorsprong: p.oorsprong, percentage: p.percentage, tarief_bron: p.tarief_bron, tarief_datum: p.tarief_datum };
})));

// 5. EU-oorsprong: nu moet er wel een percentage doorstromen, uit een bron.
await page.evaluate(() => tab('padd', document.getElementById('nbadd')));
await page.fill('#aidesc', 'houten fotolijst');
await page.selectOption('#aioors', 'PL');
await page.click('#aibtn');
await page.waitForSelector('#aires button', { timeout: 15000 });
console.log('--- EU-oorsprong ---');
console.log((await page.locator('#aires').innerText()).split('INVOERRECHT')[1]);
await page.click('#aires button');
await page.waitForTimeout(300);
console.log('formulier:', JSON.stringify(await page.evaluate(() => ({
  pct: document.getElementById('fpct').value,
  inv: document.getElementById('finv').value,
  datum: document.getElementById('fdatum').value,
  bron: tariefBron,
}))));

console.log('\nconsole-fouten:', fouten.length ? fouten : 'geen');
await b.close();
