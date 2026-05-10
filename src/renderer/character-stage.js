// p5 CharacterStage — M5a 渲染器抽象 + 色塊 placeholder
//
// 對外 API（window.p5.CharacterStage）：
//   new CharacterStage(rootEl, opts)
//   stage.setPersona(personaData)         切人格（display_name + expressions）
//   stage.setExpression(key)              切表情（fade in/out）
//   stage.getBubbleAnchor()               { x, y } 給 bubble 用
//   stage.getRoot()                       回 root element（拖曳 / hover 用）
//   stage.destroy()
//
// 設計：
//   - 抽象 CharacterRenderer interface（之後換 StaticImageRenderer 不用改 stage 外層）
//   - ColorBlockRenderer 是 placeholder：依 expression 切色 + 中文描述疊字 + fade
//   - 色塊上方中央當作 bubble anchor

(function () {
  // ── expression → 顏色（HEX，placeholder 用） ─────────
  const COLOR_MAP = {
    idle:        '#9aa0b4',  // 灰
    happy:       '#f4d35e',  // 黃
    shy:         '#f4a4b3',  // 粉
    embarrassed: '#f4a4b3',
    wink:        '#f4a4b3',
    pout:        '#f4a4b3',
    worried:     '#5e8bf4',  // 藍
    annoyed:     '#c25a5a',  // 暗紅
    sleepy:      '#9b7ecc',  // 紫
    yandere:     '#6b4099',  // 深紫
    thinking:    '#6cc28a',  // 綠
  };

  // ── 抽象 interface（之後 StaticImageRenderer 也實作這份） ──
  class CharacterRenderer {
    constructor(rootEl, opts = {}) {
      if (new.target === CharacterRenderer) {
        throw new Error('CharacterRenderer is abstract');
      }
      this._root = rootEl;
      this._opts = opts;
    }
    setPersona(_personaData) { throw new Error('not implemented'); }
    setExpression(_key) { throw new Error('not implemented'); }
    getBubbleAnchor() {
      const rect = this._root.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top };
    }
    destroy() { this._root.innerHTML = ''; }
  }

  // ── ColorBlockRenderer：placeholder 實作 ─────────────
  class ColorBlockRenderer extends CharacterRenderer {
    constructor(rootEl, opts = {}) {
      super(rootEl, opts);
      this._persona = null;
      this._expression = 'idle';
      this._fadeMs = opts.fadeMs ?? 200;
      this._fadeTimer = null;
      this._buildDom();
    }

    _buildDom() {
      this._root.innerHTML = '';
      this._root.classList.add('character-stage', 'character-stage--color-block');

      this._block = document.createElement('div');
      this._block.className = 'color-block';

      const labels = document.createElement('div');
      labels.className = 'color-block-labels';

      this._nameEl = document.createElement('div');
      this._nameEl.className = 'color-block-name';
      this._nameEl.textContent = '—';

      this._descEl = document.createElement('div');
      this._descEl.className = 'color-block-desc';
      this._descEl.textContent = '';

      this._keyEl = document.createElement('div');
      this._keyEl.className = 'color-block-key';
      this._keyEl.textContent = '';

      labels.append(this._nameEl, this._descEl, this._keyEl);
      this._block.append(labels);
      this._root.append(this._block);

      // 預設色（無 persona 載入前）
      this._block.style.backgroundColor = COLOR_MAP.idle;
    }

    setPersona(personaData) {
      this._persona = personaData || null;
      this._nameEl.textContent = personaData?.display_name || personaData?.id || '—';
      this._applyExpression(true);
    }

    setExpression(key) {
      const next = key || 'idle';
      if (this._expression === next) return;
      this._expression = next;
      this._applyExpression(true);
    }

    /**
     * 套用當前 expression 的色 + 文字。withFade=true 時走 200ms fade out → swap → fade in。
     * 同時 fade 進行中再呼叫會清掉舊 timer 直接套新狀態。
     */
    _applyExpression(withFade) {
      if (this._fadeTimer) {
        clearTimeout(this._fadeTimer);
        this._fadeTimer = null;
      }
      const exprData = this._persona?.expressions?.[this._expression]
        || this._persona?.expressions?.idle
        || null;
      const desc = exprData?.description || this._expression;
      const color = COLOR_MAP[this._expression] || COLOR_MAP.idle;

      if (withFade && this._fadeMs > 0) {
        this._block.classList.add('color-block--fading');
        this._fadeTimer = setTimeout(() => {
          this._block.style.backgroundColor = color;
          this._descEl.textContent = desc;
          this._keyEl.textContent = `(${this._expression})`;
          this._block.classList.remove('color-block--fading');
          this._fadeTimer = null;
        }, this._fadeMs);
      } else {
        this._block.style.backgroundColor = color;
        this._descEl.textContent = desc;
        this._keyEl.textContent = `(${this._expression})`;
      }
    }

    getBubbleAnchor() {
      const rect = this._root.getBoundingClientRect();
      // 色塊頂端中央往上 16px（給氣泡留呼吸空間）
      return { x: rect.left + rect.width / 2, y: rect.top - 16 };
    }

    destroy() {
      if (this._fadeTimer) clearTimeout(this._fadeTimer);
      this._root.classList.remove('character-stage', 'character-stage--color-block');
      super.destroy();
    }
  }

  // ── StaticImageRenderer：M5a-real 第一階段（單圖共用）─────
  // persona.appearance._image_url 存在 → 用此 renderer
  // 之後支援多表情切圖（appearance.images[expression] map）
  class StaticImageRenderer extends CharacterRenderer {
    constructor(rootEl, opts = {}) {
      super(rootEl, opts);
      this._persona = null;
      this._expression = 'idle';
      this._buildDom();
    }

    _buildDom() {
      this._root.innerHTML = '';
      this._root.classList.add('character-stage', 'character-stage--static-image');

      this._img = document.createElement('img');
      this._img.className = 'character-image';
      this._img.alt = 'character';
      this._img.draggable = false;
      this._root.append(this._img);

      // 表情 debug overlay：底部顯示當前表情中文（之後可選關）
      this._labels = document.createElement('div');
      this._labels.className = 'character-image-labels';
      this._descEl = document.createElement('span');
      this._descEl.className = 'character-image-desc';
      this._labels.append(this._descEl);
      this._root.append(this._labels);
    }

    setPersona(personaData) {
      this._persona = personaData || null;
      const url = personaData?.appearance?._image_url;
      if (url) this._img.src = url;
      this._applyExpression();
    }

    setExpression(key) {
      const next = key || 'idle';
      if (this._expression === next) return;
      this._expression = next;
      this._applyExpression();
    }

    _applyExpression() {
      // 目前單圖共用，不切 src（之後支援 persona.appearance.images[expr] 時改）
      const exprData = this._persona?.expressions?.[this._expression]
        || this._persona?.expressions?.idle
        || null;
      const desc = exprData?.description || this._expression;
      if (this._descEl) {
        this._descEl.textContent = `${desc} · ${this._expression}`;
      }
    }

    getBubbleAnchor() {
      const rect = this._root.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top - 16 };
    }

    destroy() {
      this._root.classList.remove('character-stage', 'character-stage--static-image');
      super.destroy();
    }
  }

  // ── CharacterStage：對外 facade（依 persona 自動切 renderer）───
  class CharacterStage {
    constructor(rootEl, opts = {}) {
      this._root = rootEl;
      this._opts = opts;
      this._renderer = null;
      this._currentKind = null;
      this._switchTo('color-block');   // 預設 placeholder
    }

    setPersona(p) {
      // 有 _image_url 用真圖；否則退回色塊 placeholder
      const wantedKind = p?.appearance?._image_url ? 'static-image' : 'color-block';
      if (wantedKind !== this._currentKind) {
        this._switchTo(wantedKind);
      }
      this._renderer.setPersona(p);
    }

    setExpression(k) { this._renderer?.setExpression(k); }
    getBubbleAnchor() {
      return this._renderer?.getBubbleAnchor() || { x: 0, y: 0 };
    }
    getRoot() { return this._root; }
    destroy() { this._renderer?.destroy(); }

    _switchTo(kind) {
      if (this._renderer) this._renderer.destroy();
      if (kind === 'static-image') {
        this._renderer = new StaticImageRenderer(this._root, this._opts);
      } else {
        this._renderer = new ColorBlockRenderer(this._root, this._opts);
      }
      this._currentKind = kind;
    }
  }

  window.p5 = window.p5 || {};
  window.p5.CharacterRenderer = CharacterRenderer;
  window.p5.ColorBlockRenderer = ColorBlockRenderer;
  window.p5.StaticImageRenderer = StaticImageRenderer;
  window.p5.CharacterStage = CharacterStage;
})();
