// tier3-mic-cam-activity — 麥克風 / 相機最近存取偵測（讀 ConsentStore registry）
//
// 命名說明（plan §11 / 架構審查回饋）：
//   ConsentStore 提供的是「最近存取」資訊，不是「正在使用」。當 LastUsedTimeStop
//   < LastUsedTimeStart 才能推論為「目前佔用中」，但 OS 寫入有延遲，所以
//   capability 與 emit 名稱統一用 recent-access-by / released-by。
//
// 採樣：5 秒輪詢一次（spawn powershell.exe 讀登錄檔）

const { spawn } = require('node:child_process');
const { MonitorPlugin } = require('./plugin-base');

const POLL_INTERVAL_MS = 5000;
const PS_TIMEOUT_MS = 10000;

const PS_COMMAND = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
function Get-Activity($base, $kind) {
  $items = Get-ChildItem -Path "$base\NonPackaged", "$base\Packaged" -ErrorAction SilentlyContinue
  foreach ($item in $items) {
    $props = Get-ItemProperty -Path $item.PSPath -ErrorAction SilentlyContinue
    if ($null -ne $props -and $null -ne $props.LastUsedTimeStart -and $props.LastUsedTimeStart -gt 0) {
      $stop = if ($null -eq $props.LastUsedTimeStop) { 0 } else { $props.LastUsedTimeStop }
      if ($stop -lt $props.LastUsedTimeStart) {
        [PSCustomObject]@{
          kind = $kind
          key = $item.PSChildName
        }
      }
    }
  }
}
$micBase = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
$camBase = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam'
$out = @()
$out += Get-Activity $micBase 'mic'
$out += Get-Activity $camBase 'cam'
@($out) | ConvertTo-Json -Compress -Depth 3
`;

class Tier3MicCamActivityPlugin extends MonitorPlugin {
  static id = 'tier3-mic-cam-activity';
  static tier = 3;
  static capabilities = ['mic_recent_access', 'cam_recent_access'];
  static description = '麥克風 / 相機最近存取偵測（ConsentStore）';

  constructor(opts) {
    super(opts);
    this._poll = null;
    this._activeMic = new Set();
    this._activeCam = new Set();
    this._busy = false;
  }

  async _onStart() {
    this._tick().catch(() => {}); // 起始化抓一次（失敗不阻斷 start）
    this._poll = setInterval(() => this._tick().catch(() => {}), POLL_INTERVAL_MS);
  }

  async _onStop() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
    this._activeMic.clear();
    this._activeCam.clear();
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;

    let raw;
    try {
      raw = await this._runPs();
    } catch (err) {
      this._busy = false;
      this._markUnhealthy('powershell-error', err);
      return;
    }
    this._busy = false;
    this._heartbeat();

    let data;
    try {
      data = JSON.parse((raw || '').trim() || '[]');
      if (!Array.isArray(data)) data = [data];
    } catch (err) {
      this._markUnhealthy('json-parse-error', err);
      return;
    }

    const newMic = new Set();
    const newCam = new Set();
    for (const item of data) {
      const name = friendlyName(item?.key);
      if (item?.kind === 'mic') newMic.add(name);
      else if (item?.kind === 'cam') newCam.add(name);
    }

    this._diffAndEmit('mic', this._activeMic, newMic);
    this._diffAndEmit('cam', this._activeCam, newCam);
    this._activeMic = newMic;
    this._activeCam = newCam;
  }

  _diffAndEmit(kind, oldSet, newSet) {
    const now = Date.now();
    for (const name of newSet) {
      if (!oldSet.has(name)) {
        this.emit(`${kind}:recent-access-by`, { t: now, exe: name });
      }
    }
    for (const name of oldSet) {
      if (!newSet.has(name)) {
        this.emit(`${kind}:released-by`, { t: now, exe: name });
      }
    }
  }

  _runPs() {
    return new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', PS_COMMAND,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { ps.kill(); } catch (_e) {}
        reject(new Error('powershell timeout'));
      }, PS_TIMEOUT_MS);

      ps.stdout.on('data', (d) => { stdout += d.toString(); });
      ps.stderr.on('data', (d) => { stderr += d.toString(); });
      ps.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`powershell exit ${code}: ${stderr.slice(0, 200)}`));
      });
      ps.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  snapshot() {
    return {
      mic_recent_access_by: [...this._activeMic],
      cam_recent_access_by: [...this._activeCam],
    };
  }
}

function friendlyName(key) {
  if (typeof key !== 'string' || !key) return 'unknown';
  // NonPackaged: 'C:#Program Files#Zoom#bin#Zoom.exe' → 'zoom.exe'
  if (key.includes('#')) {
    const last = key.split('#').pop();
    if (last && last.toLowerCase().endsWith('.exe')) return last.toLowerCase();
  }
  // Packaged: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe' → 'microsoft.windowsterminal'
  if (key.includes('_')) {
    return key.split('_')[0].toLowerCase();
  }
  return key.toLowerCase();
}

module.exports = { Plugin: Tier3MicCamActivityPlugin };
