# Empaqueta el VSIX sin vsce (que pide Node 20 y npm con red). Para publicar se usa vsce: ver PUBLICAR.md.
param([string]$Salida)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content "$raiz\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$nls = Get-Content "$raiz\package.nls.json" -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Salida) { $Salida = Join-Path (Split-Path -Parent $raiz) "$($pkg.name)-$($pkg.version).vsix" }

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($pkg.name)" Version="$($pkg.version)" Publisher="$($pkg.publisher)" />
    <DisplayName>$([Security.SecurityElement]::Escape($nls.displayName))</DisplayName>
    <Description xml:space="preserve">$([Security.SecurityElement]::Escape($nls.description))</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="$($pkg.extensionDependencies -join ',')" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="$($pkg.extensionKind -join ',')" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@
$tipos = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension=".json" ContentType="application/json" /><Default Extension=".png" ContentType="image/png" /><Default Extension=".js" ContentType="application/javascript" />' +
  '<Default Extension=".md" ContentType="text/markdown" /><Default Extension=".txt" ContentType="text/plain" />' +
  '<Default Extension=".vsixmanifest" ContentType="text/xml" /><Override PartName="/extension/LICENSE" ContentType="text/plain" /></Types>'

$ficheros = @('package.json', 'package.nls.json', 'package.nls.es.json', 'extension.js', 'nucleo.js', 'claude-settings.json', 'images/icon.png', 'README.md', 'CHANGELOG.md', 'LICENSE') +
  (Get-ChildItem "$raiz\l10n" -File | ForEach-Object { "l10n/$($_.Name)" })

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (Test-Path $Salida) { Remove-Item $Salida }
$zip = [System.IO.Compression.ZipFile]::Open($Salida, 'Create')
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  foreach ($e in @(@('extension.vsixmanifest', $manifest), @('[Content_Types].xml', $tipos))) {
    $w = New-Object System.IO.StreamWriter(($zip.CreateEntry($e[0])).Open(), $utf8)
    $w.Write($e[1])
    $w.Close()
  }
  # las entradas del zip van con "/": Compress-Archive de PowerShell 5.1 mete "\" y VS Code no las reconoce
  foreach ($f in $ficheros) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $raiz $f), "extension/$f")
  }
} finally {
  $zip.Dispose()
}
Write-Output $Salida
