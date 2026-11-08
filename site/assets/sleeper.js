// site/assets/sleeper.js
/* The one Sleeper fetch. Read-only public API (api.sleeper.app), no auth.

   Sleeper sends NO Cache-Control on its live endpoints and sits behind a CDN.
   Measured against a real draft: two consecutive requests both returned
   Age: 22072 -- the same shared cache entry, six hours old -- while a
   cache-busted URL reached origin. On a live draft that is a board several
   picks behind reporting itself as current, and re-requesting the same URL
   (what pressing a refresh button does) hits the SAME entry, so it never
   recovers. The response also carries an ETag and no Cache-Control, so
   Chrome's own heuristic freshness applies on top of the CDN's.

   Both defences are required and they defeat different caches: the unique
   query key misses the CDN's shared entry, `no-store` keeps the browser's
   own HTTP cache out. Every caller goes through here so there is exactly one
   implementation to get right. */
(function (root, factory) {
  const S = factory();
  if (typeof window !== "undefined") window.Sleeper = S;
  if (typeof module !== "undefined" && module.exports) module.exports = S;
})(this, function () {
  const API = "https://api.sleeper.app/v1";
  // Date.now() alone is not a reliable disambiguator -- measured 1000/1000
  // back-to-back Date.now() calls returning the SAME millisecond on this
  // platform. Two get() calls issued in the same tick (e.g. Promise.all)
  // would then share a cache key, which is exactly the bug this module
  // exists to prevent. A per-call counter guarantees uniqueness regardless
  // of clock granularity; the timestamp is kept alongside it for readability
  // when eyeballing requests.
  let seq = 0;

  /* A deadline for one request. `fetch` has NO default timeout, so a
     connection that opens and never resolves leaves the promise pending
     forever. That is worse than an error here: draftmode's poll loop re-arms
     only in its success and error paths (draftmode.js:209, :215), and a hang
     reaches neither -- backoff is driven by rejections, and a hang is not a
     rejection. The loop stops permanently and the panel stays dead until the
     user notices and reloads, which on a 60-second pick timer is the whole
     turn. Aborting converts a permanent failure into a bounded one that the
     existing backoff ladder already knows how to retry.

     4000ms is 16x the measured idle p99: 40 sequential reads of the live
     draft endpoint gave p50 92ms, p99 248ms, max 248ms, 0 failures. So it
     fires only on a genuine hang, never on a slow-but-alive response. Two
     honest limits on that number. Idle is all we can measure -- the endpoint
     under live-draft load, twelve clients polling every 3s with picks
     landing, is unknown, which is why this is not tightened further. And it
     does NOT keep "NOT UPDATING" off the screen: last success t=0, next poll
     t=3, abort t=7, backoff doubles to 6s, retry ~t=13, just past
     STALE_AFTER_S=12. Self-recovery is the goal, not an unbroken status
     line. */
  const TIMEOUT_MS = 4000;

  /* The player catalog (/players/nfl) is ~2.5 MB gzip (14.7 MB raw), not a
     small poll endpoint, so the 4 s deadline above does not apply to it: on
     a "Fast 4G" profile the body alone outlasts 4 s and the abort fired
     every time, and a retry re-downloaded the file and hit the same wall.
     It is a one-shot load per document, not a poll loop, so a long bound is
     safe; it still ends a true hang. Callers pass it as opts.timeoutMs. */
  const CATALOG_TIMEOUT_MS = 60000;

  function timeoutMessage(ms) {
    const n = Math.max(1, Math.ceil(ms / 1000));
    return `Sleeper did not respond within ${n} ${n === 1 ? "second" : "seconds"}. Check your connection and try again.`;
  }

  async function get(path, opts) {
    const requested = opts && opts.timeoutMs;
    const timeoutMs = typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested : TIMEOUT_MS;
    const sep = path.includes("?") ? "&" : "?";
    const key = `${Date.now()}-${++seq}`;
    const ctl = new AbortController();
    // Set only by OUR timer, so only our own abort is rewritten below.
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      const res = await fetch(`${API}${path}${sep}_=${key}`,
                              { cache: "no-store", signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Awaited INSIDE the try on purpose. A body that stalls mid-stream
      // hangs exactly as hard as stalled headers, and it is the same dead
      // panel; aborting terminates body consumption too. The worst it can
      // create is a retry, which is what we wanted anyway.
      return await res.json();
    } catch (e) {
      if (timedOut) throw new Error(timeoutMessage(timeoutMs));
      throw e;
    } finally {
      clearTimeout(deadline);
    }
  }

  return { get, API, TIMEOUT_MS, CATALOG_TIMEOUT_MS, timeoutMessage };
});
