// Voice Manifest — 紀錄已生成語音檔（M6 §5.1）
//
// 結構：personas/<id>/voices/<lang>/manifest.json
//   {
//     "schema": "v1",
//     "entries": {
//       "<sequence_id>_<line_idx>": {
//         "hash": "sha256(text + ref_audio_path + lang)",
//         "file": "<sequence_id>_<line_idx>.wav",
//         "engine": "gpt-sovits",
//         "ref_audio": "voice-refs/haiyin-ref.wav",
//         "lang": "zh",
//         "bytes": 123456,
//         "ms": 2300,
//         "generated_at": "2026-05-10T10:23:01.234Z"
//       }
//     }
//   }
//
// 用途：
//   - lookup(seqId, lineIdx)：handleFire 時看有沒有檔可播
//   - needsRegen(opts)：批次跑時判斷哪些 sequence 還缺、哪些 hash 過期
//   - record(opts)：寫一筆紀錄
//   - load() / save()：原子寫入避免並發踩

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 'v1';

class VoiceManifest {
  constructor({ personaPath, lang = 'zh', subdir = 'voices' } = {}) {
    if (!personaPath) throw new Error('personaPath required');
    // P3: subdir 'voices' = 一般情境語音；'voices-time' = 時間音庫
    this._dir = path.join(personaPath, subdir, lang);
    this._file = path.join(this._dir, 'manifest.json');
    this._lang = lang;
    this._subdir = subdir;
    this._data = { schema: SCHEMA_VERSION, entries: {} };
    this._loaded = false;
  }

  static makeKey(sequenceId, lineIdx) {
    return `${sequenceId}_${lineIdx}`;
  }

  static computeHash({ text, refAudio, lang }) {
    return crypto
      .createHash('sha256')
      .update(`${text}|${refAudio}|${lang}`)
      .digest('hex');
  }

  async load() {
    try {
      const text = await fs.promises.readFile(this._file, 'utf-8');
      const parsed = JSON.parse(text);
      if (parsed && parsed.entries) {
        this._data = { schema: parsed.schema || SCHEMA_VERSION, entries: parsed.entries };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      // ENOENT → 空 manifest，OK
    }
    this._loaded = true;
  }

  /**
   * 看某個 (seqId, lineIdx) 在 manifest 內 + hash 對得上，
   * 且實際檔案存在。對得上才算「已生成」。
   */
  async lookup(sequenceId, lineIdx, expectedHash = null) {
    if (!this._loaded) await this.load();
    const key = VoiceManifest.makeKey(sequenceId, lineIdx);
    const entry = this._data.entries[key];
    if (!entry) return null;
    if (expectedHash && entry.hash !== expectedHash) return null;
    const filePath = path.join(this._dir, entry.file);
    try {
      await fs.promises.access(filePath);
    } catch (_e) {
      return null;
    }
    return { ...entry, file_path: filePath };
  }

  /**
   * 列出所有缺生成 / hash 過期 / 檔案遺失的待跑項。
   * @param {Array<{sequence_id, line_idx, text, ref_audio, lang}>} candidates
   * @returns {Promise<Array>} 缺的 candidates 子集
   */
  async listMissing(candidates) {
    if (!this._loaded) await this.load();
    const missing = [];
    for (const c of candidates) {
      const hash = VoiceManifest.computeHash({
        text: c.text,
        refAudio: c.ref_audio,
        lang: c.lang || this._lang,
      });
      const found = await this.lookup(c.sequence_id, c.line_idx, hash);
      if (!found) {
        missing.push({ ...c, _hash: hash });
      }
    }
    return missing;
  }

  /**
   * 寫一筆紀錄。會把 audio buffer 寫到對應 wav 檔，再更新 manifest。
   */
  async record({ sequence_id, line_idx, text, ref_audio, lang, hash, audio, engine, meta }) {
    if (!this._loaded) await this.load();
    const fileName = `${sequence_id}_${line_idx}.wav`;
    const filePath = path.join(this._dir, fileName);
    await fs.promises.mkdir(this._dir, { recursive: true });
    await fs.promises.writeFile(filePath, audio);

    const key = VoiceManifest.makeKey(sequence_id, line_idx);
    this._data.entries[key] = {
      hash: hash || VoiceManifest.computeHash({ text, refAudio: ref_audio, lang: lang || this._lang }),
      file: fileName,
      engine: engine || 'unknown',
      ref_audio,
      lang: lang || this._lang,
      bytes: meta?.bytes ?? audio.length,
      ms: meta?.ms ?? 0,
      generated_at: new Date().toISOString(),
    };

    await this._save();
  }

  async _save() {
    await fs.promises.mkdir(this._dir, { recursive: true });
    const tmp = `${this._file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this._data, null, 2));
    await fs.promises.rename(tmp, this._file);
  }

  /**
   * 統計：已生 / 總計（給 UI 顯示）
   */
  async stats() {
    if (!this._loaded) await this.load();
    return {
      total: Object.keys(this._data.entries).length,
      lang: this._lang,
      file: this._file,
    };
  }

  /**
   * 找孤兒 wav（manifest 沒記錄的檔案）— 給「清理」按鈕用
   */
  async findOrphans() {
    if (!this._loaded) await this.load();
    let names;
    try {
      names = await fs.promises.readdir(this._dir);
    } catch (_e) {
      return [];
    }
    const tracked = new Set(Object.values(this._data.entries).map((e) => e.file));
    return names.filter((n) => n.endsWith('.wav') && !tracked.has(n));
  }
}

module.exports = { VoiceManifest };
