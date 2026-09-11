from __future__ import annotations

import argparse
import json
import mimetypes
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "xiaozhi-usb-active-wake-workbuddy"
TAG = "wb4"


def github_credential() -> tuple[str, str]:
    process = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        text=True,
        capture_output=True,
        check=True,
    )
    values = dict(line.split("=", 1) for line in process.stdout.splitlines() if "=" in line)
    if not values.get("username") or not values.get("password"):
        raise RuntimeError("GitHub credential is unavailable")
    return values["username"], values["password"]


def request(token: str, method: str, url: str, body: object | bytes | None = None,
            content_type: str = "application/json") -> object:
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "xiaozhi-workbuddy-release-publisher")
    if data is not None:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=120) as response:
        payload = response.read()
        return json.loads(payload) if payload else {}


def create_repository(owner: str, token: str) -> dict:
    try:
        repository = request(token, "POST", "https://api.github.com/user/repos", {
            "name": REPOSITORY,
            "description": "USB-initiated official Xiaozhi cloud conversations for ESP32-S3, with WorkBuddy integration.",
            "private": False,
            "has_issues": True,
            "has_projects": False,
            "has_wiki": False,
        })
    except urllib.error.HTTPError as error:
        if error.code != 422:
            raise
        repository = request(token, "GET", f"https://api.github.com/repos/{owner}/{REPOSITORY}")
    request(token, "PUT", f"https://api.github.com/repos/{owner}/{REPOSITORY}/topics", {
        "names": ["xiaozhi", "esp32-s3", "usb", "workbuddy", "active-wake", "mcp"]
    })
    return repository


def create_release(owner: str, token: str) -> dict:
    release = request(token, "POST", f"https://api.github.com/repos/{owner}/{REPOSITORY}/releases", {
        "tag_name": TAG,
        "target_commitish": "main",
        "name": "wb4 — reliable USB active wake with WorkBuddy",
        "body": (
            "This is the first verified release of the USB-initiated conversation path.\n\n"
            "WorkBuddy sends a task notification over USB as silent upstream Opus audio. The ESP32 "
            "opens a normal xiaozhi.me session without a wake word, and the official cloud service "
            "performs STT, LLM processing, and TTS so the final response uses Xiaozhi's configured voice.\n\n"
            "wb4 prevents the notification speaker tail from triggering WakeNet, waits for playback to drain "
            "before returning to idle, and persists pending WorkBuddy notifications across Bridge restarts.\n\n"
            "Verified hardware: Guition/JC3636W518 V2, 360×360 ST77916 display, PDM microphone, "
            "16 MB flash and 8 MB PSRAM (`taiji-pi-s3-pdm`).\n\n"
            "Flash the merged `.bin` at address `0x0`. This erases NVS, so Wi-Fi and device activation "
            "must be configured again. See `LOCAL_USB_GUIDE.md` before flashing."
        ),
        "draft": False,
        "prerelease": False,
        "make_latest": "true",
    })
    assets = [
        ROOT / "firmware-flash-20260908" / "release" /
            "xiaozhi-2.2.3-taiji-pi-s3-v2-active-speak-workbuddy-wb4.bin",
        ROOT / "firmware-flash-20260908" / "release" /
            "xiaozhi-2.2.3-taiji-pi-s3-v2-active-speak-workbuddy-wb4-source.zip",
        ROOT / "firmware-flash-20260908" / "release" / "manifest.json",
    ]
    upload_url = str(release["upload_url"]).split("{", 1)[0]
    uploaded = []
    for asset in assets:
        media_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
        result = request(
            token,
            "POST",
            f"{upload_url}?name={urllib.parse.quote(asset.name)}",
            asset.read_bytes(),
            media_type,
        )
        uploaded.append({"name": result["name"], "size": result["size"]})
    return {"html_url": release["html_url"], "assets": uploaded}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["repo", "release"])
    args = parser.parse_args()
    owner, token = github_credential()
    if args.action == "repo":
        repository = create_repository(owner, token)
        print(json.dumps({"owner": owner, "html_url": repository["html_url"],
                          "clone_url": repository["clone_url"]}))
    else:
        print(json.dumps(create_release(owner, token)))


if __name__ == "__main__":
    main()
