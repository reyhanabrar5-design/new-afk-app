param(
  [string]$ServerUrl = 'http://localhost:3000'
)

$ErrorActionPreference = 'Stop'
$script:ApiRoot = ($ServerUrl.TrimEnd('/') + '/api/cli')
$script:CliToken = $null
$script:SelectedBotId = $null

function Invoke-CliRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    $Body
  )

  $headers = @{ Authorization = "Bearer $script:CliToken" }
  $parameters = @{
    Method = $Method
    Uri = "$script:ApiRoot$Path"
    Headers = $headers
    ErrorAction = 'Stop'
  }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json; charset=utf-8'
    $parameters.Body = ConvertTo-Json -InputObject $Body -Depth 20 -Compress
  }
  try {
    return Invoke-RestMethod @parameters
  } catch {
    $message = $_.Exception.Message
    if ($_.Exception.Response -and $_.Exception.Response.GetResponseStream()) {
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $responseText = $reader.ReadToEnd()
      $reader.Dispose()
      if ($responseText) {
        try {
          $responseObject = $responseText | ConvertFrom-Json
          if ($responseObject.error) { $message = $responseObject.error }
        } catch { }
      }
    }
    throw "API gagal: $message"
  }
}

function Invoke-CliAction {
  param([Parameter(Mandatory = $true)][string]$Action, [hashtable]$Parameters = @{})
  $body = @{ action = $Action }
  foreach ($key in $Parameters.Keys) { $body[$key] = $Parameters[$key] }
  Invoke-CliRequest -Method Post -Path '/action' -Body $body
}

function Get-CliState {
  Invoke-CliRequest -Method Get -Path '/state'
}

function Get-BotById {
  param([string]$BotId)
  $state = Get-CliState
  $bot = @($state.bots | Where-Object { $_.config.id -eq $BotId }) | Select-Object -First 1
  if (-not $bot) { throw "Akun '$BotId' tidak ditemukan." }
  return $bot
}

function Get-SelectedBot {
  if (-not $script:SelectedBotId) { throw 'Pilih akun dulu dengan: select <id>' }
  Get-BotById -BotId $script:SelectedBotId
}

function Show-CliStatus {
  $state = Get-CliState
  if (-not $state.bots -or $state.bots.Count -eq 0) {
    Write-Host 'Belum ada akun. Gunakan: add'
    return
  }
  $rows = foreach ($bot in $state.bots) {
    [PSCustomObject]@{
      Selected = if ($bot.config.id -eq $script:SelectedBotId) { '*' } else { '' }
      Id = $bot.config.id
      Username = $bot.config.username
      Platform = $bot.config.platform
      Server = "$($bot.config.host):$($bot.config.port)"
      Status = $bot.status
      Health = if ($bot.health) { "$($bot.health.health)/20" } else { '-' }
      Food = if ($bot.health) { "$($bot.health.food)/20" } else { '-' }
      Position = if ($bot.position) { "$($bot.position.x), $($bot.position.y), $($bot.position.z)" } else { '-' }
    }
  }
  $rows | Format-Table -AutoSize
}

function Show-Settings {
  $bot = Get-SelectedBot
  $config = $bot.config
  [PSCustomObject]@{
    Id = $config.id
    Username = $config.username
    Platform = $config.platform
    Host = $config.host
    Port = $config.port
    Version = $config.version
    Auth = $config.auth
    AutoReconnect = $config.autoReconnect
    ScriptEnabled = $config.scriptEnabled
    AutoCommands = ($config.autoCmds | ForEach-Object { "$($_.cmd) (delay $($_.delaySec)s)" }) -join '; '
  } | Format-List
}

function Read-OptionalValue {
  param([string]$Name, [string]$DefaultValue)
  $value = Read-Host "$Name [$DefaultValue]"
  if ([string]::IsNullOrWhiteSpace($value)) { return $DefaultValue }
  return $value
}

function Add-CliAccount {
  $platform = (Read-OptionalValue 'Platform (java/bedrock)' 'java').ToLowerInvariant()
  if ($platform -notin @('java', 'bedrock')) { throw 'Platform harus java atau bedrock.' }
  $type = (Read-OptionalValue 'Jenis akun (cracked/premium)' 'cracked').ToLowerInvariant()
  if ($type -notin @('cracked', 'premium')) { throw 'Jenis akun harus cracked atau premium.' }
  $username = Read-Host 'Username / email akun'
  if ([string]::IsNullOrWhiteSpace($username)) { throw 'Username wajib diisi.' }
  $securePassword = Read-Host 'Password akun (/login), kosongkan bila tidak ada' -AsSecureString
  $password = [System.Net.NetworkCredential]::new('', $securePassword).Password
  $defaultPort = if ($platform -eq 'bedrock') { '19132' } else { '25565' }
  $targetServer = Read-Host 'Target server [tycoon] (Enter=tycoon, -=lewati)'
  if ([string]::IsNullOrWhiteSpace($targetServer)) { $targetServer = 'tycoon' }
  elseif ($targetServer -eq '-') { $targetServer = '' }
  $nextCommand = Read-Host 'Command berikutnya [/is] (Enter=/is, -=lewati)'
  if ([string]::IsNullOrWhiteSpace($nextCommand)) { $nextCommand = '/is' }
  elseif ($nextCommand -eq '-') { $nextCommand = '' }
  $account = @{
    platform = $platform
    type = $type
    username = $username.Trim()
    password = $password
    host = Read-OptionalValue 'Host server' 'alwination.id'
    port = [int](Read-OptionalValue 'Port server' $defaultPort)
    targetServer = $targetServer
    nextCmd = $nextCommand
  }
  $result = Invoke-CliAction -Action 'add-account' -Parameters @{ account = $account }
  $script:SelectedBotId = $result.bot.config.id
  Write-Host "Akun ditambahkan: $script:SelectedBotId"
}

function Show-QuickCommands {
  $state = Get-CliState
  if (-not $state.quickCommands -or $state.quickCommands.Count -eq 0) {
    Write-Host 'Belum ada quick command.'
    return
  }
  for ($i = 0; $i -lt $state.quickCommands.Count; $i++) {
    Write-Host ("{0}. {1} => {2}" -f ($i + 1), $state.quickCommands[$i].label, $state.quickCommands[$i].command)
  }
}

function Show-Help {
  @'
Perintah PowerShell AFK (tanpa membuka dashboard web)
  help                         Tampilkan bantuan
  status                       Status bot, health/food, dan koordinat
  select <id>                  Pilih akun untuk perintah berikutnya
  add                          Tambah akun Minecraft
  remove [id]                  Hapus akun (meminta konfirmasi)
  start [id] [microsoft]       Mulai bot; opsi microsoft untuk login Xbox
  stop [id]                    Hentikan bot
  start-all | stop-all         Mulai atau hentikan semua bot
  chat <pesan>                 Kirim chat biasa
  command < /perintah >        Jalankan command seperti klik chat di game
  logs [jumlah]                Tampilkan log bot yang dipilih
  scoreboard                   Tampilkan scoreboard
  inventory                    Tampilkan inventory dan slot
  entities                     Tampilkan entity di sekitar
  pov                          Tampilkan arah pandang dan dimensi bot
  snapshot                     Ambil data posisi/inventory/scoreboard terbaru
  gui                          Tampilkan chest/GUI Minecraft yang terbuka
  click <slot>                 Klik slot pada GUI aktif
  use <slot>                   Gunakan item pada slot inventory
  close-gui                    Tutup GUI di game
  settings                     Lihat pengaturan akun yang dipilih
  set <field> <value>          Ubah username/host/port/version/auth/autoReconnect
  auto on|off                  Aktifkan/nonaktifkan perintah otomatis saat login
  auto-list                    Tampilkan daftar perintah otomatis
  auto-set                     Ganti daftar auto-command dari JSON
  quick                        Tampilkan quick commands
  quick-run <nomor>            Jalankan quick command pada bot yang dipilih
  quick-add <label>|<command>  Tambah quick command
  quick-set <nomor> <label>|<command>  Ubah quick command
  quick-remove <nomor>         Hapus quick command
  msa                          Tampilkan kode login Microsoft yang menunggu
  security                     Lihat status keamanan
  security on|off              Ubah proteksi dashboard/API
  security password            Ganti kata sandi dashboard/API
  watch                        Pantau status tiap 2 detik (Ctrl+C untuk berhenti)
  clear                        Bersihkan layar terminal
  logout | exit                Kunci sesi dan keluar
'@ | Write-Host
}

Write-Host "AFK PowerShell CLI -> $ServerUrl"
try {
  $health = Invoke-RestMethod -Method Get -Uri ($ServerUrl.TrimEnd('/') + '/healthz') -ErrorAction Stop
  if ($health -ne 'ok') { throw 'Respons health check tidak valid.' }
} catch {
  throw "Server AFK tidak dapat dijangkau di $ServerUrl. Jalankan 'npm start' dari folder aplikasi terlebih dahulu. $($_.Exception.Message)"
}

$password = ''
try {
  $securePassword = Read-Host 'Kata sandi dashboard (Enter jika proteksi nonaktif)' -AsSecureString
  $password = [System.Net.NetworkCredential]::new('', $securePassword).Password
  $login = Invoke-RestMethod -Method Post -Uri "$script:ApiRoot/auth" -ContentType 'application/json; charset=utf-8' -Body (ConvertTo-Json -InputObject @{ password = $password } -Compress) -ErrorAction Stop
  $script:CliToken = $login.token
  if (-not $login.securityEnabled) { Write-Warning 'Proteksi server sedang nonaktif; sesi CLI tetap menggunakan token lokal.' }
} catch {
  throw "Login CLI gagal: $($_.Exception.Message)"
} finally {
  $password = $null
}

Write-Host 'Ketik help untuk daftar perintah.'
try {
  while ($true) {
    $line = Read-Host 'afk'
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $match = [regex]::Match($line.Trim(), '^(\S+)(?:\s+([\s\S]*))?$')
    $command = $match.Groups[1].Value.ToLowerInvariant()
    $arguments = $match.Groups[2].Value.Trim()
    try {
      switch ($command) {
        'help' { Show-Help }
        'status' { Show-CliStatus }
        'select' {
          if (-not $arguments) { throw 'Gunakan: select <id>' }
          $selected = Get-BotById -BotId $arguments
          $script:SelectedBotId = $selected.config.id
          Write-Host "Akun aktif: $script:SelectedBotId"
        }
        'add' { Add-CliAccount }
        'remove' {
          $id = if ($arguments) { $arguments } else { (Get-SelectedBot).config.id }
          $target = Get-BotById -BotId $id
          $confirm = Read-Host "Hapus akun '$($target.config.username)'? (y/N)"
          if ($confirm -match '^(y|yes)$') {
            Invoke-CliAction -Action 'remove-account' -Parameters @{ botId = $id } | Out-Null
            if ($script:SelectedBotId -eq $id) { $script:SelectedBotId = $null }
            Write-Host 'Akun dihapus.'
          }
        }
        'start' {
          $parts = @($arguments -split '\s+' | Where-Object { $_ })
          $id = if ($parts.Count -gt 0 -and $parts[0] -ne 'microsoft') { $parts[0] } else { (Get-SelectedBot).config.id }
          $auth = if ($parts -contains 'microsoft') { 'microsoft' } else { $null }
          $params = @{ botId = $id }
          if ($auth) { $params.auth = $auth }
          Invoke-CliAction -Action 'start-bot' -Parameters $params | Out-Null
          Write-Host "Perintah mulai dikirim ke $id."
        }
        'stop' {
          $id = if ($arguments) { ($arguments -split '\s+')[0] } else { (Get-SelectedBot).config.id }
          Invoke-CliAction -Action 'stop-bot' -Parameters @{ botId = $id } | Out-Null
          Write-Host "Perintah berhenti dikirim ke $id."
        }
        'start-all' { Invoke-CliAction -Action 'start-all' | Out-Null; Write-Host 'Perintah mulai dikirim ke semua bot.' }
        'stop-all' { Invoke-CliAction -Action 'stop-all' | Out-Null; Write-Host 'Perintah berhenti dikirim ke semua bot.' }
        'chat' {
          if (-not $arguments) { throw 'Gunakan: chat <pesan>' }
          Invoke-CliAction -Action 'send-chat' -Parameters @{ botId = (Get-SelectedBot).config.id; message = $arguments } | Out-Null
          Write-Host 'Pesan dikirim.'
        }
        'command' {
          if (-not $arguments) { throw 'Gunakan: command </perintah>' }
          if (-not $arguments.StartsWith('/')) { throw 'Command harus diawali dengan /.' }
          Invoke-CliAction -Action 'run-chat-command' -Parameters @{ botId = (Get-SelectedBot).config.id; command = $arguments } | Out-Null
          Write-Host 'Command dikirim.'
        }
        'logs' {
          $bot = Get-SelectedBot
          $count = if ($arguments -match '^\d+$') { [int]$arguments } else { 20 }
          $bot.logs | Select-Object -Last ([Math]::Max(1, [Math]::Min($count, 200))) | ForEach-Object { Write-Host "[$($_.type)] $($_.message)" }
        }
        'scoreboard' { (Get-SelectedBot).scoreboard | Format-List }
        'inventory' {
          $bot = Get-SelectedBot
          if (-not $bot.inventory -or $bot.inventory.Count -eq 0) { Write-Host 'Data inventory kosong atau bot belum online.' }
          else { $bot.inventory | Format-Table -AutoSize }
        }
        'entities' {
          $bot = Get-SelectedBot
          if (-not $bot.entities -or $bot.entities.Count -eq 0) { Write-Host 'Tidak ada entity terdeteksi.' }
          else { $bot.entities | Format-Table -AutoSize }
        }
        'pov' {
          $bot = Get-SelectedBot
          $position = $bot.position
          [PSCustomObject]@{
            X = $position.x
            Y = $position.y
            Z = $position.z
            Yaw = $position.yaw
            Pitch = $position.pitch
            Dimension = $position.dimension
          } | Format-List
          if ($bot.entities) { $bot.entities | Format-Table -AutoSize }
        }
        'snapshot' {
          Invoke-CliAction -Action 'snapshot' | ForEach-Object {
            Write-Host "`n[$($_.botId)]"
            Write-Host "Posisi: $($_.position.x), $($_.position.y), $($_.position.z); yaw/pitch: $($_.position.yaw)/$($_.position.pitch); dimensi: $($_.position.dimension)"
            Write-Host "Scoreboard: $($_.scoreboard.title)"
            $_.scoreboard.items | Format-Table -AutoSize
          }
        }
        'gui' {
          $gui = (Get-SelectedBot).activeGui
          if (-not $gui) { Write-Host 'Bot tidak memiliki GUI Minecraft yang sedang terbuka.' }
          else {
            Write-Host "$($gui.title) (GUI $($gui.id))"
            $gui.slots | Where-Object { $_.name -ne 'air' } | Format-Table slot, name, displayName, count -AutoSize
          }
        }
        'click' {
          if ($arguments -notmatch '^\d+$') { throw 'Gunakan: click <nomor-slot>' }
          Invoke-CliAction -Action 'click-gui-slot' -Parameters @{ botId = (Get-SelectedBot).config.id; slot = [int]$arguments } | Out-Null
          Write-Host 'Slot GUI diklik.'
        }
        'use' {
          if ($arguments -notmatch '^\d+$') { throw 'Gunakan: use <nomor-slot>' }
          Invoke-CliAction -Action 'use-item' -Parameters @{ botId = (Get-SelectedBot).config.id; slot = [int]$arguments } | Out-Null
          Write-Host 'Perintah gunakan item dikirim.'
        }
        'close-gui' { Invoke-CliAction -Action 'close-gui' -Parameters @{ botId = (Get-SelectedBot).config.id } | Out-Null; Write-Host 'Perintah tutup GUI dikirim.' }
        'settings' { Show-Settings }
        'set' {
          $setMatch = [regex]::Match($arguments, '^(\S+)\s+([\s\S]+)$')
          if (-not $setMatch.Success) { throw 'Gunakan: set <field> <value>' }
          $field = $setMatch.Groups[1].Value
          $rawValue = $setMatch.Groups[2].Value.Trim()
          $allowed = @('username', 'host', 'port', 'version', 'auth', 'autoReconnect', 'password')
          if ($field -notin $allowed) { throw "Field yang didukung: $($allowed -join ', ')." }
          $value = $rawValue
          if ($field -eq 'port') {
            $value = 0
            if (-not [int]::TryParse($rawValue, [ref]$value) -or $value -lt 1 -or $value -gt 65535) { throw 'Port harus di antara 1 sampai 65535.' }
          }
          if ($field -eq 'autoReconnect') {
            if ($rawValue -notmatch '^(true|false|on|off)$') { throw 'autoReconnect harus true/false atau on/off.' }
            $value = $rawValue -match '^(true|on)$'
          }
          if ($field -eq 'password') {
            $secure = Read-Host 'Password akun' -AsSecureString
            $value = [System.Net.NetworkCredential]::new('', $secure).Password
          }
          $config = @{}
          $config[$field] = $value
          Invoke-CliAction -Action 'update-bot-config' -Parameters @{ botId = (Get-SelectedBot).config.id; config = $config } | Out-Null
          Write-Host "Pengaturan '$field' disimpan."
        }
        'auto' {
          if ($arguments -notmatch '^(on|off)$') { throw 'Gunakan: auto on|off' }
          Invoke-CliAction -Action 'update-bot-config' -Parameters @{ botId = (Get-SelectedBot).config.id; config = @{ scriptEnabled = ($arguments -eq 'on') } } | Out-Null
          Write-Host "Auto-command: $arguments"
        }
        'auto-list' { (Get-SelectedBot).config.autoCmds | Format-Table -AutoSize }
        'auto-set' {
          $json = Read-Host 'Masukkan JSON array, contoh: [{"cmd":"/is","delaySec":2}]'
          if (-not $json.Trim().StartsWith('[') -or -not $json.Trim().EndsWith(']')) { throw 'Nilai harus berupa JSON array.' }
          $commands = @(ConvertFrom-Json -InputObject $json -ErrorAction Stop)
          Invoke-CliAction -Action 'update-bot-config' -Parameters @{ botId = (Get-SelectedBot).config.id; config = @{ autoCmds = $commands } } | Out-Null
          Write-Host 'Auto-command disimpan.'
        }
        'quick' { Show-QuickCommands }
        'quick-run' {
          if ($arguments -notmatch '^\d+$') { throw 'Gunakan: quick-run <nomor>' }
          $commands = @((Get-CliState).quickCommands)
          $index = [int]$arguments - 1
          if ($index -lt 0 -or $index -ge $commands.Count) { throw 'Nomor quick command tidak valid.' }
          Invoke-CliAction -Action 'send-chat' -Parameters @{ botId = (Get-SelectedBot).config.id; message = $commands[$index].command } | Out-Null
          Write-Host 'Quick command dikirim.'
        }
        'quick-add' {
          $quickParts = $arguments -split '\|', 2
          if ($quickParts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($quickParts[1])) { throw 'Gunakan: quick-add <label>|<command>' }
          $commands = @((Get-CliState).quickCommands) + @(@{ label = $quickParts[0].Trim(); command = $quickParts[1].Trim() })
          if ($commands.Count -gt 12) { throw 'Maksimal 12 quick command.' }
          Invoke-CliAction -Action 'update-quick-commands' -Parameters @{ commands = $commands } | Out-Null
          Write-Host 'Quick command ditambahkan.'
        }
        'quick-set' {
          $quickMatch = [regex]::Match($arguments, '^(\d+)\s+([^|]+)\|([\s\S]+)$')
          if (-not $quickMatch.Success) { throw 'Gunakan: quick-set <nomor> <label>|<command>' }
          $commands = @((Get-CliState).quickCommands)
          $index = [int]$quickMatch.Groups[1].Value - 1
          if ($index -lt 0 -or $index -ge $commands.Count) { throw 'Nomor quick command tidak valid.' }
          $commands[$index] = @{ label = $quickMatch.Groups[2].Value.Trim(); command = $quickMatch.Groups[3].Value.Trim() }
          Invoke-CliAction -Action 'update-quick-commands' -Parameters @{ commands = $commands } | Out-Null
          Write-Host 'Quick command diperbarui.'
        }
        'quick-remove' {
          if ($arguments -notmatch '^\d+$') { throw 'Gunakan: quick-remove <nomor>' }
          $commands = @((Get-CliState).quickCommands)
          $index = [int]$arguments - 1
          if ($index -lt 0 -or $index -ge $commands.Count) { throw 'Nomor quick command tidak valid.' }
          $remaining = @()
          for ($i = 0; $i -lt $commands.Count; $i++) {
            if ($i -ne $index) { $remaining += $commands[$i] }
          }
          Invoke-CliAction -Action 'update-quick-commands' -Parameters @{ commands = $remaining } | Out-Null
          Write-Host 'Quick command dihapus.'
        }
        'msa' {
          $bot = Get-SelectedBot
          if (-not $bot.pendingMsaCode) { Write-Host 'Tidak ada kode Microsoft yang sedang menunggu.' }
          else {
            Write-Host "Buka: $($bot.pendingMsaCode.verificationUri)"
            Write-Host "Kode: $($bot.pendingMsaCode.userCode)"
          }
        }
        'security' {
          if (-not $arguments) { Write-Host "Proteksi dashboard/API: $((Get-CliState).security.enabled)" }
          elseif ($arguments -in @('on', 'off')) {
            $security = @{ enabled = ($arguments -eq 'on') }
            Invoke-CliAction -Action 'update-security-config' -Parameters @{ config = $security } | Out-Null
            Write-Host "Proteksi dashboard/API: $arguments"
          } elseif ($arguments -eq 'password') {
            $secure = Read-Host 'Kata sandi baru' -AsSecureString
            $newPassword = [System.Net.NetworkCredential]::new('', $secure).Password
            if ([string]::IsNullOrWhiteSpace($newPassword)) { throw 'Kata sandi tidak boleh kosong.' }
            Invoke-CliAction -Action 'update-security-config' -Parameters @{ config = @{ enabled = (Get-CliState).security.enabled; password = $newPassword } } | Out-Null
            $newPassword = $null
            Write-Host 'Kata sandi diperbarui.'
          } else { throw 'Gunakan: security [on|off|password]' }
        }
        'watch' {
          Write-Host 'Memantau tiap 2 detik. Tekan Ctrl+C untuk berhenti.'
          while ($true) { Clear-Host; Show-CliStatus; Start-Sleep -Seconds 2 }
        }
        'clear' { Clear-Host }
        { $_ -in @('logout', 'exit', 'quit') } { return }
        default { Write-Host "Perintah tidak dikenal: $command (ketik help)." -ForegroundColor Yellow }
      }
    } catch {
      Write-Host $_.Exception.Message -ForegroundColor Red
    }
  }
} finally {
  if ($script:CliToken) {
    try { Invoke-CliRequest -Method Post -Path '/lock' | Out-Null } catch { }
    $script:CliToken = $null
  }
}
