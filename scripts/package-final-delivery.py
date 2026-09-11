from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLISH = ROOT / "publish" / "xiaozhi-usb-active-wake-workbuddy"
DELIVERY_ROOT = ROOT / "delivery"
DESTINATION = DELIVERY_ROOT / "xiaozhi-workbuddy-bridge-wb4"
ZIP_PATH = DELIVERY_ROOT / "xiaozhi-workbuddy-bridge-wb4.zip"
RELEASE = ROOT / "firmware-flash-20260908" / "release"


def remove_readonly(function, path, _error) -> None:
    os.chmod(path, stat.S_IWRITE)
    function(path)


def within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def main() -> None:
    if not PUBLISH.exists():
        raise SystemExit("Run prepare-github-publish.py first")
    DELIVERY_ROOT.mkdir(exist_ok=True)
    if DESTINATION.exists():
        if not within(DESTINATION, DELIVERY_ROOT):
            raise SystemExit(f"Refusing to replace unexpected directory: {DESTINATION}")
        shutil.rmtree(DESTINATION, onexc=remove_readonly)
    if ZIP_PATH.exists():
        ZIP_PATH.unlink()

    shutil.copytree(PUBLISH, DESTINATION)
    manifest = json.loads((RELEASE / "manifest.json").read_text(encoding="utf-8"))
    delivery_release = DESTINATION / "release"
    for relative in manifest["files"]:
        source = RELEASE / relative
        target = delivery_release / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copy2(RELEASE / "manifest.json", delivery_release / "manifest.json")

    shutil.make_archive(str(ZIP_PATH.with_suffix("")), "zip", DELIVERY_ROOT, DESTINATION.name)
    digest = hashlib.sha256(ZIP_PATH.read_bytes()).hexdigest()
    checksum = ZIP_PATH.with_suffix(".zip.sha256")
    checksum.write_text(f"{digest}  {ZIP_PATH.name}\n", encoding="ascii")
    print(json.dumps({"zip": str(ZIP_PATH), "bytes": ZIP_PATH.stat().st_size, "sha256": digest}))


if __name__ == "__main__":
    main()
