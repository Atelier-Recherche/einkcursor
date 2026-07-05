#Requires -Version 5.1
param(
    [ValidateSet('Patch', 'Minor', 'Major')]
    [string] $BumpKind = 'Patch',
    [switch] $SkipBuild,
    [switch] $NoPush,
    [string] $Remote = 'origin'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ReleaseNotesFile = 'eink-cursor-release-notes.md'
$ReleaseNotesTitle = 'Eink Cursor'
$GhActionsUrl = 'https://github.com/Morglaf/einkcursor/actions'

function Test-CommandExists {
    param([Parameter(Mandatory)][string] $Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Set-Utf8NoBomFile {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Content
    )
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

function Get-NextSemVer {
    param(
        [Parameter(Mandatory)][string] $Version,
        [Parameter(Mandatory)][ValidateSet('Patch', 'Minor', 'Major')][string] $Kind
    )
    if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        throw "Version non semver: $Version"
    }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3]
    switch ($Kind) {
        'Major' { return "$($major + 1).0.0" }
        'Minor' { return "$major.$($minor + 1).0" }
        'Patch' { return "$major.$minor.$($patch + 1)" }
    }
}

$repoRoot = $PSScriptRoot
Set-Location -LiteralPath $repoRoot

foreach ($cmd in @('git', 'node', 'npm')) {
    if (-not (Test-CommandExists $cmd)) { throw "Commande introuvable: $cmd" }
}

foreach ($p in @('package.json', 'manifest.json', 'versions.json', 'version-bump.mjs', 'styles.css', 'main.js', '.github/workflows/obsidian-plugin-release.yml')) {
    if (-not (Test-Path $p)) { throw "Fichier requis absent: $p" }
}

$dirty = (& git status --porcelain 2>&1 | Out-String).Trim()
if ($dirty) { throw "Arbre Git non propre.`n$dirty" }

$packageRaw = Get-Content package.json -Raw -Encoding UTF8
$currentVersion = [string](($packageRaw | ConvertFrom-Json).version)
$newVersion = Get-NextSemVer -Version $currentVersion -Kind $BumpKind

$updatedPackage = [regex]::Replace(
    $packageRaw,
    '("version"\s*:\s*")' + [regex]::Escape($currentVersion) + '(")',
    '${1}' + $newVersion + '$2',
    1
)
Set-Utf8NoBomFile -Path package.json -Content $updatedPackage

$env:npm_package_version = $newVersion
try {
    & node version-bump.mjs
    if ($LASTEXITCODE -ne 0) { throw "version-bump.mjs a échoué." }
} finally {
    Remove-Item Env:\npm_package_version -ErrorAction SilentlyContinue
}

$lastTag = $null
$describeResult = & git describe --tags --abbrev=0 --match '[0-9]*.[0-9]*.[0-9]*' 2>&1
if ($LASTEXITCODE -eq 0) { $lastTag = ($describeResult | Out-String).Trim() }
$logLines = if ($lastTag) { & git log "$lastTag..HEAD" --oneline 2>&1 } else { & git log --oneline -n 30 2>&1 }
Set-Utf8NoBomFile -Path (Join-Path $repoRoot $ReleaseNotesFile) -Content ("# $ReleaseNotesTitle $newVersion`n`n" + ($logLines | Out-String).Trim() + "`n")

if (-not $SkipBuild) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build a échoué." }
}

& git rev-parse --verify --quiet "refs/tags/$newVersion" 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw "Tag $newVersion existe déjà." }

& git add package.json manifest.json versions.json styles.css main.js $ReleaseNotesFile
if ($LASTEXITCODE -ne 0) { throw "git add a échoué." }

& git commit -m "release(plugin): $newVersion"
if ($LASTEXITCODE -ne 0) { throw "git commit a échoué." }

& git tag -a $newVersion -m $newVersion
if ($LASTEXITCODE -ne 0) { throw "git tag a échoué." }

if ($NoPush) { Write-Host "Release $newVersion préparée (-NoPush)." -ForegroundColor Green; exit 0 }

& git push $Remote HEAD
& git push $Remote "refs/tags/$newVersion"
Write-Host "Release $newVersion poussée." -ForegroundColor Green
Write-Host "Suivi : $GhActionsUrl" -ForegroundColor Gray
