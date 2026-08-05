// tests/sleeper_fixture.cjs — run with: node tests/sleeper_fixture.cjs
const assert = require("assert");
const S = require("../site/assets/sleeper.js");

const calls = [];
global.fetch = (url, opts) => {
  calls.push({ url, opts });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });
};

(async () => {
  await S.get("/league/123/rosters");
  await S.get("/league/123/rosters");
  // Sleeper's CDN keys on the full URL, so two reads of the SAME path must
  // produce two DIFFERENT urls or the second is served from a shared entry
  // measured at Age: 22072 -- six hours stale on a live draft.
  assert.notStrictEqual(calls[0].url, calls[1].url, "repeat reads must not share a URL");
  for (const c of calls) {
    assert.ok(/[?&]_=\d+/.test(c.url), `missing cache key: ${c.url}`);
    assert.strictEqual(c.opts.cache, "no-store", "must bypass the browser HTTP cache too");
    assert.ok(c.url.startsWith("https://api.sleeper.app/v1/"), c.url);
  }
  // A path that already carries a query keeps it, and appends with &.
  calls.length = 0;
  await S.get("/x?a=1");
  assert.ok(/\?a=1&_=\d+/.test(calls[0].url), calls[0].url);

  // A non-ok response throws with the status, so callers can distinguish a
  // 404 (offseason / no such league) from a real failure.
  global.fetch = () => Promise.resolve({ ok: false, status: 404 });
  await assert.rejects(() => S.get("/nope"), /HTTP 404/);

  console.log("sleeper_fixture: OK");
})().catch(e => { console.error("sleeper_fixture: FAILED"); console.error(e); process.exit(1); });
