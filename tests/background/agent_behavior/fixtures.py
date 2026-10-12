from __future__ import annotations

import contextlib
import json
import struct
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "support"))
from extension_assets import LoopbackHTTPServer


NEWS = {
    1: [
        ("n1", "Fixture News 1", "Ada"),
        ("n2", "Fixture News 2", "Grace"),
        ("n3", "Fixture News 3", "Linus"),
    ],
    2: [
        ("n4", "Fixture News 4", "Margaret"),
        ("n5", "Fixture News 5", "Barbara"),
        ("n6", "Fixture News 6", "Donald"),
    ],
}


CATALOG = {
    1: [
        ("sku-101", "Copper Lamp", "129"),
        ("sku-102", "Blue Chair", "259"),
        ("sku-103", "Oak Desk", "499"),
    ],
    2: [
        ("sku-104", "Glass Vase", "79"),
        ("sku-105", "White Shelf", "189"),
        ("sku-106", "Floor Rug", "319"),
    ],
}


POSTS = {
    1: [
        ("p1", "Weekend walk route", "Mina"),
        ("p2", "Quiet brunch notes", "Iris"),
        ("p3", "Lake sunset guide", "Noah"),
    ],
    2: [
        ("p4", "Museum one-day trip", "Kai"),
        ("p5", "Bookstore checklist", "Lena"),
        ("p6", "Rainy day cafe map", "Owen"),
    ],
    3: [
        ("p7", "Night market snacks", "Yuki"),
        ("p8", "Family picnic plan", "Eli"),
        ("p9", "Hidden garden review", "Zoe"),
    ],
}


class FixtureHandler(BaseHTTPRequestHandler):
    server_version = "QingzhouAgentRegression/1.0"
    navigation_counts: dict[tuple[str, str], int] = {}
    navigation_lock = threading.Lock()
    visual_ui_states: dict[str, dict[str, str]] = {}
    visual_ui_lock = threading.Lock()

    @classmethod
    def visual_ui_state(cls, key: str) -> dict[str, str]:
        with cls.visual_ui_lock:
            return dict(cls.visual_ui_states.get(key) or {})

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/navigation/redirect":
            self.send_response(302)
            self.send_header("Location", f"http://localhost:{self.server.server_port}/navigation/landed?{parsed.query}")
            self.end_headers()
            return
        if path in {"/navigation/first", "/navigation/second", "/navigation/landed"}:
            page = path.rsplit("/", 1)[-1]
            key = (str((query.get("key") or [""])[0]), page)
            with self.navigation_lock:
                generation = self.navigation_counts.get(key, 0) + 1
                self.navigation_counts[key] = generation
            # Hold response headers so reading the previous/blank document is observable.
            time.sleep(3)
            return self.respond_html(f"<!doctype html><title>Navigation {page}</title>"
                f"<article><h1>Navigation receipt</h1><p>receipt: QZ-{page}-{generation}</p></article>")
        if path in {"/", "/index.html"}:
            return self.respond_html(self.home())
        if path in {"/news", "/news/index.html"}:
            page = int((query.get("page") or ["1"])[0])
            return self.respond_html(self.news(page))
        if path.startswith("/news/"):
            return self.respond_html(self.article(path.rsplit("/", 1)[-1]))
        if path == "/catalog":
            page = int((query.get("page") or ["1"])[0])
            return self.respond_html(self.catalog(page))
        if path == "/posts":
            page = int((query.get("page") or ["1"])[0])
            return self.respond_html(self.posts(page))
        if path.startswith("/posts/"):
            return self.respond_html(self.post(path.rsplit("/", 1)[-1]))
        if path == "/forms":
            return self.respond_html(self.forms())
        if path == "/api/search":
            return self.respond_json(self.search_api(query))
        if path == "/images":
            return self.respond_html(self.images())
        if path == "/image-selection":
            return self.respond_html(self.image_selection())
        if path == "/image-locality":
            return self.respond_html(self.image_locality_index())
        if path in {"/image-locality/source-a", "/image-locality/source-b"}:
            return self.respond_html(self.image_locality_source(path.rsplit("-", 1)[-1]))
        if path == "/image-selection-opaque":
            return self.respond_html(self.opaque_image_selection())
        if path.startswith("/opaque-assets/") and path.endswith(".png"):
            return self.respond_png(self.png_asset(path.rsplit("/", 1)[-1].removesuffix(".png")))
        if path.startswith("/assets/") and path.endswith(".svg"):
            return self.respond_svg(self.svg_asset(path.rsplit("/", 1)[-1].removesuffix(".svg")))
        if path == "/noisy-article":
            return self.respond_html(self.noisy_article())
        if path == "/dynamic":
            return self.respond_html(self.dynamic())
        if path == "/environment/visible":
            return self.respond_html(self.environment_page(
                title="User Visible Environment",
                page_role="user-visible",
                marker="USER-VISIBLE-MARKER-7419",
            ))
        if path == "/environment/working":
            return self.respond_html(self.environment_page(
                title="Session Working Environment",
                page_role="session-working",
                marker="SESSION-WORKING-MARKER-2864",
            ))
        if path.startswith("/parallel/"):
            return self.parallel_result(path.rsplit("/", 1)[-1])
        if path == "/schedule/probe":
            return self.respond_json({"ok": True, "status": "fixture-ready", "code": "schedule-204"})
        if path == "/library":
            return self.respond_html(self.library())
        if path == "/files/journey-report.txt":
            return self.respond_text("Qingzhou journey report\nstatus=verified\nrows=3\n")
        if path == "/visual/canvas":
            return self.respond_html(self.visual_canvas())
        if path == "/visual/ui":
            return self.respond_html(self.visual_ui())
        if path == "/visual/ui-event":
            key = str((query.get("key") or [""])[0]).strip()
            receipt = str((query.get("receipt") or [""])[0]).strip()
            if not key or not receipt:
                return self.respond_json({"ok": False, "error": "missing key or receipt"}, status=400)
            with self.visual_ui_lock:
                self.visual_ui_states[key] = {"status": "completed", "receipt": receipt}
            return self.respond_json({"ok": True})
        if path == "/docs/sample.txt":
            return self.respond_text(self.sample_doc())
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"not found")

    def respond_html(self, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def respond_text(self, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def respond_json(self, value: dict[str, Any], *, status: int = 200) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def respond_svg(self, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def respond_png(self, data: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def home(self) -> str:
        return """
<!doctype html>
<html>
<head><title>Qingzhou Regression Fixture</title></head>
<body>
  <main id="main">
    <h1>Qingzhou Regression Fixture</h1>
    <nav>
      <a id="news-link" href="/news?page=1">News fixture</a>
      <a id="catalog-link" href="/catalog?page=1">Catalog fixture</a>
      <a id="posts-link" href="/posts?page=1">Posts fixture</a>
      <a id="forms-link" href="/forms">Forms fixture</a>
      <a id="images-link" href="/images">Images fixture</a>
      <a id="image-selection-link" href="/image-selection">Image selection fixture</a>
      <a id="image-locality-link" href="/image-locality">Image locality fixture</a>
      <a id="article-link" href="/noisy-article">Noisy article fixture</a>
      <a id="dynamic-link" href="/dynamic">Dynamic target fixture</a>
    </nav>
  </main>
</body>
</html>
"""

    def news(self, page: int) -> str:
        items = NEWS.get(page, [])
        rows = "\n".join(
            f'<article class="story" data-id="{sid}">'
            f'<a class="story-title" href="/news/{sid}">{title}</a>'
            f'<span class="story-author">{author}</span>'
            f'<p class="summary">Summary for {title} on page {page}.</p>'
            "</article>"
            for sid, title, author in items
        )
        prev_link = f'<a id="prev-page" href="/news?page={page - 1}">Previous page</a>' if page > 1 else ""
        next_link = f'<a id="next-page" data-testid="next-page" href="/news?page={page + 1}">Next page</a>' if page < max(NEWS) else ""
        return f"""
<!doctype html>
<html>
<head><title>Fixture News Page {page}</title></head>
<body>
  <main id="news-main">
    <h1>Fixture News Page {page}</h1>
    <section class="story-list">{rows}</section>
    <nav class="pager">{prev_link}{next_link}</nav>
  </main>
</body>
</html>
"""

    def article(self, story_id: str) -> str:
        story = next((item for page in NEWS.values() for item in page if item[0] == story_id), None)
        title = story[1] if story else "Unknown story"
        author = story[2] if story else "Unknown"
        return f"""
<!doctype html>
<html>
<head><title>{title}</title></head>
<body>
  <article id="article" data-id="{story_id}">
    <h1>{title}</h1>
    <p class="byline">By {author}</p>
    <p>Fixture article body for {title}. It is deterministic and short.</p>
  </article>
</body>
</html>
"""

    def catalog(self, page: int) -> str:
        items = CATALOG.get(page, [])
        rows = "\n".join(
            f"<tr data-sku=\"{sku}\"><td>{sku}</td><td>{name}</td><td>{price}</td></tr>"
            for sku, name, price in items
        )
        next_link = f'<a id="catalog-next" href="/catalog?page={page + 1}">Next catalog page</a>' if page < max(CATALOG) else ""
        return f"""
<!doctype html>
<html>
<head><title>Fixture Catalog Page {page}</title></head>
<body>
  <main id="catalog-main">
    <h1>Fixture Catalog Page {page}</h1>
    <table id="product-table">
      <thead><tr><th>SKU</th><th>Name</th><th>Price</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
    <nav>{next_link}</nav>
  </main>
</body>
</html>
"""

    def posts(self, page: int) -> str:
        items = POSTS.get(page, [])
        rows = "\n".join(
            f'<li class="post" data-id="{pid}">'
            f'<a class="post-title" href="/posts/{pid}">{title}</a>'
            f'<span class="post-author">{author}</span>'
            "</li>"
            for pid, title, author in items
        )
        next_link = f'<a id="posts-next" href="/posts?page={page + 1}">Next posts page</a>' if page < max(POSTS) else ""
        return f"""
<!doctype html>
<html>
<head><title>Fixture Posts Page {page}</title></head>
<body>
  <main id="posts-main">
    <h1>Fixture Posts Page {page}</h1>
    <ul class="posts">{rows}</ul>
    <nav>{next_link}</nav>
  </main>
</body>
</html>
"""

    def post(self, post_id: str) -> str:
        post = next((item for page in POSTS.values() for item in page if item[0] == post_id), None)
        title = post[1] if post else "Unknown post"
        author = post[2] if post else "Unknown"
        return f"""
<!doctype html>
<html>
<head><title>{title}</title></head>
<body>
  <article id="post" data-id="{post_id}">
    <h1>{title}</h1>
    <p class="author">Author: {author}</p>
    <p>Fixture post body for {title}.</p>
  </article>
</body>
</html>
"""

    def forms(self) -> str:
        return """
<!doctype html>
<html>
<head><title>Fixture Form Search</title></head>
<body>
  <main id="form-main">
    <h1>Fixture Form Search</h1>
    <p id="intro">This page emits console logs and fetches /api/search after submit.</p>
    <form id="search-form">
      <label>Query <input id="query" name="q" placeholder="Search products"></label>
      <label>Category
        <select id="category" name="category">
          <option value="all">All</option>
          <option value="furniture">Furniture</option>
          <option value="lighting">Lighting</option>
        </select>
      </label>
      <label><input id="vip" type="checkbox" name="vip"> VIP only</label>
      <button id="submit-search" type="submit">Run search</button>
    </form>
    <section id="results" aria-live="polite"></section>
  </main>
  <script>
    console.info("fixture form boot");
    document.querySelector("#search-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const q = String(form.get("q") || "");
      const category = String(form.get("category") || "all");
      const vip = document.querySelector("#vip").checked ? "1" : "0";
      console.info("fixture search submit", q, category, vip);
      const response = await fetch(`/api/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&vip=${vip}`);
      const data = await response.json();
      document.querySelector("#results").innerHTML = data.rows.map((row) => (
        `<article class="result" data-id="${row.id}"><h2>${row.title}</h2><p>${row.summary}</p></article>`
      )).join("");
      console.info("fixture search rendered", data.rows.length);
    });
  </script>
</body>
</html>
"""

    def search_api(self, query: dict[str, list[str]]) -> dict[str, Any]:
        q = (query.get("q") or [""])[0]
        category = (query.get("category") or ["all"])[0]
        vip = (query.get("vip") or ["0"])[0] == "1"
        rows = [
            {
                "id": "r1",
                "title": f"{q or 'empty'} chair result",
                "summary": f"category={category}; vip={str(vip).lower()}; rank=1",
            },
            {
                "id": "r2",
                "title": f"{q or 'empty'} desk result",
                "summary": f"category={category}; vip={str(vip).lower()}; rank=2",
            },
        ]
        return {
            "ok": True,
            "query": q,
            "category": category,
            "vip": vip,
            "rows": rows,
            "count": len(rows),
        }

    def images(self) -> str:
        items = [
            ("red", "Red fixture card", "Warm red card"),
            ("green", "Green fixture card", "Fresh green card"),
            ("blue", "Blue fixture card", "Calm blue card"),
            ("gold", "Gold fixture card", "Bright gold card"),
        ]
        cards = "\n".join(
            f'<figure class="card" data-color="{color}">'
            f'<img class="gallery-image" src="/assets/{color}.svg" width="180" height="120" alt="{alt}">'
            f'<figcaption>{caption}</figcaption>'
            "</figure>"
            for color, alt, caption in items
        )
        return f"""
<!doctype html>
<html>
<head><title>Fixture Image Gallery</title></head>
<body>
  <main id="gallery">
    <h1>Fixture Image Gallery</h1>
    <section class="cards">{cards}</section>
  </main>
</body>
</html>
"""

    def image_selection(self) -> str:
        return """
<!doctype html>
<html>
<head>
  <title>山野咖啡手记 - 图片筛选测试</title>
  <style>
    body { font-family: sans-serif; margin: 0; color: #252525; }
    header, main, aside, footer { padding: 16px 24px; }
    header { display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #ddd; }
    header img { width: 132px; height: 44px; }
    .author { display: flex; align-items: center; gap: 10px; }
    .author img { width: 48px; height: 48px; border-radius: 50%; }
    #brew-steps { display: grid; grid-template-columns: repeat(2, minmax(0, 280px)); gap: 18px; }
    figure { margin: 0; }
    figure img { width: 280px; height: 180px; object-fit: cover; }
    figcaption { margin-top: 8px; }
    .divider { width: 620px; height: 24px; }
    aside img, .recommendations img { width: 240px; height: 120px; }
    footer img { width: 64px; height: 64px; }
  </style>
</head>
<body>
  <header>
    <img src="/assets/brand-logo.svg" alt="山野咖啡网站品牌 Logo" title="网站品牌标识">
    <strong>山野咖啡</strong>
  </header>
  <main>
    <article id="coffee-note">
      <h1>山野咖啡手记</h1>
      <div class="author">
        <img src="/assets/author-avatar.svg" alt="作者林夏的头像" title="作者头像">
        <span>作者：林夏</span>
      </div>
      <p>正文只用两张步骤图说明磨豆和手冲注水。</p>
      <section id="brew-steps" aria-label="冲泡步骤正文配图">
        <figure data-role="article-step" data-step="grind">
          <img src="/assets/grind-step.svg" alt="正文步骤图：用手摇磨豆机研磨咖啡豆" title="磨豆步骤配图">
          <figcaption>步骤一：磨豆，保持颗粒均匀。</figcaption>
        </figure>
        <figure data-role="article-step" data-step="pour">
          <img src="/assets/pour-step.svg" alt="正文步骤图：用细口壶为滤杯手冲注水" title="手冲注水步骤配图">
          <figcaption>步骤二：手冲注水，控制水流速度。</figcaption>
        </figure>
      </section>
      <img class="divider" src="/assets/decorative-divider.svg" alt="" title="">
    </article>
    <aside aria-label="赞助内容">
      <img src="/assets/sponsored-banner.svg" alt="赞助广告：咖啡器具折扣" title="赞助内容">
    </aside>
    <section class="recommendations" aria-label="相关推荐">
      <h2>相关推荐</h2>
      <img src="/assets/recommended-city.svg" alt="相关推荐封面：城市夜景摄影指南" title="推荐文章封面">
    </section>
  </main>
  <footer>
    <img src="/assets/footer-badge.svg" alt="网站页脚认证徽章" title="页脚徽章">
  </footer>
</body>
</html>
"""

    def opaque_image_selection(self) -> str:
        tokens = ("a91f", "b28c", "c73d", "d44e", "e05a")
        cards = "\n".join(
            f'<img src="/opaque-assets/{token}.png" width="240" height="160" alt="" title="">'
            for token in tokens
        )
        return f"""
<!doctype html>
<html>
<head><title>无图片元信息测试页</title></head>
<body>
  <main>
    <h1>咖啡器具图片素材</h1>
    <section id="opaque-gallery">{cards}</section>
  </main>
</body>
</html>
"""

    def image_locality_index(self) -> str:
        return """
<!doctype html>
<html>
<head><title>CMU 时期资料索引</title></head>
<body>
  <main>
    <h1>CMU 时期资料索引</h1>
    <p>两处独立档案各收录一张经过说明的 CMU 时期照片。</p>
    <ul>
      <li><a id="source-a" href="/image-locality/source-a" target="_blank">CMU 实验室档案</a></li>
      <li><a id="source-b" href="/image-locality/source-b" target="_blank">CMU 答辩档案</a></li>
    </ul>
  </main>
</body>
</html>
"""

    def image_locality_source(self, source: str) -> str:
        source_id = "a" if source == "a" else "b"
        title = "CMU 实验室档案" if source_id == "a" else "CMU 答辩档案"
        image_name = "cmu-lab" if source_id == "a" else "cmu-defense"
        image_alt = "CMU 时期照片：实验室合影" if source_id == "a" else "CMU 时期照片：论文答辩现场"
        return f"""
<!doctype html>
<html>
<head><title>{title}</title></head>
<body>
  <main>
    <article>
      <h1>{title}</h1>
      <p>本页确认收录一张 CMU 时期照片。</p>
      <figure>
        <img src="/assets/{image_name}.svg" width="360" height="240" alt="{image_alt}" title="{image_alt}">
        <figcaption>{image_alt}</figcaption>
      </figure>
      <img src="/assets/archive-badge.svg" width="80" height="80" alt="档案站点徽标" title="站点装饰">
    </article>
  </main>
</body>
</html>
"""

    def svg_asset(self, name: str) -> str:
        colors = {
            "red": ("#d74c4c", "RED"),
            "green": ("#2f9b67", "GREEN"),
            "blue": ("#4776d8", "BLUE"),
            "gold": ("#d6a23a", "GOLD"),
            "brand-logo": ("#1f2937", "BRAND"),
            "author-avatar": ("#7c6f64", "AUTHOR"),
            "grind-step": ("#8b5e3c", "GRIND"),
            "pour-step": ("#3f7c8c", "POUR"),
            "decorative-divider": ("#c9c3ba", "DIVIDER"),
            "sponsored-banner": ("#b7791f", "AD"),
            "recommended-city": ("#515a78", "RECOMMEND"),
            "footer-badge": ("#6b7280", "BADGE"),
            "cmu-lab": ("#365f8d", "CMU LAB"),
            "cmu-defense": ("#6a4d8f", "CMU DEFENSE"),
            "archive-badge": ("#80868f", "ARCHIVE"),
        }
        fill, label = colors.get(name, ("#777777", "UNKNOWN"))
        return f"""<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120" viewBox="0 0 180 120">
  <rect width="180" height="120" rx="10" fill="{fill}"/>
  <circle cx="42" cy="60" r="24" fill="rgba(255,255,255,0.28)"/>
  <text x="90" y="67" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="white">{escape(label)}</text>
</svg>
"""

    def png_asset(self, name: str) -> bytes:
        colors = {
            "a91f": (139, 94, 60),
            "b28c": (63, 124, 140),
            "c73d": (107, 114, 128),
            "d44e": (124, 111, 100),
            "e05a": (81, 90, 120),
        }
        width, height = 180, 120
        rgb = colors.get(name, (119, 119, 119))
        raw = (b"\x00" + bytes(rgb) * width) * height

        def chunk(kind: bytes, payload: bytes) -> bytes:
            checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
            return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, level=9))
            + chunk(b"IEND", b"")
        )

    def noisy_article(self) -> str:
        return """
<!doctype html>
<html>
<head>
  <title>Fixture Noisy Article</title>
  <meta name="description" content="Noise-heavy article page for selector extraction.">
</head>
<body>
  <header><nav><a href="/">Home</a><a href="/catalog?page=1">Catalog</a></nav></header>
  <aside id="sidebar"><p>Advertisement and unrelated navigation should be ignored.</p></aside>
  <main id="article-shell">
    <article id="long-article" data-topic="selector-fallback">
      <h1>Selector Extraction Guide</h1>
      <p class="byline">By Fixture Bot</p>
      <p>Alpha insight: selector based extraction keeps the intended article scope.</p>
      <p>Beta insight: noisy sidebars and navigation should not enter the stored facts.</p>
      <p>Gamma insight: linkCount can confirm related links without returning full link lists.</p>
      <a href="/docs/sample.txt">Related deterministic document</a>
    </article>
  </main>
  <footer>Footer boilerplate that should be ignored.</footer>
</body>
</html>
"""

    def dynamic(self) -> str:
        return """
<!doctype html>
<html>
<head><title>Fixture Dynamic Target</title></head>
<body>
  <main id="dynamic-main">
    <h1>Fixture Dynamic Target</h1>
    <p>Use machine targets, wait for generated controls, and avoid disabled duplicates.</p>
    <button class="continue" disabled>Continue</button>
    <button id="reveal" class="continue">Reveal target</button>
    <section id="dynamic-zone" aria-live="polite"></section>
    <p id="dynamic-result">Not saved</p>
  </main>
  <script>
    document.querySelector("#reveal").addEventListener("click", () => {
      document.querySelector("#reveal").remove();
      setTimeout(() => {
        document.querySelector("#dynamic-zone").innerHTML = `
          <label>Generated value <input id="generated-input" placeholder="dynamic value"></label>
          <button class="save" disabled>Save dynamic</button>
          <button id="save-dynamic" class="save">Save dynamic</button>
        `;
        document.querySelector("#save-dynamic").addEventListener("click", () => {
          const value = document.querySelector("#generated-input").value;
          document.querySelector("#dynamic-result").textContent = `saved:${value}`;
        });
      }, 350);
    });
  </script>
</body>
</html>
"""

    def environment_page(self, *, title: str, page_role: str, marker: str) -> str:
        return f"""
<!doctype html>
<html>
<head><title>{title}</title></head>
<body>
  <main id="environment" data-page-role="{page_role}" data-marker="{marker}">
    <h1>{title}</h1>
    <dl>
      <dt>pageRole</dt><dd>{page_role}</dd>
      <dt>marker</dt><dd>{marker}</dd>
    </dl>
    <p>This deterministic page identifies one browser environment role.</p>
  </main>
</body>
</html>
"""

    def sample_doc(self) -> str:
        return """Qingzhou document fixture

This deterministic document verifies document_fetch, document_parse, document_read_chunk, and document_create.

Facts:
- owner: qingzhou-agent-regression
- rows: 3
- purpose: base suite document family coverage
"""

    def parallel_result(self, name: str) -> None:
        values = {
            "alpha": ("alpha-17", "ready"),
            "beta": ("beta-29", "ready"),
        }
        if name == "gamma":
            data = b"fixture branch unavailable"
            self.send_response(503)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        code, status = values.get(name, ("unknown", "missing"))
        self.respond_html(f"""
<!doctype html>
<html><head><title>Parallel {escape(name)}</title></head>
<body><main data-branch="{escape(name)}"><h1>{escape(name.title())}</h1>
<p id="branch-code">{escape(code)}</p><p id="branch-status">{escape(status)}</p></main></body></html>
""")

    def library(self) -> str:
        return """
<!doctype html>
<html><head><title>Journey Library Fixture</title></head>
<body><main><h1>Journey Library Fixture</h1>
<p>这是一份用于验证浏览器资料管理的本地页面。</p>
<a id="journey-report" download="journey-report.txt" href="/files/journey-report.txt">下载核验报告</a>
</main></body></html>
"""

    def visual_canvas(self) -> str:
        return """
<!doctype html>
<html><head><title>Visual-only Fixture</title></head>
<body><main><h1>Canvas visual check</h1><canvas id="signal" width="360" height="180"></canvas></main>
<script>
const canvas = document.querySelector('#signal');
const context = canvas.getContext('2d');
context.fillStyle = '#f5f5f7'; context.fillRect(0, 0, 360, 180);
context.fillStyle = '#1d1d1f'; context.beginPath(); context.arc(92, 90, 42, 0, Math.PI * 2); context.fill();
context.strokeStyle = '#a1a1a6'; context.lineWidth = 8; context.beginPath(); context.moveTo(150, 90); context.lineTo(292, 90); context.stroke();
</script></body></html>
"""

    def visual_ui(self) -> str:
        return """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visual UI Fixture</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f6f8; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    main { width: 680px; max-width: calc(100vw - 32px); margin: 24px auto; }
    h1 { margin: 0 0 12px; font-size: 20px; color: #1d1d1f; }
    canvas { display: block; width: 640px; max-width: 100%; border: 1px solid #dedfe3; border-radius: 16px; background: #fff; box-shadow: 0 10px 32px rgb(20 24 31 / 7%); }
    #text-sink { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
  </style>
</head>
<body>
  <main>
    <h1>Visual interaction board</h1>
    <canvas id="board" width="640" height="460"></canvas>
    <input id="text-sink" tabindex="-1" aria-hidden="true" value="原始内容">
  </main>
  <script>
  (() => {
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') || 'click';
    const key = params.get('key') || '';
    const canvas = document.querySelector('#board');
    const sink = document.querySelector('#text-sink');
    const ctx = canvas.getContext('2d');
    const state = {
      selected: '',
      dragging: false,
      dropped: false,
      dragX: 72,
      dragY: 150,
      text: sink.value,
      pending: false,
      receipt: '',
      error: '',
    };

    if (mode === 'scroll') canvas.height = 1480;

    const palette = {
      ink: '#202124', muted: '#747980', line: '#dfe1e5', panel: '#f7f8fa',
      blue: '#3f78d4', amber: '#d99a2b', green: '#3c9873', purple: '#7a63c7', red: '#c84c57',
    };
    const rounded = (x, y, w, h, radius = 12) => {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); return ctx;
    };
    const text = (value, x, y, size = 18, color = palette.ink, weight = 500, align = 'left') => {
      ctx.fillStyle = color; ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(value, x, y);
    };
    const button = (label, x, y, w, h, enabled = true) => {
      rounded(x, y, w, h, 12).fillStyle = enabled ? palette.ink : '#a9adb3'; ctx.fill();
      text(label, x + w / 2, y + h / 2, 16, '#fff', 650, 'center');
    };
    const hit = (point, box) => point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
    const point = event => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height,
      };
    };

    const drawHeader = subtitle => {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      text(subtitle, 34, 42, 22, palette.ink, 700);
      text('Use the visible controls to complete the task', 34, 72, 14, palette.muted, 450);
    };
    const drawResult = y => {
      if (!state.receipt && !state.pending && !state.error) return;
      const ok = Boolean(state.receipt);
      rounded(34, y, 572, 56, 12).fillStyle = ok ? '#e8f5ef' : (state.error ? '#fcebed' : '#f1f2f4'); ctx.fill();
      text(ok ? `SUCCESS · ${state.receipt}` : (state.error || 'SAVING…'), 54, y + 28, 16, ok ? '#237653' : palette.muted, 650);
    };
    const drawClick = () => {
      drawHeader('Choose one visual option');
      const options = [
        { id: 'blue-circle', label: 'Blue circle', color: palette.blue, shape: 'circle', y: 105 },
        { id: 'amber-triangle', label: 'Amber triangle', color: palette.amber, shape: 'triangle', y: 181 },
        { id: 'green-square', label: 'Green square', color: palette.green, shape: 'square', y: 257 },
      ];
      for (const option of options) {
        rounded(34, option.y, 360, 58, 12).fillStyle = state.selected === option.id ? '#eef3fb' : palette.panel; ctx.fill();
        ctx.strokeStyle = state.selected === option.id ? palette.blue : palette.line; ctx.lineWidth = state.selected === option.id ? 2 : 1; ctx.stroke();
        ctx.fillStyle = option.color;
        if (option.shape === 'circle') { ctx.beginPath(); ctx.arc(66, option.y + 29, 15, 0, Math.PI * 2); ctx.fill(); }
        if (option.shape === 'square') ctx.fillRect(51, option.y + 14, 30, 30);
        if (option.shape === 'triangle') { ctx.beginPath(); ctx.moveTo(66, option.y + 11); ctx.lineTo(84, option.y + 45); ctx.lineTo(48, option.y + 45); ctx.closePath(); ctx.fill(); }
        text(option.label, 104, option.y + 29, 17, palette.ink, 550);
      }
      button('CONFIRM', 432, 181, 174, 58, Boolean(state.selected) && !state.pending);
      drawResult(350);
    };
    const drawForm = () => {
      drawHeader('Edit the visual form');
      text('Project label', 34, 125, 15, palette.muted, 550);
      rounded(34, 146, 572, 66, 12).fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = palette.line; ctx.lineWidth = 2; ctx.stroke();
      text(state.text || ' ', 54, 179, 19, palette.ink, 500);
      button('SUBMIT', 432, 244, 174, 58, Boolean(state.text) && !state.pending);
      drawResult(336);
    };
    const drawDrag = () => {
      drawHeader('Move the requested card');
      rounded(374, 116, 232, 164, 16).fillStyle = '#faf9fe'; ctx.fill(); ctx.strokeStyle = palette.purple; ctx.lineWidth = 2; ctx.setLineDash([8, 7]); ctx.stroke(); ctx.setLineDash([]);
      text('ARCHIVE', 490, 142, 16, palette.purple, 700, 'center');
      const x = state.dropped ? 425 : state.dragX;
      const y = state.dropped ? 175 : state.dragY;
      rounded(x, y, 146, 72, 14).fillStyle = '#eeeafd'; ctx.fill(); ctx.strokeStyle = palette.purple; ctx.lineWidth = 2; ctx.stroke();
      text('QZ-27', x + 73, y + 36, 19, palette.purple, 750, 'center');
      button('APPLY', 432, 310, 174, 58, state.dropped && !state.pending);
      drawResult(386);
    };
    const drawScroll = () => {
      drawHeader('Find the requested access card');
      const cards = [
        { code: 'OMEGA-12', y: 124, color: palette.blue },
        { code: 'BETA-44', y: 360, color: palette.red },
        { code: 'DELTA-08', y: 720, color: palette.green },
        { code: 'ALPHA-73', y: 1160, color: palette.purple },
      ];
      for (const card of cards) {
        rounded(54, card.y, 532, 150, 18).fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = palette.line; ctx.lineWidth = 2; ctx.stroke();
        rounded(78, card.y + 32, 88, 86, 18).fillStyle = card.color; ctx.fill();
        text(card.code, 196, card.y + 58, 21, palette.ink, 720);
        text('Access card', 196, card.y + 91, 15, palette.muted, 450);
        if (card.code === 'ALPHA-73') button('ACTIVATE', 394, card.y + 45, 164, 60, !state.pending);
      }
      drawResult(1330);
    };
    const draw = () => {
      if (mode === 'form') return drawForm();
      if (mode === 'drag') return drawDrag();
      if (mode === 'scroll') return drawScroll();
      return drawClick();
    };
    const finish = async receipt => {
      if (state.pending || state.receipt) return;
      state.pending = true; draw();
      try {
        const response = await fetch(`/visual/ui-event?key=${encodeURIComponent(key)}&receipt=${encodeURIComponent(receipt)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.receipt = receipt;
      } catch (error) {
        state.error = `SAVE FAILED · ${error.message}`;
      } finally {
        state.pending = false; draw();
      }
    };

    sink.addEventListener('input', () => { state.text = sink.value; draw(); });
    sink.addEventListener('keydown', event => {
      if (event.key === 'Enter' && state.text === 'Kimi Visual 73') finish('form-kimi-visual-73');
    });
    canvas.addEventListener('mousedown', event => {
      const p = point(event);
      if (mode === 'drag' && !state.dropped && hit(p, { x: state.dragX, y: state.dragY, w: 146, h: 72 })) {
        state.dragging = true;
      }
    });
    canvas.addEventListener('mousemove', event => {
      if (!state.dragging) return;
      const p = point(event); state.dragX = p.x - 73; state.dragY = p.y - 36; draw();
    });
    canvas.addEventListener('mouseup', event => {
      if (!state.dragging) return;
      state.dragging = false;
      const p = point(event);
      state.dropped = hit(p, { x: 374, y: 116, w: 232, h: 164 });
      if (!state.dropped) { state.dragX = 72; state.dragY = 150; }
      draw();
    });
    canvas.addEventListener('click', event => {
      const p = point(event);
      if (mode === 'click') {
        const options = [
          { id: 'blue-circle', x: 34, y: 105, w: 360, h: 58 },
          { id: 'amber-triangle', x: 34, y: 181, w: 360, h: 58 },
          { id: 'green-square', x: 34, y: 257, w: 360, h: 58 },
        ];
        const selected = options.find(option => hit(p, option));
        if (selected) { state.selected = selected.id; draw(); return; }
        if (hit(p, { x: 432, y: 181, w: 174, h: 58 }) && state.selected === 'amber-triangle') finish('click-amber-triangle');
      }
      if (mode === 'form') {
        if (hit(p, { x: 34, y: 146, w: 572, h: 66 })) { sink.focus(); return; }
        if (hit(p, { x: 432, y: 244, w: 174, h: 58 }) && state.text === 'Kimi Visual 73') finish('form-kimi-visual-73');
      }
      if (mode === 'drag' && hit(p, { x: 432, y: 310, w: 174, h: 58 }) && state.dropped) finish('drag-qz27-archive');
      if (mode === 'scroll' && hit(p, { x: 394, y: 1205, w: 164, h: 60 })) finish('scroll-alpha-73');
    });
    draw();
  })();
  </script>
</body>
</html>
"""


@contextlib.contextmanager
def fixture_server() -> Any:
    server = LoopbackHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, name="qingzhou-agent-fixture", daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
