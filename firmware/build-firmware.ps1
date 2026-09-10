param([string]$Action = 'build')
$ErrorActionPreference = 'Stop'
if (-not (Get-Command idf.py -ErrorAction SilentlyContinue)) {
    throw 'idf.py is not available. Open an ESP-IDF 5.5.2 terminal first.'
}
Push-Location (Join-Path $PSScriptRoot 'xiaozhi-esp32')
try {
    & idf.py '-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.workbuddy' '-DBOARD_NAME=taiji-pi-s3-pdm' '-DBOARD_TYPE=taiji-pi-s3' $Action
    $firmwareBuildExit = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $firmwareBuildExit
