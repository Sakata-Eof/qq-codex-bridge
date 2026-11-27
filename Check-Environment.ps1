param([string]$NodePath, [switch]$Media)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\ops\WindowsLifecycle.ps1')
$bridgeNode = Resolve-BridgeNode $PSScriptRoot -NodePath $NodePath
$bridgeArguments = @((Join-Path $PSScriptRoot 'scripts\ops\check-environment.mjs'))
if ($Media) { $bridgeArguments += '--media' }
& $bridgeNode @bridgeArguments
exit $LASTEXITCODE
