param(
    [string]$OutputRoot = (Join-Path (Split-Path $PSScriptRoot -Parent) 'delivery\smart-ring-pluss-workbuddy-wb5')
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$toolchainRoot = Join-Path (Split-Path $projectRoot -Parent) 'fwb'
$idfPython = Join-Path $toolchainRoot 'tools\python_env\idf5.5_py3.12_env\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $idfPython)) {
    throw 'ESP-IDF packaging tools are missing. Build the firmware toolchain first.'
}

$profiles = @(
    @{
        Build = 'build-workbuddy-viewe-smartring-plus'
        Output = '01-viewe-smartring-plus-new-hardware'
        Assets = 'expression_assets.bin'
    },
    @{
        Build = 'build-workbuddy-taiji-pi-s3-pdm'
        Output = '02-taiji-pi-s3-pdm-old-hardware'
        Assets = 'generated_assets.bin'
    }
)

New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'WORKBUDDY_FLASH_README.txt') `
    -Destination (Join-Path $OutputRoot 'README.txt') -Force

foreach ($profile in $profiles) {
    $build = Join-Path $projectRoot $profile.Build
    $output = Join-Path $OutputRoot $profile.Output
    $bootloaderOutput = Join-Path $output 'bootloader'
    $partitionOutput = Join-Path $output 'partition_table'
    New-Item -ItemType Directory -Force -Path $bootloaderOutput, $partitionOutput | Out-Null

    $required = @(
        'bootloader\bootloader.bin',
        'partition_table\partition-table.bin',
        'ota_data_initial.bin',
        'xiaozhi.bin',
        $profile.Assets,
        'flash_args',
        'flasher_args.json'
    )
    foreach ($relativePath in $required) {
        $source = Join-Path $build $relativePath
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Missing build artifact: $source"
        }
        $destination = Join-Path $output $relativePath
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }

    $merged = Join-Path $output 'merged-flash-16MB.bin'
    & $idfPython -m esptool --chip esp32s3 merge_bin -o $merged `
        --flash_mode dio --flash_size 16MB --flash_freq 80m `
        0x0 (Join-Path $build 'bootloader\bootloader.bin') `
        0x8000 (Join-Path $build 'partition_table\partition-table.bin') `
        0xd000 (Join-Path $build 'ota_data_initial.bin') `
        0x20000 (Join-Path $build 'xiaozhi.bin') `
        0x800000 (Join-Path $build $profile.Assets)
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to merge firmware for $($profile.Output)"
    }
}

$hashes = Get-ChildItem -LiteralPath $OutputRoot -Recurse -File |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
    Sort-Object FullName |
    ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($OutputRoot, $_.FullName).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    }
Set-Content -LiteralPath (Join-Path $OutputRoot 'SHA256SUMS.txt') -Value $hashes -Encoding utf8

$zipPath = "$OutputRoot.zip"
Compress-Archive -LiteralPath $OutputRoot -DestinationPath $zipPath -Force
Write-Host "Delivery package: $zipPath"
