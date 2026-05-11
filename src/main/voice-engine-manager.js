// VoiceEngineManager — 管 GPT-SoVITS api.py 子進程的生命週期
//
// 對外 API：
//   manager.start(config)  → 啟動 python api.py，回傳 Promise<true>（detect ready）
//   manager.stop()         → SIGTERM 5s 後 SIGKILL，回傳 Promise
//   manager.getStatus()    → 'stopped' | 'starting' | 'running' | 'error'
//   manager.getRecentLogs(n=200) → 最近 N 行 log
//   manager.on('log', line) → 每行 log
//   manager.on('status', status) → 狀態切換
//
// Config:
//   { cwd, python, script, args, wait_for_text, startup_timeout_sec }

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const EventEmitter = require('node:events');

const LOG_RING_SIZE = 500;            // 保留最近 500 行
const DEFAULT_WAIT_FOR = 'Uvicorn running on';
const DEFAULT_TIMEOUT_SEC = 120;
const SIGTERM_GRACE_MS = 5000;

class VoiceEngineManager extends EventEmitter {
  constructor({ logger = console } = {}) {
    super();
    this._log = logger;
    this._proc = null;
    this._status = 'stopped';   // 'stopped' | 'starting' | 'running' | 'error'
    this._logs = [];             // ring buffer of strings
    this._startedAt = null;
    this._lastError = null;
  }

  getStatus() { return this._status; }
  getRecentLogs(n = 200) { return this._logs.slice(-n); }
  getLastError() { return this._lastError; }
  getStartedAt() { return this._startedAt; }
  isRunning() { return this._status === 'running' || this._status === 'starting'; }

  /**
   * 啟動子進程。回傳 Promise，resolve(true) 表 ready；reject 表啟動失敗。
   * 若已在跑會 reject。
   */
  async start(config) {
    if (this._proc) throw new Error('engine already running');
    if (!config) throw new Error('engine config required');

    const cwd = config.cwd;
    const pythonRel = config.python || '.venv/Scripts/python.exe';
    const script = config.script || 'api.py';
    const args = Array.isArray(config.args) ? config.args : [];
    const waitFor = config.wait_for_text || DEFAULT_WAIT_FOR;
    const timeoutSec = Number.isFinite(config.startup_timeout_sec) ? config.startup_timeout_sec : DEFAULT_TIMEOUT_SEC;

    if (!cwd) throw new Error('config.cwd required（GPT-SoVITS 安裝目錄）');
    if (!fs.existsSync(cwd)) throw new Error(`cwd 不存在：${cwd}`);

    // 解析 python 絕對路徑（相對於 cwd）
    const pythonAbs = path.isAbsolute(pythonRel) ? pythonRel : path.join(cwd, pythonRel);
    if (!fs.existsSync(pythonAbs)) throw new Error(`python 找不到：${pythonAbs}`);

    // 確認 script 存在
    const scriptAbs = path.isAbsolute(script) ? script : path.join(cwd, script);
    if (!fs.existsSync(scriptAbs)) throw new Error(`script 找不到：${scriptAbs}`);

    this._logs = [];
    this._lastError = null;
    this._setStatus('starting');
    this._appendLog(`[manager] spawn: ${pythonAbs} ${script} ${args.join(' ')}`);
    this._appendLog(`[manager] cwd: ${cwd}`);

    return new Promise((resolve, reject) => {
      let resolved = false;
      let timer = null;

      try {
        this._proc = spawn(pythonAbs, [script, ...args], {
          cwd,
          windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
      } catch (err) {
        this._setStatus('error');
        this._lastError = err.message;
        return reject(err);
      }

      const onData = (buf) => {
        const text = buf.toString('utf-8');
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          this._appendLog(line);
          if (!resolved && line.includes(waitFor)) {
            resolved = true;
            clearTimeout(timer);
            this._startedAt = Date.now();
            this._setStatus('running');
            resolve(true);
          }
        }
      };
      this._proc.stdout.on('data', onData);
      this._proc.stderr.on('data', onData);   // SoVITS 多半往 stderr 印 progress

      this._proc.on('error', (err) => {
        this._appendLog(`[manager] spawn error: ${err.message}`);
        this._setStatus('error');
        this._lastError = err.message;
        this._proc = null;
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      this._proc.on('exit', (code, signal) => {
        this._appendLog(`[manager] exit code=${code} signal=${signal || '-'}`);
        const wasRunning = this._status === 'running' || this._status === 'starting';
        this._proc = null;
        if (wasRunning && code !== 0 && !signal) {
          // 非預期退出
          this._setStatus('error');
          this._lastError = `process exited unexpectedly (code ${code})`;
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(new Error(this._lastError));
          }
        } else {
          this._setStatus('stopped');
          this._startedAt = null;
        }
      });

      timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this._appendLog(`[manager] startup timeout (${timeoutSec}s) — 還沒看到 "${waitFor}"`);
        this._lastError = `startup timeout (${timeoutSec}s)`;
        this._setStatus('error');
        // 強制停掉
        try { this._proc?.kill('SIGTERM'); } catch (_e) {}
        setTimeout(() => { try { this._proc?.kill('SIGKILL'); } catch (_e) {} }, 1500);
        reject(new Error(this._lastError));
      }, timeoutSec * 1000);
    });
  }

  /**
   * 停止子進程。SIGTERM 5s grace 後 SIGKILL。
   */
  async stop() {
    if (!this._proc) {
      this._setStatus('stopped');
      return;
    }
    const proc = this._proc;
    this._appendLog('[manager] stop requested → SIGTERM');
    return new Promise((resolve) => {
      const onExit = () => resolve();
      proc.once('exit', onExit);
      try { proc.kill('SIGTERM'); } catch (_e) {}
      // Windows SIGTERM 行為跟 Unix 不同，加保險 SIGKILL
      setTimeout(() => {
        if (this._proc === proc) {
          this._appendLog('[manager] grace 結束 → SIGKILL');
          try { proc.kill('SIGKILL'); } catch (_e) {}
        }
        // 最終 fallback：直接 resolve（避免卡住）
        setTimeout(() => resolve(), 1000);
      }, SIGTERM_GRACE_MS);
    });
  }

  _appendLog(line) {
    this._logs.push(line);
    while (this._logs.length > LOG_RING_SIZE) this._logs.shift();
    this.emit('log', line);
  }

  _setStatus(newStatus) {
    if (this._status === newStatus) return;
    const old = this._status;
    this._status = newStatus;
    this.emit('status', { status: newStatus, prev: old, error: this._lastError });
  }
}

module.exports = { VoiceEngineManager };
