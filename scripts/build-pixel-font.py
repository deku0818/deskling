"""Build the local UI font subset. Requires fonttools[woff].
Usage: python scripts/build-pixel-font.py [--archive /path/to/release.zip]
"""
from pathlib import Path
import argparse,io,json,urllib.request,zipfile
from fontTools.ttLib import TTFont
from fontTools import subset
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--archive');args=parser.parse_args()
url='https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.09.25/fusion-pixel-font-12px-monospaced-otf.woff2-v2026.09.25.zip'
if args.archive:data=Path(args.archive).read_bytes()
else:
 with urllib.request.urlopen(url,timeout=30) as response:data=response.read()
archive=zipfile.ZipFile(io.BytesIO(data))
font=TTFont(io.BytesIO(archive.read('fusion-pixel-12px-monospaced-zh_hans.otf.woff2')))
text=(root/'web/index.html').read_text()+''.join(chr(c) for c in range(32,127))
options=subset.Options();options.name_IDs=[0,1,2,3,4,5,6,13,14]
subsetter=subset.Subsetter(options=options);subsetter.populate(text=text);subsetter.subset(font)
font.flavor='woff2'
destination=root/'assets/fonts';destination.mkdir(parents=True,exist_ok=True)
font.save(destination/'deck-pixel.woff2')
for name in ['OFL.txt','LICENSES/ark-pixel/OFL.txt','LICENSES/cubic-11/OFL.txt','LICENSES/galmuri/LICENSE.txt']:
 target=destination/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.read(name))
(destination/'source.json').write_text(json.dumps({'family':'Fusion Pixel Font','version':'2026.09.25','source':url,'repository':'https://github.com/TakWolf/fusion-pixel-font','file':'deck-pixel.woff2','subset':'Current UI text plus printable ASCII. Rebuild after adding new characters.','bytes':(destination/'deck-pixel.woff2').stat().st_size},ensure_ascii=False,indent=2)+'\n')
print('UI pixel font:',(destination/'deck-pixel.woff2').stat().st_size,'bytes')
