param(
  [ValidateSet("administrative_cases", "criminal_cases", "civil_cases", "all")]
  [string]$Table = "civil_cases",

  [ValidateRange(1, 100)]
  [int]$BatchSize = 10,

  [ValidateRange(1, 100000)]
  [int]$MaxBatches = 1,

  [ValidateRange(0, 3600)]
  [int]$DelaySeconds = 2,

  [string]$ProjectRef = "bvwdvdiressqpnbsvhqf",

  [string]$InvokerKey = "",

  [switch]$StopOnFailure
)

$ErrorActionPreference = "Stop"

function Read-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  $line = Get-Content -LiteralPath $Path |
    Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } |
    Select-Object -First 1

  if (-not $line) {
    return $null
  }

  return ($line -replace "^\s*$([regex]::Escape($Name))\s*=\s*", "").Trim()
}

if (-not $InvokerKey) {
  $envPath = Join-Path $PSScriptRoot "..\.env"
  $InvokerKey = Read-DotEnvValue -Path $envPath -Name "SB_PUBLISHABLE_KEY"
}

if (-not $InvokerKey) {
  $secure = Read-Host "Paste Supabase service role or publishable key" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $InvokerKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if (-not $InvokerKey) {
  throw "No Supabase invocation key was provided."
}

$url = "https://${ProjectRef}.supabase.co/functions/v1/batch-index-embeddings"
$headers = @{
  apikey = $InvokerKey
  Authorization = "Bearer $InvokerKey"
  "Content-Type" = "application/json"
}

$tables = if ($Table -eq "all") {
  @("administrative_cases", "criminal_cases", "civil_cases")
} else {
  @($Table)
}

foreach ($currentTable in $tables) {
  Write-Host "Starting $currentTable embeddings with batch size $BatchSize, max batches $MaxBatches"

  for ($i = 1; $i -le $MaxBatches; $i++) {
    $body = @{
      table = $currentTable
      batch_size = $BatchSize
    } | ConvertTo-Json -Compress

    try {
      $result = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -Body $body -TimeoutSec 300
    } catch {
      if ($_.Exception.Response) {
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        throw "HTTP $([int]$_.Exception.Response.StatusCode): $responseBody"
      }

      throw
    }

    $processed = if ($null -ne $result.processed) { [int]$result.processed } else { 0 }
    $failed = if ($null -ne $result.failed) { [int]$result.failed } else { 0 }

    $chunks = 0
    $cases = 0
    if ($result.results) {
      foreach ($tableResult in $result.results) {
        if ($null -ne $tableResult.chunks_in_batch) {
          $chunks += [int]$tableResult.chunks_in_batch
        }
        if ($null -ne $tableResult.cases_in_batch) {
          $cases += [int]$tableResult.cases_in_batch
        }
      }
    }

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] $currentTable batch $i/$MaxBatches processed_chunks=$processed failed=$failed cases=$cases chunks=$chunks"

    if ($result.results) {
      foreach ($tableResult in $result.results) {
        if ($tableResult.errors) {
          $tableResult.errors | ConvertTo-Json -Depth 8
        }
      }
    }

    if ($StopOnFailure -and $failed -gt 0) {
      throw "Stopping because failed=$failed for $currentTable."
    }

    $isDone = $false
    if ($result.results) {
      $isDone = @($result.results | Where-Object { $_.done -eq $true }).Count -gt 0
    }

    if ($isDone -or $processed -le 0) {
      Write-Host "Finished $currentTable."
      break
    }

    if ($DelaySeconds -gt 0 -and $i -lt $MaxBatches) {
      Start-Sleep -Seconds $DelaySeconds
    }
  }
}
