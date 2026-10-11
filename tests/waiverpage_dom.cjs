// tests/waiverpage_dom.cjs — not a fixture; a helper for the waiver-desk fixtures.
//
// Builds the fake-DOM tree for site/waivers.html's <main> FROM THE REAL PAGE,
// so the controller fixtures always run against the page's actual ids,
// nesting (the reserve input inside its <label>, each tbody inside its table)
// and initial `hidden` / `open` state. `element` is the fixture's own fake
// element factory; `main` is the fake <main> the document resolves ids under.
const fs = require("node:fs");
const path = require("node:path");

const VOID = new Set(["input", "br", "img", "meta", "link", "hr", "source", "col", "wbr"]);

function waiverPageHtml() {
  return fs.readFileSync(path.join(__dirname, "..", "site", "waivers.html"), "utf8");
}

function buildWaiverPage(element, main, html = waiverPageHtml()) {
  const start = html.indexOf(">", html.indexOf('<main id="waiver-app"')) + 1;
  const body = html.slice(start, html.indexOf("</main>"));
  const stack = [main];
  for (const m of body.matchAll(/<!--[\s\S]*?-->|<(\/)?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    if (!m[2]) continue;                          // a comment
    const tag = m[2].toLowerCase();
    if (m[1]) {                                   // a closing tag: pop to its opener
      const at = stack.map(n => n.tagName).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const el = element(tag);
    for (const a of m[3].matchAll(/([\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      const name = a[1], value = a[2] === undefined ? "" : a[2].replace(/^["']|["']$/g, "");
      if (name === "id") el.id = value;
      else if (name === "class") el.className = value;
      else if (name === "hidden") el.hidden = true;
      else if (name === "open") el.open = true;
      else if (name === "type") el.type = value;
      else el.setAttribute(name, value);
    }
    stack[stack.length - 1].append(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) stack.push(el);
  }
  return main;
}

module.exports = { buildWaiverPage, waiverPageHtml };
