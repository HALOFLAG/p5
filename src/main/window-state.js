const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_STATE = {
  character_x: 200,
  character_y: 200,
};

class WindowState {
  constructor(filePath) {
    this.path = filePath;
    this.data = { ...DEFAULT_STATE };
  }

  async load() {
    try {
      const buf = await fs.readFile(this.path, 'utf8');
      const parsed = JSON.parse(buf);
      this.data = { ...DEFAULT_STATE, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[window-state] load failed, using defaults:', err.message);
      }
      await fs.mkdir(path.dirname(this.path), { recursive: true });
    }
  }

  get() {
    return { ...this.data };
  }

  update(partial) {
    if (!partial || typeof partial !== 'object') return;
    Object.assign(this.data, partial);
  }

  async save() {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

module.exports = { WindowState };
