#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$Environment = "production",
    [string]$OutputLocation = "dist",
    [string]$ApiLocation = "api",
    [string]$ApiLanguage = "node",
    [string]$ApiVersion = "20",
    [string]$SwaConfigLocation = ".",
    [switch]$SkipInstall,
    [switch]$SkipBuild,
    [switch]$NoApi
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-Host "> $Command $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $Command @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
    }
}

$repoRoot = $PSScriptRoot
Push-Location $repoRoot

try {
    if ([string]::IsNullOrWhiteSpace($env:SWA_CLI_DEPLOYMENT_TOKEN)) {
        throw @"
SWA_CLI_DEPLOYMENT_TOKEN is not set.

Set it for this PowerShell session, then run this script again:
  `$env:SWA_CLI_DEPLOYMENT_TOKEN = "<your-static-web-app-deployment-token>"
  .\deploy-static-web-app.ps1
"@
    }

    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm was not found. Install Node.js/npm before deploying."
    }

    if (-not $SkipInstall) {
        if (Test-Path "package-lock.json") {
            Invoke-NativeCommand "npm" @("ci")
        }
        else {
            Invoke-NativeCommand "npm" @("install")
        }
    }

    if (-not $SkipBuild) {
        Invoke-NativeCommand "npm" @("run", "build")
    }

    $outputPath = Join-Path $repoRoot $OutputLocation
    if (-not (Test-Path $outputPath -PathType Container)) {
        throw "Build output folder not found: $OutputLocation"
    }

    $configPath = Join-Path (Join-Path $repoRoot $SwaConfigLocation) "staticwebapp.config.json"
    if (-not (Test-Path $configPath -PathType Leaf)) {
        throw "Static Web Apps config file not found: $configPath"
    }

    $deployArgs = @(
        "-y",
        "@azure/static-web-apps-cli@latest",
        "deploy",
        $OutputLocation,
        "--env",
        $Environment,
        "--swa-config-location",
        $SwaConfigLocation
    )

    if (-not $NoApi) {
        $apiPath = Join-Path $repoRoot $ApiLocation
        if (-not (Test-Path $apiPath -PathType Container)) {
            throw "API folder not found: $ApiLocation. Use -NoApi to deploy the frontend only."
        }

        $deployArgs += @(
            "--api-location",
            $ApiLocation,
            "--api-language",
            $ApiLanguage,
            "--api-version",
            $ApiVersion
        )
    }

    Invoke-NativeCommand "npx" $deployArgs
    Write-Host "Static Web App deployment completed." -ForegroundColor Green
}
finally {
    Pop-Location
}
