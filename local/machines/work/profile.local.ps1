# =============================================================
# local/machines/work/profile.local.ps1
# Work machine PowerShell overrides (Windows).
#
# COMMITTED — contains no secrets. Fill in your values.
# Deployed alongside Microsoft.PowerShell_profile.ps1 by the
# install script. Sourced last by the main profile.
# =============================================================

# --- Corporate proxy -----------------------------------------
# $proxy = 'http://proxy.company.com:8080'
# $env:HTTP_PROXY  = $proxy
# $env:HTTPS_PROXY = $proxy
# $env:NO_PROXY    = 'localhost,127.0.0.1,.company.com'
# [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy($proxy)
# [System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials

# --- Machine-specific PATH additions -------------------------
# $localBin = 'C:\tools\bin'
# if (Test-Path $localBin) { $env:PATH = "$localBin;$env:PATH" }

# --- Work aliases / functions --------------------------------
# function connect-vpn { & 'C:\Program Files\VPN\vpn.exe' connect }
