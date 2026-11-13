"""Package the prebuilt TV app as an unsigned public release asset."""
import argparse
from pathlib import Path
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=root / 'dist')
args = parser.parse_args()
version = (root / 'VERSION').read_text().strip()
app = root / 'tv-app'
manifest = ET.parse(app / 'config.xml').getroot()
manifest_version = version + '.0' if len(version.split('.')) == 2 else version
if manifest.attrib['version'] != manifest_version:
    raise SystemExit('VERSION and config.xml do not agree')
config = (app / 'login-helper-config.js').read_text().strip()
if config != 'window.__rteLoginHelper={"url":"","key":""};':
    raise SystemExit('Public release requires empty helper settings')
args.output.mkdir(parents=True, exist_ok=True)
output = args.output / ('rte-player-' + version + '-unsigned.wgt')
with ZipFile(output.with_suffix('.tmp'), 'w', ZIP_DEFLATED) as archive:
    for path in sorted(app.rglob('*')):
        if path.is_file() and not any(part.startswith('.') for part in path.relative_to(app).parts):
            if path.name == 'author-signature.xml' or path.name.startswith('signature') and path.suffix == '.xml':
                continue
            archive.write(path, path.relative_to(app).as_posix())
    archive.write(root / 'README.md', 'CONFIGURE.md')
output.with_suffix('.tmp').replace(output)
print(output)
