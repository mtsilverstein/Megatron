// Shared controllers must not diverge merely because navigation changes pages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const site = path.join(__dirname, '..', 'site');
const pages = ['index.html', 'weekly.html', 'waivers.html', 'trade.html', 'about.html', 'connect.html'];
const sources = pages.map(page => ({page, html:fs.readFileSync(path.join(site, page), 'utf8')}));
for (const file of ['app.js', 'waivermode.js']) {
  const urls = sources.flatMap(({html}) => [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)]
    .map(m => m[1]).filter(src => src.split('?')[0] === `assets/${file}`));
  assert.ok(urls.length >= 2, `${file}: expected shared consumers`);
  assert.equal(new Set(urls).size, 1, `${file}: inconsistent cache versions across pages`);
}
for (const {page, html} of sources) {
  assert.equal((html.match(/src="assets\/app\.js(?:\?[^"]*)?"/g) || []).length, 1,
    `${page}: exactly one shared app script required`);
}
console.log('shared_assets_fixture: shared controller versions and single app inclusion OK');
