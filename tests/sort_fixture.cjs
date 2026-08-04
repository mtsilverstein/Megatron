// tests/sort_fixture.cjs — run with: node tests/sort_fixture.cjs
//
// app.js assigns window.FC and is otherwise DOM-free at load time (no
// top-level document/window calls other than that assignment), so a tiny
// `global.window = {}` shim before require() is enough to load it under
// node. makeSortable only needs a `table` with querySelectorAll and `th`
// elements with dataset/getAttribute/setAttribute/removeAttribute/
// hasAttribute/addEventListener, so those are faked below rather than
// pulling in a real DOM.
const assert = require("assert");

global.window = {};
require("../site/assets/app.js");
const FC = global.window.FC;

function makeTh(key, { asc = false } = {}) {
  return {
    dataset: { key },
    _ariaSort: null,
    _listeners: {},
    hasAttribute(name) { return name === "data-asc" ? asc : false; },
    getAttribute(name) { return name === "aria-sort" ? this._ariaSort : null; },
    setAttribute(name, val) { if (name === "aria-sort") this._ariaSort = val; },
    removeAttribute(name) { if (name === "aria-sort") this._ariaSort = null; },
    addEventListener(evt, fn) { this._listeners[evt] = fn; },
  };
}

function makeTable(th) {
  return { dataset: {}, querySelectorAll: () => [th] };
}

// Wires makeSortable to `th`/`rows` and returns a `click()` helper that
// fires the same handler the real click listener would.
function rig(rows, key, opts) {
  const th = makeTh(key, opts);
  const table = makeTable(th);
  let rendered = null;
  FC.makeSortable(table, rows, r => { rendered = r; });
  return { th, click: () => th._listeners.click(), rows, rendered: () => rendered };
}

const ids = arr => arr.map(r => r.id);

// --- 1. Nulls sort last, descending (default first click) ------------------
{
  const rows = [
    { id: "a", v: 1 }, { id: "b", v: null }, { id: "c", v: 3 },
    { id: "d", v: undefined }, { id: "e", v: 2 },
  ];
  const { click } = rig(rows, "v");
  click();
  assert.deepStrictEqual(ids(rows), ["c", "e", "a", "b", "d"],
    "descending: real values high-to-low, nulls/undefined trail");
}

// --- 2. Nulls sort last, ascending ------------------------------------------
// This is the reported bug: the old `?? -Infinity` comparator put nulls
// FIRST on ascending (since -Infinity is the smallest possible value). It
// must fail against that comparator.
{
  const rows = [
    { id: "a", v: 1 }, { id: "b", v: null }, { id: "c", v: 3 },
    { id: "d", v: undefined }, { id: "e", v: 2 },
  ];
  const { click } = rig(rows, "v");
  click();  // 1st click -> descending
  click();  // 2nd click -> ascending
  assert.deepStrictEqual(ids(rows), ["a", "e", "c", "b", "d"],
    "ascending: real values low-to-high, nulls/undefined STILL trail (not lead)");
}

// --- 3. undefined is treated the same as null -------------------------------
{
  const rows = [{ id: "a", v: 5 }, { id: "b", v: undefined }, { id: "c", v: null }];
  const { click } = rig(rows, "v");
  click();
  assert.strictEqual(ids(rows)[0], "a");
  assert.deepStrictEqual(new Set(ids(rows).slice(1)), new Set(["b", "c"]),
    "null and undefined both sink to the bottom");
}

// --- 4. An all-null column does not throw and preserves input order --------
{
  const rows = [{ id: 1, v: null }, { id: 2, v: undefined }, { id: 3, v: null }];
  const desc = rig(rows.slice(), "v");
  assert.doesNotThrow(() => desc.click());
  assert.deepStrictEqual(ids(desc.rows), [1, 2, 3], "descending: stable, input order kept");

  const asc = rig(rows.slice(), "v");
  asc.click();  // descending
  asc.click();  // ascending
  assert.deepStrictEqual(ids(asc.rows), [1, 2, 3], "ascending: stable, input order kept");
}

// --- 5. Real values order correctly; 0 and negatives are NOT missing -------
{
  const rows = [{ id: "z", v: 0 }, { id: "n", v: -5 }, { id: "p", v: 10 }, { id: "m", v: -1 }];
  const d = rig(rows.slice(), "v");
  d.click();  // descending
  assert.deepStrictEqual(ids(d.rows), ["p", "z", "m", "n"],
    "0 sorts as a real value between positives and negatives, not as missing");

  const a = rig(rows.slice(), "v");
  a.click(); a.click();  // ascending
  assert.deepStrictEqual(ids(a.rows), ["n", "m", "z", "p"]);
}

// --- 6. Nested keys (a.b.c) still resolve -----------------------------------
{
  const rows = [
    { id: "hi", a: { b: { c: 5 } } },
    { id: "lo", a: { b: { c: 1 } } },
    { id: "nullc", a: { b: { c: null } } },
    { id: "missing", a: {} },
  ];
  const { click } = rig(rows, "a.b.c");
  click();  // descending
  assert.strictEqual(ids(rows)[0], "hi");
  assert.strictEqual(ids(rows)[1], "lo");
  assert.deepStrictEqual(new Set(ids(rows).slice(2)), new Set(["nullc", "missing"]),
    "missing/null at any depth of the nested accessor still sinks to the bottom");
}

// --- Fix 1b: data-asc marker sorts ascending on the FIRST click ------------
{
  const rows = [{ id: "a", v: 3 }, { id: "b", v: 1 }, { id: "c", v: 2 }];
  const { click, th } = rig(rows, "v", { asc: true });
  click();
  assert.deepStrictEqual(ids(rows), ["b", "c", "a"], "asc-marked column: first click ascends");
  assert.strictEqual(th.getAttribute("aria-sort"), "ascending");
  click();  // toggles normally after the first click
  assert.deepStrictEqual(ids(rows), ["a", "c", "b"], "second click still toggles to descending");
  assert.strictEqual(th.getAttribute("aria-sort"), "descending");
  click();  // toggles back
  assert.deepStrictEqual(ids(rows), ["b", "c", "a"]);
}

// Columns without data-asc are unaffected: first click is still descending.
{
  const rows = [{ id: "a", v: 3 }, { id: "b", v: 1 }, { id: "c", v: 2 }];
  const { click } = rig(rows, "v");
  click();
  assert.deepStrictEqual(ids(rows), ["a", "c", "b"], "default columns still start descending");
}

// --- Keyboard accessibility is preserved (Enter/Space trigger the same sort,
// tabindex is set) -----------------------------------------------------------
{
  const rows = [{ id: "a", v: 3 }, { id: "b", v: 1 }, { id: "c", v: 2 }];
  const th = makeTh("v");
  th.setAttribute = ((orig) => function (name, val) {
    if (name === "tabindex") this._tabindex = val;
    orig.call(this, name, val);
  })(th.setAttribute);
  const table = makeTable(th);
  FC.makeSortable(table, rows, () => {});
  assert.strictEqual(th._tabindex, "0", "sortable headers get tabindex=0");
  assert.ok(typeof th._listeners.keydown === "function", "keydown listener attached");
  th._listeners.keydown({ key: "Enter" });
  assert.deepStrictEqual(ids(rows), ["a", "c", "b"], "Enter triggers the same sort as click");
  let scrollPrevented = false;
  th._listeners.keydown({ key: " ", preventDefault: () => { scrollPrevented = true; } });
  assert.ok(scrollPrevented, "Space prevents default (page scroll)");
}

console.log("sort_fixture: OK");

// --- scoring lens: display and sort must agree -------------------------------
// The lenses genuinely disagree -- this league scores passing TDs at six, not
// four, which moves a quarterback's season by ~48 points. Before this, the
// weekly page displayed the selected lens while its sort keys stayed pinned to
// `points.ppr.*`, so switching lens showed a visibly wrong ORDER, not a
// rounding difference.
{
  const th = makeTh("points.ppr.p50");
  th.dataset.keyLens = "points.{lens}.p50";
  th._ariaSort = "descending";
  const table = makeTable(th);
  // _resort finds the sorted column by selector; the shared stub predates it
  table.querySelector = sel =>
    (sel === "thead th[aria-sort]" ? (th._ariaSort ? th : null) : null);
  // rows where the two lenses rank QBs in OPPOSITE orders
  const rows = [
    { name: "passer", points: { ppr: { p50: 100 }, league: { p50: 300 } } },
    { name: "rusher", points: { ppr: { p50: 200 }, league: { p50: 210 } } },
  ];
  let rendered = null;
  FC.makeSortable(table, rows, r => { rendered = r.map(x => x.name); });

  const wrap = { _buttons: [], appendChild(b) { this._buttons.push(b); },
                 querySelectorAll() { return this._buttons; } };
  const made = [];
  global.document = {
    querySelector: () => table,
    querySelectorAll: () => [th],
    createElement: () => {
      const b = { textContent: "", _attrs: {}, _click: null,
                  setAttribute(k, v) { this._attrs[k] = v; },
                  getAttribute(k) { return this._attrs[k]; },
                  addEventListener(_e, fn) { this._click = fn; } };
      made.push(b);
      return b;
    },
  };

  let active = null;
  const initial = FC.scoringFilter(wrap, ["ppr", "league", "standard"], l => { active = l; });

  // "league" leads the order and is therefore the default
  assert.strictEqual(initial, "league");
  assert.deepStrictEqual(made.map(b => b.textContent),
    ["MY LEAGUE", "PPR", "STANDARD"], "buttons follow LENS_LABEL order");
  assert.strictEqual(made[0].getAttribute("aria-pressed"), "true");

  // a lens the payload does not carry gets no button
  assert.ok(!made.some(b => b.textContent === "HALF-PPR"),
    "a lens absent from the payload must not render a dead button");

  // columns point at the default lens before the first render
  assert.strictEqual(th.dataset.key, "points.league.p50");

  // switching lens retargets the key AND re-applies the sort in the same
  // direction -- this is the bug: display changed, order did not.
  made.find(b => b.textContent === "PPR")._click();
  assert.strictEqual(active, "ppr");
  assert.strictEqual(th.dataset.key, "points.ppr.p50");
  assert.deepStrictEqual(rendered, ["rusher", "passer"],
    "after switching to PPR the order must follow PPR values");
  assert.strictEqual(th._ariaSort, "descending", "direction must not flip");

  made.find(b => b.textContent === "MY LEAGUE")._click();
  assert.strictEqual(th.dataset.key, "points.league.p50");
  assert.deepStrictEqual(rendered, ["passer", "rusher"],
    "back on the league lens the order must follow league values");
  assert.strictEqual(th._ariaSort, "descending");

  // an ascending sort stays ascending across a lens change
  th._ariaSort = "ascending";
  table._resort();
  assert.deepStrictEqual(rendered, ["rusher", "passer"]);
  made.find(b => b.textContent === "PPR")._click();
  assert.strictEqual(th._ariaSort, "ascending", "keep must preserve ascending too");
  assert.deepStrictEqual(rendered, ["passer", "rusher"]);

  delete global.document;
}
console.log("sort_fixture: scoring-lens group OK");
