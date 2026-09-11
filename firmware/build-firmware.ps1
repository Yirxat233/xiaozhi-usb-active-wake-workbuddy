param([string]$Action = 'build')
$ErrorActionPreference = 'Stop'
$buildRoot = $PSScriptRoot
$env:IDF_PATH = Join-Path $buildRoot 'idf'
$env:IDF_TOOLS_PATH = Join-Path $buildRoot 'tools'
$env:IDF_TARGET = 'esp32s3'
$env:HTTPS_PROXY = 'http://127.0.0.1:21081'
$env:HTTP_PROXY = $env:HTTPS_PROXY
$env:PYTHONIOENCODING = 'utf-8'
$env:GIT_CONFIG_COUNT = '2'
$env:GIT_CONFIG_KEY_0 = 'http.proxy'
$env:GIT_CONFIG_VALUE_0 = $env:HTTPS_PROXY
$env:GIT_CONFIG_KEY_1 = 'core.longpaths'
$env:GIT_CONFIG_VALUE_1 = 'true'
$idfPython = Join-Path $buildRoot 'tools\python_env\idf5.5_py3.12_env\Scripts\python.exe'
$toolExports = & $idfPython (Join-Path $env:IDF_PATH 'tools\idf_tools.py') export --format key-value
if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF environment export failed' }
foreach ($entry in $toolExports) {
    if ($entry -match '^([A-Z_]+)=(.*)$') {
        $name = $Matches[1]
        $value = $Matches[2]
        if ($name -eq 'PATH') { $value = $value.Replace('%PATH%', $env:PATH) }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}
Push-Location (Join-Path $buildRoot 'src')
try {
    & $idfPython (Join-Path $env:IDF_PATH 'tools\idf.py') '-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.workbuddy' '-DBOARD_NAME=taiji-pi-s3-pdm' '-DBOARD_TYPE=taiji-pi-s3' $Action
    $firmwareBuildExit = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $firmwareBuildExit
