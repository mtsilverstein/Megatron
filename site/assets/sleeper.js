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

  async function get(path) {
    const sep = path.includes("?") ? "&" : "?";
    const key = `${Date.now()}-${++seq}`;
    const res = await fetch(`${API}${path}${sep}_=${key}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return { get, API };
});
