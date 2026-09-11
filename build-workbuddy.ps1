param(
    [ValidateSet('all', 'viewe-smartring-plus', 'taiji-pi-s3-pdm')]
    [string]$Board = 'all',
    [ValidateSet('build', 'fullclean')]
    [string]$Action = 'build'
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$toolchainRoot = Join-Path (Split-Path $projectRoot -Parent) 'fwb'
$env:IDF_PATH = Join-Path $toolchainRoot 'idf'
$env:IDF_TOOLS_PATH = Join-Path $toolchainRoot 'tools'
$env:IDF_TARGET = 'esp32s3'
$env:PYTHONIOENCODING = 'utf-8'

# Reuse the local proxy that is already used by the verified firmware toolchain.
if (-not $env:HTTPS_PROXY) {
    $env:HTTPS_PROXY = 'http://127.0.0.1:21081'
}
if (-not $env:HTTP_PROXY) {
    $env:HTTP_PROXY = $env:HTTPS_PROXY
}
$env:GIT_CONFIG_COUNT = '2'
$env:GIT_CONFIG_KEY_0 = 'http.proxy'
$env:GIT_CONFIG_VALUE_0 = $env:HTTPS_PROXY
$env:GIT_CONFIG_KEY_1 = 'core.longpaths'
$env:GIT_CONFIG_VALUE_1 = 'true'

$idfPython = Join-Path $toolchainRoot 'tools\python_env\idf5.5_py3.12_env\Scripts\python.exe'
$idfPy = Join-Path $env:IDF_PATH 'tools\idf.py'
if (-not (Test-Path -LiteralPath $idfPython)) {
    throw "ESP-IDF Python environment not found: $idfPython"
}

$toolExports = & $idfPython (Join-Path $env:IDF_PATH 'tools\idf_tools.py') export --format key-value
if ($LASTEXITCODE -ne 0) {
    throw 'ESP-IDF environment export failed'
}
foreach ($entry in $toolExports) {
    if ($entry -match '^([A-Z_]+)=(.*)$') {
        $name = $Matches[1]
        $value = $Matches[2]
        if ($name -eq 'PATH') {
            $value = $value.Replace('%PATH%', $env:PATH)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

$profiles = @(
    @{
        Name = 'viewe-smartring-plus'
        BoardType = 'viewe-smartring-plus'
        Defaults = 'sdkconfig.defaults.workbuddy-viewe'
    },
    @{
        Name = 'taiji-pi-s3-pdm'
        BoardType = 'taiji-pi-s3'
        Defaults = 'sdkconfig.defaults.workbuddy-taiji-pdm'
    }
)
if ($Board -ne 'all') {
    $profiles = $profiles | Where-Object { $_.Name -eq $Board }
}

Push-Location $projectRoot
try {
    foreach ($profile in $profiles) {
        $buildDir = "build-workbuddy-$($profile.Name)"
        $sdkconfig = "sdkconfig.workbuddy.$($profile.Name)"
        $defaults = "sdkconfig.defaults;sdkconfig.defaults.esp32s3;$($profile.Defaults)"
        Write-Host "Building WorkBuddy firmware profile: $($profile.Name)"
        & $idfPython $idfPy "-B$buildDir" "-DSDKCONFIG=$sdkconfig" `
            "-DSDKCONFIG_DEFAULTS=$defaults" "-DBOARD_NAME=$($profile.Name)" `
            "-DBOARD_TYPE=$($profile.BoardType)" $Action
        if ($LASTEXITCODE -ne 0) {
            throw "Firmware $Action failed for $($profile.Name)"
        }
    }
} finally {
    Pop-Location
}
