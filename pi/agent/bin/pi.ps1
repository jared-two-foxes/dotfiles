#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$launcher=Join-Path $basedir "pi-launcher.js"
if ($MyInvocation.ExpectingInput) {
  $input | & node $launcher $args
} else {
  & node $launcher $args
}
exit $LASTEXITCODE
