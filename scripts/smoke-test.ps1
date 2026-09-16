<#
.SYNOPSIS
    End-to-end smoke test of the running stack.

.DESCRIPTION
    Exercises every endpoint that exists today, including the ones that are
    supposed to FAIL. A test run where nothing is refused proves nothing:
    authorisation failing closed is the property most worth checking.

    Prerequisites: npm run dev:up, npm run db:migrate, and the API running.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
#>

$ErrorActionPreference = 'Stop'

$Api      = if ($env:API_URL)      { $env:API_URL }      else { 'http://localhost:3000' }
$Keycloak = if ($env:KEYCLOAK_URL) { $env:KEYCLOAK_URL } else { 'http://localhost:8085' }
$Realm    = 'tax-assessment'

$script:Passed = 0
$script:Failed = 0

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Method = 'GET',
        [string]$Url,
        [string]$Token,
        [int]$ExpectStatus
    )

    $headers = @{}
    if ($Token) { $headers['Authorization'] = "Bearer $Token" }

    # -SkipHttpErrorCheck is PowerShell 7+. Windows PowerShell 5.1 throws on
    # any non-2xx instead, and the status has to be dug out of the exception.
    # Half of what this script checks is a deliberate 401/403, so getting this
    # wrong makes every negative test look like a connection failure.
    try {
        $response = Invoke-WebRequest -Uri $Url -Method $Method -Headers $headers `
                    -UseBasicParsing -TimeoutSec 15
        $status = [int]$response.StatusCode
    } catch {
        $webResponse = $null
        if ($_.Exception.PSObject.Properties.Name -contains 'Response') {
            $webResponse = $_.Exception.Response
        }
        if ($null -ne $webResponse -and
            $webResponse.PSObject.Properties.Name -contains 'StatusCode') {
            $status = [int]$webResponse.StatusCode
        } else {
            # A genuine connection failure, not an HTTP error response.
            $status = 0
        }
    }

    if ($status -eq $ExpectStatus) {
        Write-Host ("  PASS  {0,-46} {1}" -f $Name, $status) -ForegroundColor Green
        $script:Passed++
    } else {
        Write-Host ("  FAIL  {0,-46} got {1}, expected {2}" -f $Name, $status, $ExpectStatus) -ForegroundColor Red
        $script:Failed++
    }
}

function Get-Token {
    param([string]$Username)
    $body = @{
        client_id  = 'tas-web'
        username   = $Username
        password   = 'password'
        grant_type = 'password'
    }
    try {
        $response = Invoke-RestMethod -Method Post -TimeoutSec 15 `
            -Uri "$Keycloak/realms/$Realm/protocol/openid-connect/token" -Body $body
        return $response.access_token
    } catch {
        Write-Host "  Could not obtain a token for $Username. Is Keycloak up on $Keycloak ?" -ForegroundColor Red
        return $null
    }
}

Write-Host ''
Write-Host 'Tax Assessment System - smoke test' -ForegroundColor Cyan
Write-Host "API      $Api"
Write-Host "Keycloak $Keycloak"
Write-Host ''

# ---------------------------------------------------------------- health
Write-Host 'Health (no authentication required)' -ForegroundColor Yellow
Test-Endpoint -Name 'liveness'  -Url "$Api/health/live"  -ExpectStatus 200
Test-Endpoint -Name 'readiness (database + redis)' -Url "$Api/health/ready" -ExpectStatus 200
Test-Endpoint -Name 'OpenAPI document' -Url "$Api/api/docs-json" -ExpectStatus 200

# -------------------------------------------------------- unauthenticated
Write-Host ''
Write-Host 'Unauthenticated access must be refused' -ForegroundColor Yellow
Test-Endpoint -Name 'no token'        -Url "$Api/api/v1/me" -ExpectStatus 401
Test-Endpoint -Name 'garbage token'   -Url "$Api/api/v1/me" -Token 'not.a.token' -ExpectStatus 401
Test-Endpoint -Name 'workflow webhook rejects a GET' -Url "$Api/api/v1/workflow/events" -ExpectStatus 404

# --------------------------------------------------------------- tokens
Write-Host ''
Write-Host 'Obtaining tokens from Keycloak' -ForegroundColor Yellow
$assessor = Get-Token -Username 'assessor'
$admin    = Get-Token -Username 'admin-tax'
if ($assessor) { Write-Host '  PASS  assessor token obtained' -ForegroundColor Green; $script:Passed++ }
else           { Write-Host '  FAIL  assessor token'          -ForegroundColor Red;   $script:Failed++ }
if ($admin)    { Write-Host '  PASS  admin token obtained'    -ForegroundColor Green; $script:Passed++ }
else           { Write-Host '  FAIL  admin token'             -ForegroundColor Red;   $script:Failed++ }

if (-not $assessor -or -not $admin) {
    Write-Host ''
    Write-Host 'Cannot continue without tokens.' -ForegroundColor Red
    exit 1
}

# ------------------------------------------------------------ authorised
Write-Host ''
Write-Host 'Authorised access' -ForegroundColor Yellow
Test-Endpoint -Name 'assessor reads own profile' -Url "$Api/api/v1/me" -Token $assessor -ExpectStatus 200
Test-Endpoint -Name 'assessor reads a master group' -Url "$Api/api/v1/masters/ADJUSTMENT_TYPE" -Token $assessor -ExpectStatus 200
Test-Endpoint -Name 'admin reads the permission catalogue' -Url "$Api/api/v1/admin/permissions" -Token $admin -ExpectStatus 200
Test-Endpoint -Name 'admin refreshes the authz cache' -Method POST -Url "$Api/api/v1/admin/permissions/refresh-cache" -Token $admin -ExpectStatus 201

# ----------------------------------------------------- authorisation denies
Write-Host ''
Write-Host 'Authorisation must discriminate, not rubber-stamp' -ForegroundColor Yellow
Test-Endpoint -Name 'assessor CANNOT list all masters' -Url "$Api/api/v1/masters" -Token $assessor -ExpectStatus 403
Test-Endpoint -Name 'assessor CANNOT read permissions' -Url "$Api/api/v1/admin/permissions" -Token $assessor -ExpectStatus 403
Test-Endpoint -Name 'assessor CANNOT refresh the cache' -Method POST -Url "$Api/api/v1/admin/permissions/refresh-cache" -Token $assessor -ExpectStatus 403
Test-Endpoint -Name 'unregistered route is unreachable' -Url "$Api/api/v1/masters/A/B/C" -Token $admin -ExpectStatus 404

# --------------------------------------------------------------- content
Write-Host ''
Write-Host 'Response content' -ForegroundColor Yellow
try {
    $me = Invoke-RestMethod -Uri "$Api/api/v1/me" -Headers @{ Authorization = "Bearer $assessor" }
    Write-Host "  username      $($me.username)"
    Write-Host "  userId        $($me.userId)"
    Write-Host "  roles         $($me.roleCodes -join ', ')"
    Write-Host "  jurisdiction  $($me.jurisdictionCode)"
    Write-Host "  permissions   $($me.permissions.Count) route(s)"
    foreach ($p in $me.permissions) { Write-Host "                  $p" }

    $group = Invoke-RestMethod -Uri "$Api/api/v1/masters/ADJUSTMENT_TYPE" -Headers @{ Authorization = "Bearer $assessor" }
    Write-Host "  master group  $($group.groupCode) with $($group.items.Count) items"

    $script:Passed++
    Write-Host '  PASS  content looks right' -ForegroundColor Green
} catch {
    Write-Host "  FAIL  could not read content: $_" -ForegroundColor Red
    $script:Failed++
}

# ---------------------------------------------------------------- summary
Write-Host ''
Write-Host ('-' * 62)
Write-Host ("Passed: {0}   Failed: {1}" -f $script:Passed, $script:Failed) `
    -ForegroundColor $(if ($script:Failed -eq 0) { 'Green' } else { 'Red' })
Write-Host ''

if ($script:Failed -gt 0) { exit 1 }
