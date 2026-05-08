const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  $schema: 'v1',
  active_persona: 'haiyin',
  active_renderer: 'static-image',
  active_model: 'default-static',
  voice: { enabled: false, language: 'zh' },
  volume: 0.6,
  do_not_disturb: {
    manual: false,
    schedule_enabled: false,
    schedule: [],
  },
  ai_provider: 'local-ollama',
  log_level: 'info',
  first_run_completed: false,
};

const MAX_BAK = 5;

class ConfigStore {
  constructor(filePath) {
    this.path = filePath;
    this.data = null;
    this.dirty = false;
  }

  async load() {
    try {
      const buf = await fs.readFile(this.path, 'utf8');
      this.data = JSON.parse(buf);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        await fs.mkdir(path.dirname(this.path), { recursive: true });
        await fs.writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
        return;
      }
      const recovered = await this._recoverFromBak();
      this.data = recovered ?? JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      console.warn('[config-store] settings.json corrupted, recovered:', !!recovered);
    }
  }

  async _recoverFromBak() {
    const dir = path.dirname(this.path);
    const baseName = path.basename(this.path);
    let files;
    try {
      files = await fs.readdir(dir);
    } catch {
      return null;
    }
    const baks = files
      .filter((f) => f.startsWith(`${baseName}.bak.`))
      .sort()
      .reverse();
    for (const bak of baks) {
      try {
        const buf = await fs.readFile(path.join(dir, bak), 'utf8');
        return JSON.parse(buf);
      } catch {
        // try next
      }
    }
    return null;
  }

  getAll() {
    return JSON.parse(JSON.stringify(this.data));
  }

  get(key) {
    return this.data?.[key];
  }

  update(partial) {
    if (!partial || typeof partial !== 'object') return;
    Object.assign(this.data, partial);
    this.dirty = true;
  }

  async save() {
    if (!this.dirty || !this.data) return;
    await this._rotateBak();
    await fs.writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
    this.dirty = false;
  }

  async _rotateBak() {
    try {
      await fs.access(this.path);
    } catch {
      return;
    }
    const dir = path.dirname(this.path);
    const baseName = path.basename(this.path);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(this.path, path.join(dir, `${baseName}.bak.${ts}`));

    const files = await fs.readdir(dir);
    const baks = files
      .filter((f) => f.startsWith(`${baseName}.bak.`))
      .sort();
    while (baks.length > MAX_BAK) {
      const old = baks.shift();
      try {
        await fs.unlink(path.join(dir, old));
      } catch {
        // ignore
      }
    }
  }
}

module.exports = { ConfigStore, DEFAULT_SETTINGS };
