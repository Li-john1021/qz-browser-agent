// The parser page stays separate from captured sites and closes with the owning browser.
export async function createSnapshotSanitizer(browser) {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  return (html, url) => page.evaluate(sanitizeSnapshotHtml, { html, url });
}

function sanitizeSnapshotHtml({ html, url }) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  function clean(root) {
    for (const element of root.querySelectorAll("*")) {
      const tag = element.localName.toLowerCase();
      if (tag === "template" && element.content) clean(element.content);
      const jsonLd = tag === "script"
        && element.namespaceURI === "http://www.w3.org/1999/xhtml"
        && element.getAttribute("type")?.split(";")[0].trim().toLowerCase() === "application/ld+json";
      if ((tag === "script" && !jsonLd)
        || ["iframe", "embed", "fencedframe", "portal", "param", "base"].includes(tag)
        || (tag === "meta" && (element.hasAttribute("charset") || element.hasAttribute("http-equiv")))
        || (tag === "link" && /(?:^|\s)(?:stylesheet|preload|modulepreload|prefetch|import)(?:\s|$)/i.test(element.getAttribute("rel") || ""))) {
        element.remove();
        continue;
      }
      if (tag === "object") {
        element.replaceWith(...element.childNodes);
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc"
          || (jsonLd && name === "src")
          || (["href", "xlink:href", "src", "action", "formaction"].includes(name)
            && /^\s*(?:javascript|vbscript):/i.test(attribute.value.replace(/[\t\n\r]/g, "")))) {
          element.removeAttributeNode(attribute);
        }
      }
    }
  }
  clean(doc);
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri http: https:; form-action 'none'";
  doc.head.prepend(charset, policy);
  if (url) {
    const base = doc.createElement("base");
    base.href = new URL(url).href;
    policy.after(base);
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
