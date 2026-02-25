$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mobileDir = Split-Path -Parent $scriptDir
$androidDir = Join-Path $mobileDir "android"

function Resolve-JavaHome {
  if ($env:JAVA_HOME -and (Test-Path $env:JAVA_HOME)) {
    return $env:JAVA_HOME
  }

  $candidates = @(
    "C:\Program Files\Microsoft\jdk-17.0.18.8-hotspot",
    "C:\Program Files\Android\Android Studio\jbr"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  $javaCmd = Get-Command java -ErrorAction SilentlyContinue
  if ($javaCmd) {
    $javaBin = Split-Path -Parent $javaCmd.Source
    $javaHome = Split-Path -Parent $javaBin
    if (Test-Path $javaHome) {
      return $javaHome
    }
  }

  return $null
}

$resolvedJavaHome = Resolve-JavaHome
if (-not $resolvedJavaHome) {
  Write-Error "JAVA_HOME is not set and no local JDK was found."
}

$env:JAVA_HOME = $resolvedJavaHome
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$env:EXPO_NO_METRO_WORKSPACE_ROOT = "1"
$env:NODE_ENV = "production"

Push-Location $androidDir
try {
  & .\gradlew.bat installRelease
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
