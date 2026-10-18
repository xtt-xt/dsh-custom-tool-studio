#Requires -Version 5.1
<#
.SYNOPSIS
  一键恢复：把 dsh-custom-tool-studio 从 DSH profile 中彻底卸载，并可选地清理工具数据。

.DESCRIPTION
  这个脚本只处理 dsh-custom-tool-studio 这一个 bundle，绝不改动其它 bundle：
    1) 先把 profile 的 package.json 和 cordis.patch.yml 备份到
       <profile>\.restore-backup-<时间戳>\；
    2) 用 dsh.cmd 执行 `dsh plugin --profile <p> remove <bundle>`；
       PATH 上没有 dsh.cmd 时改用 node 调 @deepseek-ai/dsh 的 bin.js；
    3) 独立校验：bundle 不在 dsh.profile.bundles 里，且
       <profile>\node_modules\<bundle> 不存在；校验失败时以备份为底重建
       package.json（只摘掉本 bundle 一条，其它 bundle 原样保留）、恢复
       cordis.patch.yml、删除 node_modules 链接，然后再校验一次；
    4) 传入 -PurgeData 时删除 %DSH_HOME%\custom-tools（默认 %USERPROFILE%\.dsh\custom-tools）。

  脚本是幂等的：重复运行不会报错。最后必须重启 DSH 才会生效。

.PARAMETER PurgeData
  同时删除自定义工具的数据目录（tools.json、scripts\、runs\）。不可恢复。

.PARAMETER Profile
  DSH profile 名，默认 desktop。

.PARAMETER BundleName
  要卸载的 bundle 包名，默认 dsh-custom-tool-studio。

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File "F:\xtt\workspace\dsh-custom-tool-studio\restore.ps1"

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File "F:\xtt\workspace\dsh-custom-tool-studio\restore.ps1" -PurgeData
#>
[CmdletBinding()]
param(
  [switch]$PurgeData,
  [string]$Profile = 'desktop',
  [string]$BundleName = 'dsh-custom-tool-studio'
)

# 保持默认的 Continue：CLI 的 stderr 不应因为原生程序输出而被当成终止性错误。
$ErrorActionPreference = 'Continue'

$script:BundleName = $BundleName
$script:BackupDir = $null
$script:BundleLinkPath = $null

function Write-Step([string]$Message) {
  Write-Host "[restore] $Message"
}

function Write-Warn2([string]$Message) {
  Write-Host "[restore] ! $Message" -ForegroundColor Yellow
}

function Write-Fail([string]$Message) {
  Write-Host "[restore] x $Message" -ForegroundColor Red
}

function Get-FullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
  try { return [System.IO.Path]::GetFullPath($Path) } catch { return $Path }
}

# 判断路径上是否存在条目（包括指向已删除目标的悬空 junction / symlink）。
function Test-PathEntry([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -ne $item) { return $true }
  $parent = Split-Path -Parent $Path
  $leaf = Split-Path -Leaf $Path
  if ([string]::IsNullOrWhiteSpace($parent) -or [string]::IsNullOrWhiteSpace($leaf)) { return $false }
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return $false }
  $match = Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq $leaf } |
    Select-Object -First 1
  return ($null -ne $match)
}

function Read-JsonFile([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json)
  } catch {
    Write-Warn2 "无法解析 JSON：$Path（$($_.Exception.Message)）"
    return $null
  }
}

# 写成 UTF-8（无 BOM）——profile 的 package.json 带 BOM 会导致 DSH 启动检查失败。
function Write-TextFileNoBom([string]$Path, [string]$Text) {
  try {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
    return $true
  } catch {
    # PowerShell 7 的 utf8NoBOM 编码；5.1 会进 catch。
  }
  try {
    Set-Content -LiteralPath $Path -Value $Text -NoNewline -Encoding utf8NoBOM -ErrorAction Stop
    return $true
  } catch {
    # 写不出来就放弃写入，避免把 profile 写坏。
  }
  Write-Fail "无法以 UTF-8（无 BOM）写入 $Path；为避免写坏 profile，已放弃写入"
  return $false
}

function Backup-ProfileFile([string]$Dir, [string]$Name) {
  $source = Join-Path $Dir $Name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    Write-Step "未找到 $Name，跳过备份"
    return $null
  }
  $target = Join-Path $script:BackupDir $Name
  Copy-Item -LiteralPath $source -Destination $target -Force
  Write-Step "已备份 $Name -> $target"
  return $target
}

function Get-BundleList($Json) {
  if ($null -eq $Json) { return @() }
  try {
    return @($Json.dsh.profile.bundles)
  } catch {
    return @()
  }
}

function Test-BundleListed($Json) {
  foreach ($name in (Get-BundleList $Json)) {
    if ([string]$name -ieq $script:BundleName) { return $true }
  }
  return $false
}

# 用备份作为底稿，只从 dsh.profile.bundles 中摘掉当前 bundle，其它条目原样保留。
function Remove-BundleFromManifest([string]$ManifestPath, [string]$BackupPath) {
  $json = Read-JsonFile $ManifestPath
  if ($null -eq $json) {
    Write-Step "当前 package.json 不可用，改用备份内容重建"
    $json = Read-JsonFile $BackupPath
  }
  if ($null -eq $json) {
    Write-Fail "package.json 与备份都不可用，无法手动摘除 bundle"
    return $false
  }

  $before = @(Get-BundleList $json)
  $after = @()
  $removed = 0
  foreach ($name in $before) {
    if ([string]$name -ieq $script:BundleName) {
      $removed++
    } else {
      $after += [string]$name
    }
  }
  if ($removed -eq 0) {
    Write-Step "package.json 的 dsh.profile.bundles 本就不含 $script:BundleName，无需改写"
    return $true
  }

  try {
    if ($null -eq $json.dsh) {
      $json | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($null -eq $json.dsh.profile) {
      $json.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $json.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $after -Force
  } catch {
    Write-Fail "改写 package.json 结构失败：$($_.Exception.Message)"
    return $false
  }

  $text = ($json | ConvertTo-Json -Depth 100) + "`n"
  if (-not (Write-TextFileNoBom $ManifestPath $text)) { return $false }
  Write-Step "已从 dsh.profile.bundles 摘除 $script:BundleName（保留其余 $($after.Count) 个 bundle）"
  return $true
}

# 删除 <profile>\node_modules\<bundle>。它通常是 pnpm 建立的 junction：
# 只删链接本身，绝不动链接指向的源码目录。
function Remove-BundleLink {
  $link = $script:BundleLinkPath
  if (-not (Test-PathEntry $link)) {
    Write-Step "node_modules\$script:BundleName 不存在，无需删除"
    return $true
  }

  Write-Step "删除 node_modules\$script:BundleName（只删链接，不删指向的源码目录）"

  # rmdir 对 junction 只移除链接本身；对真实且非空的目录会失败。
  try { cmd /c rmdir "$link" | Out-Null } catch { }
  if (-not (Test-PathEntry $link)) {
    Write-Step "已删除 node_modules\$script:BundleName"
    return $true
  }

  # 符号链接：DirectoryInfo/FileInfo.Delete() 只删除链接。
  $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($null -ne $item) {
    try { $item.Delete() } catch { }
  }
  if (-not (Test-PathEntry $link)) {
    Write-Step "已删除 node_modules\$script:BundleName"
    return $true
  }

  # 真实目录（例如有人手动复制过）：只有确认是我们的 bundle 才递归删除。
  $marker = Join-Path $link 'package.json'
  $isOurs = $false
  if (Test-Path -LiteralPath $marker -PathType Leaf) {
    try {
      $pkg = Get-Content -LiteralPath $marker -Raw -Encoding utf8 | ConvertFrom-Json
      $isOurs = ([string]$pkg.name -ieq $script:BundleName)
    } catch { }
  }
  if ($isOurs) {
    Remove-Item -LiteralPath $link -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-PathEntry $link)) {
      Write-Step "已删除 node_modules\$script:BundleName（真实目录副本）"
      return $true
    }
  }

  Write-Fail "无法删除 node_modules\$script:BundleName（可能被占用，或它不是本 bundle 的链接）；请手动删除后重试"
  return $false
}

function Invoke-Verify {
  $pass = $true
  $json = Read-JsonFile $manifestPath
  if ($null -eq $json) {
    Write-Fail "验证失败：无法读取或解析 $manifestPath"
    return $false
  }
  if (Test-BundleListed $json) {
    Write-Fail "验证失败：dsh.profile.bundles 仍包含 $BundleName"
    $pass = $false
  } else {
    Write-Step "验证通过：dsh.profile.bundles 不含 $BundleName"
  }
  if (Test-PathEntry $script:BundleLinkPath) {
    Write-Fail "验证失败：node_modules\$BundleName 仍存在"
    $pass = $false
  } else {
    Write-Step "验证通过：node_modules\$BundleName 不存在"
  }
  return $pass
}

# ---------------------------------------------------------------------------
# 0. 解析路径与安全校验
# ---------------------------------------------------------------------------

if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
  Write-Fail "非法的 -Profile 值：'$Profile'（只允许字母、数字、点、下划线、连字符）"
  exit 1
}
if ($BundleName -notmatch '^(@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+$') {
  Write-Fail "非法的 -BundleName 值：'$BundleName'"
  exit 1
}

$dshHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($dshHome)) {
  $userHome = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($userHome)) { $userHome = $HOME }
  if ([string]::IsNullOrWhiteSpace($userHome)) {
    Write-Fail "无法确定用户主目录（USERPROFILE / HOME 均为空）"
    exit 1
  }
  $dshHome = Join-Path $userHome '.dsh'
}
$dshHome = Get-FullPath $dshHome

$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
  Write-Fail "找不到 profile 目录：$profileDir"
  exit 1
}

$nodeModulesDir = Join-Path $profileDir 'node_modules'
$script:BundleLinkPath = Join-Path $nodeModulesDir $BundleName
$manifestPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

# 防御：node_modules 链接必须落在 <profile>\node_modules 之内。
$nodeModulesFull = Get-FullPath $nodeModulesDir
$linkFull = Get-FullPath $script:BundleLinkPath
$underNodeModules = $false
try {
  $underNodeModules = $linkFull.StartsWith($nodeModulesFull + '\', [System.StringComparison]::OrdinalIgnoreCase)
} catch {
  $underNodeModules = ($linkFull -like "$nodeModulesFull*")
}
if (-not $underNodeModules) {
  Write-Fail "内部路径校验失败：$linkFull 不在 $nodeModulesFull 下"
  exit 1
}

Write-Step "DSH_HOME：$dshHome"
Write-Step "profile：$profileDir"
Write-Step "bundle：$BundleName"

# ---------------------------------------------------------------------------
# 1. 备份 profile 的 package.json / cordis.patch.yml
# ---------------------------------------------------------------------------

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:BackupDir = Join-Path $profileDir ".restore-backup-$stamp"
try {
  New-Item -ItemType Directory -Path $script:BackupDir -Force -ErrorAction Stop | Out-Null
} catch {
  Write-Fail "无法创建备份目录 $script:BackupDir：$($_.Exception.Message)"
  exit 1
}
Write-Step "备份目录：$script:BackupDir"
$backupManifest = Backup-ProfileFile $profileDir 'package.json'
$backupPatch = Backup-ProfileFile $profileDir 'cordis.patch.yml'

# ---------------------------------------------------------------------------
# 2. 通过官方 CLI 卸载（PATH 上找不到 dsh.cmd 时回退到 node bin.js）
# ---------------------------------------------------------------------------

$jsonNow = Read-JsonFile $manifestPath
$listedBefore = Test-BundleListed $jsonNow
$linkBefore = Test-PathEntry $script:BundleLinkPath
$listedText = if ($listedBefore) { '已登记' } else { '未登记' }
$linkText = if ($linkBefore) { '存在' } else { '不存在' }
Write-Step "卸载前状态：bundles $listedText；node_modules 链接 $linkText"

$cliExecuted = $false
$cliExit = $null

if (-not $listedBefore -and -not $linkBefore) {
  Write-Step "bundle 已不在 profile 中，跳过 dsh plugin remove（幂等，重复运行安全）"
} else {
  $exe = $null
  $exeArgs = @()
  $label = ''

  $dshCmd = Get-Command 'dsh.cmd' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $dshCmd) {
    $exe = $dshCmd.Source
    $label = 'dsh.cmd'
  } else {
    $npmBin = $null
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
      $npmBin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
    }
    if ($null -ne $npmBin -and (Test-Path -LiteralPath $npmBin -PathType Leaf)) {
      $exe = 'node'
      $exeArgs = @($npmBin)
      $label = "node `"$npmBin`""
      Write-Warn2 "PATH 上找不到 dsh.cmd，改用 node 调启动器"
    } else {
      Write-Warn2 "PATH 上找不到 dsh.cmd，也没有找到 npm 全局的 @deepseek-ai/dsh；跳过 CLI，直接走手动回退"
    }
  }

  if ($null -ne $exe) {
    $fullArgs = @($exeArgs) + @('plugin', '--profile', $Profile, 'remove', $BundleName)
    Write-Step "执行：$label $($fullArgs -join ' ')"
    try {
      $cliOutput = & $exe @fullArgs 2>&1
      $cliExit = $LASTEXITCODE
      if ($null -eq $cliExit) { $cliExit = 0 }
      foreach ($line in @($cliOutput)) {
        if ($null -ne $line) { Write-Host "    $line" }
      }
      $cliExecuted = $true
    } catch {
      $cliExecuted = $true
      $cliExit = -1
      Write-Warn2 "CLI 调用异常：$($_.Exception.Message)"
    }
    Write-Step "dsh plugin remove 退出码：$cliExit"
  }
}

# ---------------------------------------------------------------------------
# 3. 独立校验；失败则用手动回退完成卸载
# ---------------------------------------------------------------------------

$verified = Invoke-Verify

if (-not $verified) {
  Write-Warn2 "自动卸载未完成，进入手动回退（以备份为底，只处理本 bundle）"

  # 3.1 重建 package.json：备份是底稿，保证其它 bundle / 字段不丢，只摘掉本 bundle。
  if ($null -ne $backupManifest) {
    if (-not (Remove-BundleFromManifest $manifestPath $backupManifest)) {
      Write-Fail "手动回退：package.json 处理失败"
    }
  } else {
    Write-Warn2 "没有 package.json 备份（运行前就不存在？），只能基于当前文件处理"
    if (-not (Remove-BundleFromManifest $manifestPath $null)) {
      Write-Fail "手动回退：package.json 处理失败"
    }
  }

  # 3.2 用户层 cordis.patch.yml 恢复成运行前内容（CLI 正常不会改它）。
  if ($null -ne $backupPatch) {
    Copy-Item -LiteralPath $backupPatch -Destination $patchPath -Force -ErrorAction SilentlyContinue
    Write-Step "已用备份恢复 cordis.patch.yml"
  }

  # 3.3 删除 node_modules 里的链接。
  if (-not (Remove-BundleLink)) {
    Write-Warn2 "手动回退：node_modules 链接未能删除"
  }

  $verified = Invoke-Verify
}

# ---------------------------------------------------------------------------
# 4. 可选：清理工具数据目录 %DSH_HOME%\custom-tools
# ---------------------------------------------------------------------------

$dataDir = Join-Path $dshHome 'custom-tools'
$dataFull = Get-FullPath $dataDir
$dataKept = $true

if ($PurgeData) {
  Write-Step "清理数据：$dataFull"
  $refuse = $null
  if ([string]::IsNullOrWhiteSpace($dshHome)) {
    $refuse = '无法确定 DSH_HOME'
  } elseif ($dshHome -match '^[A-Za-z]:\\?$') {
    $refuse = "DSH_HOME 是盘符根目录（$dshHome）"
  } elseif ((Split-Path -Leaf $dataFull) -ne 'custom-tools') {
    $refuse = "目标最后一级不是 custom-tools（$dataFull）"
  } elseif ((Get-FullPath (Split-Path -Parent $dataFull)) -ne (Get-FullPath $dshHome)) {
    $refuse = "目标不在 $dshHome 下（$dataFull）"
  } elseif ($dataFull -ne (Get-FullPath (Join-Path $dshHome 'custom-tools'))) {
    $refuse = "目标与 %DSH_HOME%\\custom-tools 不一致（$dataFull）"
  }

  if ($null -ne $refuse) {
    Write-Fail "拒绝删除数据目录：$refuse"
    $dataKept = $false
  } elseif (-not (Test-PathEntry $dataFull)) {
    Write-Step "数据目录不存在，无需清理：$dataFull"
  } else {
    $entryCount = 0
    try { $entryCount = @(Get-ChildItem -LiteralPath $dataFull -Recurse -Force -ErrorAction SilentlyContinue).Count } catch { }
    Remove-Item -LiteralPath $dataFull -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-PathEntry $dataFull) {
      Write-Fail "删除数据目录失败（可能被占用）：$dataFull；请手动删除"
      $dataKept = $false
    } else {
      Write-Step "已删除数据目录（约 $entryCount 个文件/目录）：$dataFull"
    }
  }
} else {
  Write-Step "保留数据目录（未指定 -PurgeData）：$dataFull"
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

Write-Step '===== 汇总 ====='
Write-Step "bundle：$BundleName"
Write-Step "profile：$profileDir"
Write-Step "备份：$script:BackupDir"
if ($cliExecuted) {
  Write-Step "dsh plugin remove 退出码：$cliExit"
} elseif ($listedBefore -or $linkBefore) {
  Write-Step 'dsh plugin remove 未执行（找不到 CLI），已走手动回退'
} else {
  Write-Step 'dsh plugin remove 未执行（bundle 本来就不在 profile 中）'
}
if ($verified) {
  Write-Step '最终校验：通过（bundle 未登记，node_modules 链接不存在）'
} else {
  Write-Fail '最终校验：未通过，请查看上面的失败项'
}
if ($PurgeData) {
  if ($dataKept) {
    Write-Step "数据目录：已按 -PurgeData 清理（$dataFull）"
  } else {
    Write-Fail "数据目录：未能清理（$dataFull）"
  }
} else {
  Write-Step "数据目录：保留（$dataFull；需要清理时加 -PurgeData）"
}
Write-Step '请重启 DSH 使更改生效：restart DSH for the change to take effect.'

if ($verified -and $dataKept) {
  exit 0
} else {
  exit 1
}
