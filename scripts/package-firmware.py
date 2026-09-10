"""Package the verified build without private device flash backups."""
import hashlib
import json
import shutil
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
source = root / 'fwb/src'
build = source / 'build'
release = root / 'firmware-flash-20260908/release'
release.mkdir(parents=True, exist_ok=True)
name = 'xiaozhi-2.2.3-taiji-pi-s3-v2-active-speak-workbuddy-wb2'
shutil.copy2(build / 'merged-binary.bin', release / f'{name}.bin')
args = json.loads((build / 'flasher_args.json').read_text())
for relative in args['flash_files'].values():
    target = release / 'segments' / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(build / relative, target)
shutil.copy2(build / 'flasher_args.json', release / 'segments/flasher_args.json')
shutil.copy2(root / 'LOCAL_USB_GUIDE.md', release / 'LOCAL_USB_GUIDE.md')
shutil.copy2(root / 'firmware-flash-20260908/pr-1939.diff', release / 'upstream-pr-1939.diff')
with zipfile.ZipFile(release / f'{name}-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in source.rglob('*'):
        relative = path.relative_to(source)
        if any(part in {'.git', 'build', 'managed_components', '__pycache__'} for part in relative.parts):
            continue
        if path.is_file():
            archive.write(path, Path('xiaozhi-esp32') / relative)
    archive.write(root / 'fwb/build-firmware.ps1', 'build-firmware.ps1')
manifest = {
    'version': '2.2.3-taiji-pdm-wb2',
    'hardware': 'JC3636W518 V2 / taiji-pi-s3-pdm / 16MB flash / 8MB PSRAM',
    'esp_idf': '5.5.2',
    'base': 'https://github.com/78/xiaozhi-esp32/tree/v2.2.3',
    'active_speak_pr': 'https://github.com/78/xiaozhi-esp32/pull/1939',
    'pr_head': '16144bb612fe17a5c689be64094b9a9cfff7123b',
    'merged_flash_address': '0x0',
    'merged_resets_nvs': True,
    'actual_flash_preserved_nvs': True,
    'files': {}
}
for path in sorted(release.rglob('*')):
    if path.is_file() and path.name != 'manifest.json' and '-OLD' not in path.name:
        manifest['files'][path.relative_to(release).as_posix()] = {
            'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()
        }
(release / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'release': str(release), 'files': len(manifest['files']), 'firmware': manifest['files'][f'{name}.bin']}))
