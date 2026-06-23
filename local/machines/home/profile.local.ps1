# =============================================================
# local/machines/home/profile.local.ps1
# Home machine PowerShell overrides.
#
# COMMITTED — contains no secrets. Fill in your values.
# Deployed alongside Microsoft.PowerShell_profile.ps1 by the
# install script. Sourced last by the main profile.
# =============================================================

# --- Machine-specific PATH additions -------------------------
# $localBin = 'C:\tools\bin'
# if (Test-Path $localBin) { $env:PATH = "$localBin;$env:PATH" }

# --- Knowledge base root (Librarian / Lorekeeper agents) ------
$env:VAULT_ROOT = 'C:\Users\iapet\knowledge\vault'

# --- Personal aliases / functions ----------------------------
# function proj { Set-Location 'C:\Users\you\projects' }
