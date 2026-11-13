"""Stage only public application code and fonts. Session traffic is never copied."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote, urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("har", type=Path)
parser.add_argument("brand", choices=("samsung", "vestel", "lg", "lg_lowres"))
parser.add_argument("--output", type=Path, help="Stage into a separate snapshot directory")
args = parser.parse_args()
base = "/rpng-static/ctv/" + args.brand + "/"
root = args.output or Path(__file__).resolve().parents[1] / "upstream" / args.brand
root.mkdir(parents=True, exist_ok=True)
entries = json.loads(args.har.read_bytes())["log"]["entries"]
# Keep only the public en-IE translation dictionary from this CDN response.
labels_url = "https://www.rte.ie/wordpress/wp-content/uploads/standard/skyqsoip/en_IE/label.json"
for entry in entries:
    if entry["request"]["url"] == labels_url and entry["response"]["status"] == 200:
        labels = json.loads(entry["response"]["content"]["text"])
        if not isinstance(labels, dict) or not all(isinstance(v, str) for v in labels.values()):
            raise ValueError("Unexpected translation data")
        (root / "labels.js").write_text("window.__rteFallbackLabels=" + json.dumps(labels) + ";")
        break
else:
    raise ValueError("Missing public en-IE dictionary")

def allowed(name):
    return (re.fullmatch(r"_next/static/[\w./\[\]-]+\.(?:js|css|ttf|woff2?)", name)
            or name in ("index.html", "onetrust.js", "webOSTVjs-1.2.8/webOSTV.js")) and ".." not in name.split("/")

for entry in entries:
    url = urlsplit(entry["request"]["url"])
    res = entry["response"]
    if (url.scheme, url.netloc) != ("https", "www.rte.ie") or url.query or not url.path.startswith(base) or res["status"] != 200:
        continue
    name = url.path[len(base):] or "index.html"
    content = res["content"]
    if not allowed(name) or not content.get("text"):
        continue
    dest = root / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    raw = content["text"]
    dest.write_bytes(base64.b64decode(raw) if content.get("encoding") == "base64" else raw.encode("utf8"))

html = (root / "index.html").read_text()
manifest = (root / re.search(r'src="' + base + r'([^"]+/_buildManifest\.js)"', html)[1]).read_text()
runtime = (root / re.search(r'src="' + base + r'([^"]+/webpack-[^"]+\.js)"', html)[1]).read_text()
assets = set(re.findall(r'(?:src|href)="' + base + r'([^"]+)"', html))
assets.update("_next/" + name for name in re.findall(r'"(static/[^"]+\.(?:js|css))"', manifest))
lazy = re.search(r'\(\(\{([^{}]*)\}\[e\]\|\|e\)\+"\."\+\{([^}]+)\}', runtime) or re.search(r'\(\{([^{}]*)\}\[e\]\|\|e\)\+"\."\+\{([^}]+)\}', runtime)
def entries_of(mapping):
    return dict(re.findall(r'(\d+):"([\da-f]+)"', mapping))
if not lazy:
    raise ValueError("Unrecognized webpack chunk manifest")
aliases, hashes = map(entries_of, lazy.groups())
assets.update("_next/static/chunks/" + aliases.get(i,i) + "." + h + ".js" for i,h in hashes.items())
css = re.search(r'"static/css/"\+\{([^}]+)\}', runtime)
assets.update("_next/static/css/" + h + ".css" for h in entries_of(css[1]).values())
for path in root.rglob("*.css"):
    assets.update(re.findall(r'url\(' + base + r'([^)]*)\)', path.read_text()))

def complete(name):
    if not allowed(name):
        raise ValueError("Unexpected asset path")
    dest = root / name
    if dest.exists():
        return
    data = subprocess.check_output(["curl","-fsSL","--retry","1","--max-time","35","https://www.rte.ie" + quote(base + name, safe="/")])
    if not data or data.lstrip().startswith(b"<"):
        raise ValueError("Missing static asset " + name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)

with ThreadPoolExecutor(max_workers=5) as pool:
    list(pool.map(complete, sorted(assets)))
print(args.brand, len(assets), "manifest assets available")
