param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$speechRequest = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$speechEngine = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $speechEngine.SelectVoice('Microsoft Huihui Desktop')
    $speechEngine.Rate = 0
    $speechEngine.Volume = 90
    $speechFormat = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $speechEngine.SetOutputToWaveFile([string]$speechRequest.output, $speechFormat)
    $speechEngine.Speak([string]$speechRequest.text)
    $speechEngine.SetOutputToNull()
} finally {
    $speechEngine.Dispose()
}
