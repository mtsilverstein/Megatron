// tests/sleeper_fixture.cjs — run with: node tests/sleeper_fixture.cjs
const assert = require("assert");
const S = require("../site/assets/sleeper.js");

const calls = [];
global.fetch = (url, opts) => {
  calls.push({ url, opts });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });
};

/* Deterministic control of the request deadline. `get` resolves `setTimeout`
   at CALL time, so swapping the global lets a test fire the deadline on
   demand instead of waiting 4 real seconds -- and lets it assert the timer
   was cleared, which is the part a wall-clock test cannot see at all. */
const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
let timers = [];
const fakeTimers = () => {
  timers = [];
  global.setTimeout = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  global.clearTimeout = t => { if (t) t.cleared = true; };
};
const realTimers = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };
const lastTimer = () => timers[timers.length - 1];
const tick = () => new Promise(r => realSetTimeout(r, 0));
// A fetch that never settles on its own: only the deadline can end it.
const stalls = opts => new Promise((_, reject) => {
  opts.signal.addEventListener("abort", () => reject(new Error("AbortError")));
});

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

  // --- the request deadline -------------------------------------------------
  // `fetch` has no default timeout, and draftmode's poll loop re-arms only on
  // resolve or reject. A hang reaches neither, so without this the panel dies
  // silently mid-draft and only a reload brings it back.

  // 1. Every request carries a signal, and arms a 4s deadline.
  fakeTimers();
  let seen = null;
  global.fetch = (url, opts) => {
    seen = opts;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) });
  };
  await S.get("/armed");
  assert.ok(seen.signal, "every request must carry an AbortSignal");
  assert.strictEqual(seen.signal.aborted, false, "signal must not start aborted");
  assert.strictEqual(timers.length, 1, "exactly one deadline per request");
  assert.strictEqual(lastTimer().ms, 4000, "deadline must be 4000ms");
  assert.ok(lastTimer().cleared, "a successful request must clear its deadline");

  // 2. Stalled HEADERS reject at the deadline rather than hanging forever.
  timers = [];
  global.fetch = (url, opts) => stalls(opts);
  let pending = S.get("/stalled-headers");
  assert.strictEqual(timers.length, 1, "deadline armed before awaiting fetch");
  assert.ok(!lastTimer().cleared, "deadline must stay armed while the request is in flight");
  lastTimer().fn();                       // fire the deadline
  await assert.rejects(() => pending, /Abort/i, "a stalled fetch must reject");
  assert.ok(lastTimer().cleared, "an aborted request must still clear its deadline");

  // 3. A stalled BODY rejects at the same deadline. Headers arriving is not
  //    proof of life: res.json() can hang just as hard, and it is the same
  //    dead panel. This is why the json() await sits inside the try.
  timers = [];
  global.fetch = (url, opts) => Promise.resolve({
    ok: true, status: 200, json: () => stalls(opts),
  });
  pending = S.get("/stalled-body");
  await tick();                           // let fetch resolve, reach json()
  // The mutation this kills: `return res.json()` without `await` runs the
  // finally -- and so clearTimeout -- before the body settles, leaving a
  // stalled body with no deadline at all.
  assert.ok(!lastTimer().cleared, "deadline must stay armed while the body is pending");
  lastTimer().fn();
  await assert.rejects(() => pending, /Abort/i, "a stalled body must reject");
  assert.ok(lastTimer().cleared, "a body-stalled request must clear its deadline");

  // 4. The deadline is cleared on EVERY exit, not just the happy one. A leaked
  //    timer keeps firing abort() on a controller nobody is listening to, and
  //    in a browser holds the page awake between polls.
  timers = [];
  global.fetch = () => Promise.resolve({ ok: false, status: 503 });
  await assert.rejects(() => S.get("/http-error"), /HTTP 503/);
  assert.ok(lastTimer().cleared, "an HTTP error must clear its deadline");

  timers = [];
  global.fetch = () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.reject(new Error("bad json")),
  });
  await assert.rejects(() => S.get("/bad-json"), /bad json/);
  assert.ok(lastTimer().cleared, "a JSON failure must clear its deadline");

  realTimers();
  console.log("sleeper_fixture: OK");
})().catch(e => { realTimers(); console.error("sleeper_fixture: FAILED"); console.error(e); process.exit(1); });
