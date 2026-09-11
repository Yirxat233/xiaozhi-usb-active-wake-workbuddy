# WorkBuddy USB integration

This customer source tree keeps both original hardware targets and adds the verified WorkBuddy
USB transport.

## Hardware profiles

- `viewe-smartring-plus`: new circular board with speaker and battery. The display selector
  `SMARTRING_PLUS_USE_NEW_LCD` remains `1` for the new panel.
- `taiji-pi-s3-pdm`: old magnetic-powered board. The PDM branch is selected with
  `CONFIG_TAIJIPAI_I2S_TYPE_PDM=y`.

## Build on Windows

From this directory:

```powershell
.\build-workbuddy.ps1 -Board all
```

Build only one profile by passing `viewe-smartring-plus` or `taiji-pi-s3-pdm` to `-Board`.

## USB protocol

The host sends one newline-delimited frame beginning with `WB:` followed by JSON. Supported
operations are `status`, `speak_request`, `audio`, `tts_stop`, `ask_request`, `input_audio`,
`input_stop`, and `cancel`. Device responses are emitted as `WBJSON` lines.

Task-completion announcements use local Opus playback. They do not open a Xiaozhi cloud turn and
therefore do not leave the device in listening mode. Voice questions can use `ask_request` to feed
host-generated Opus into a normal cloud conversation.
