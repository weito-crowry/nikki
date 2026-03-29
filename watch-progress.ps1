param(
  [string]$ProgressPath = ".\output\run-001\progress.json",
  [int]$IntervalSeconds = 2
)

$resolvedPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $ProgressPath))

function Get-JapanNowString {
  $utc = [DateTimeOffset]::UtcNow
  $jst = $utc.ToOffset([TimeSpan]::FromHours(9))
  return $jst.ToString("yyyy/MM/dd HH:mm:ss 'JST'")
}

function Convert-ToJapanDisplayString {
  param(
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return "-"
  }

  try {
    $dto = [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture)
    return $dto.ToOffset([TimeSpan]::FromHours(9)).ToString("yyyy/MM/dd HH:mm:ss 'JST'")
  } catch {
    try {
      $dto = [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::GetCultureInfo("ja-JP"))
      return $dto.ToOffset([TimeSpan]::FromHours(9)).ToString("yyyy/MM/dd HH:mm:ss 'JST'")
    } catch {
      return $Value
    }
  }
}

function Format-Value {
  param(
    [Parameter(ValueFromPipeline = $true)]
    $Value
  )

  if ($null -eq $Value) {
    return "-"
  }

  if ($Value -is [System.Array]) {
    return ($Value -join " - ")
  }

  return [string]$Value
}

function Show-ProgressFile {
  param(
    [string]$Path
  )

  Clear-Host
  Write-Host "Nikki Progress Monitor" -ForegroundColor Cyan
  Write-Host "file: $Path"
  Write-Host "time: $(Get-JapanNowString)"
  Write-Host ""

  if (-not (Test-Path $Path)) {
    Write-Host "progress.json がまだありません。処理開始を待機中です。" -ForegroundColor Yellow
    return
  }

  try {
    $raw = Get-Content $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
      Write-Host "progress.json は空です。" -ForegroundColor Yellow
      return
    }

    $data = $raw | ConvertFrom-Json
  } catch {
    Write-Host "progress.json の読み込みに失敗しました。" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor DarkRed
    return
  }

  $pairs = @(
    @{ Label = "status"; Value = $data.status }
    @{ Label = "step"; Value = $data.step }
    @{ Label = "phase"; Value = $data.phase }
    @{ Label = "request"; Value = $data.requestName }
    @{ Label = "sentAt"; Value = (Convert-ToJapanDisplayString $data.sentAt) }
    @{ Label = "note"; Value = $data.note }
    @{ Label = "itemType"; Value = $data.itemType }
    @{ Label = "batch"; Value = if ($null -ne $data.batchNumber -and $null -ne $data.totalBatches) { "$($data.batchNumber)/$($data.totalBatches)" } else { $null } }
    @{ Label = "threads"; Value = if ($null -ne $data.threadRange) { ($data.threadRange | Format-Value) } else { $null } }
    @{ Label = "batch msgs"; Value = $data.batchMessageCount }
    @{ Label = "items"; Value = if ($null -ne $data.completedItems -and $null -ne $data.totalItems) { "$($data.completedItems)/$($data.totalItems)" } else { $null } }
    @{ Label = "unit"; Value = if ($null -ne $data.unitNumber -and $null -ne $data.totalUnits) { "$($data.unitNumber)/$($data.totalUnits)" } else { $null } }
    @{ Label = "label"; Value = $data.label }
    @{ Label = "threadId"; Value = $data.threadId }
    @{ Label = "updated"; Value = (Convert-ToJapanDisplayString $data.updatedAt) }
  )

  foreach ($pair in $pairs) {
    $value = $pair.Value | Format-Value
    if ($value -ne "-") {
      Write-Host ("{0,-10}: {1}" -f $pair.Label, $value)
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($data.promptPreview)) {
    Write-Host ""
    Write-Host "prompt:" -ForegroundColor Cyan
    Write-Host $data.promptPreview
  }

  Write-Host ""
  Write-Host "Ctrl+C で終了" -ForegroundColor DarkGray
}

while ($true) {
  Show-ProgressFile -Path $resolvedPath
  Start-Sleep -Seconds $IntervalSeconds
}
