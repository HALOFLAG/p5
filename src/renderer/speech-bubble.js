// SpeechBubble — 對話氣泡元件（M2.5 多型態）
//
// 三維設計：
//   type:        speech | thought | narration | system | whisper
//   persistence: transient | persistent | sticky | pinned   （sticky M3 後啟用）
//   interaction: display | advance | choice | timed_choice  （timed_choice M3 後啟用）
//
// schema 完整定義見 文件/對話氣泡類型.md / 文件/技術規格.md §2.3
// 預設值：type=speech, persistence=transient, interaction=advance, auto_close_ms=12000

const TYPING_SPEED_MS = 30;
const DEFAULT_AUTO_CLOSE_MS = 12000;
const ANCHOR_GAP_PX = 12;

const VALID_TYPES = ['speech', 'thought', 'narration', 'system', 'whisper'];
const VALID_PERSISTENCE = ['transient', 'persistent', 'sticky', 'pinned'];
const VALID_INTERACTION = ['display', 'advance', 'choice', 'timed_choice', 'binary_split'];

class SpeechBubble {
  constructor(rootEl, callbacks = {}) {
    this.root = rootEl;
    this.body = rootEl.querySelector('.bubble-body');
    this.textEl = rootEl.querySelector('.bubble-text');
    this.hintEl = rootEl.querySelector('.bubble-hint');
    this.cursorEl = rootEl.querySelector('.bubble-cursor');
    this.closeBtn = rootEl.querySelector('.bubble-close');
    this.choicesEl = rootEl.querySelector('.bubble-choices');
    this.binaryEl = rootEl.querySelector('.bubble-binary');

    this.callbacks = {
      onAdvance: callbacks.onAdvance || (() => {}),
      onDismiss: callbacks.onDismiss || (() => {}),
      onChoiceSelected: callbacks.onChoiceSelected || (() => {}),
      onMouseEnter: callbacks.onMouseEnter || (() => {}),
      onMouseLeave: callbacks.onMouseLeave || (() => {}),
    };

    /** @type {'hidden'|'typing'|'waiting'} */
    this.state = 'hidden';
    this.sequence = null;
    this.lineIndex = 0;
    this.charIndex = 0;
    this.typingTimer = null;
    this.autoCloseTimer = null;
    this.anchor = { x: 0, y: 0 };

    this._wireEvents();
    this.root.classList.add('hidden');
  }

  _wireEvents() {
    // 主體點擊推進（advance / typing 跳完整句）
    this.body.addEventListener('click', (e) => {
      if (e.target.closest('.bubble-close')) return; // 關閉鈕另處理
      if (e.target.closest('.bubble-choice')) return; // choice 按鈕另處理
      if (e.target.closest('.bubble-binary-zone')) return; // binary 分區另處理
      e.stopPropagation();
      this._handleBodyClick();
    });

    // 關閉鈕
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dismiss('user_close');
    });

    // hover → 取消滑鼠穿透
    this.root.addEventListener('mouseenter', () => this.callbacks.onMouseEnter());
    this.root.addEventListener('mouseleave', () => this.callbacks.onMouseLeave());
  }

  /** 顯示一段對話序列 */
  show(sequence) {
    if (!this._validateSequence(sequence)) return;
    this._clearTimers();

    // 規範化（補預設值）
    this.sequence = this._normalizeSequence(sequence);
    this.lineIndex = 0;

    // 套用 data-* 屬性驅動 CSS 變體
    this.root.setAttribute('data-type', this.sequence.type);
    this.root.setAttribute('data-persistence', this.sequence.persistence);
    this.root.setAttribute('data-interaction', this.sequence.interaction);

    // 處理 choice 按鈕
    this._renderChoices(this.sequence.choices || []);
    this._renderBinary(this.sequence.binary || null);

    this._reposition();
    this.root.classList.remove('hidden');
    void this.root.offsetWidth; // 強制 reflow 觸發 transition
    this.root.classList.add('visible');

    this._startLine();
  }

  setAnchor(x, y) {
    this.anchor.x = x;
    this.anchor.y = y;
    if (this.state !== 'hidden') this._reposition();
  }

  dismiss(reason = 'manual') {
    if (this.state === 'hidden') return;
    const seqId = this.sequence?.sequenceId;
    const seq = this.sequence;
    this._clearTimers();
    this.root.classList.remove('visible');
    this.root.classList.add('hidden');
    this.state = 'hidden';
    this.sequence = null;
    this.callbacks.onDismiss({
      sequenceId: seqId,
      reason,
      completed: this._isLastLineCompleted(seq),
    });
  }

  isVisible() {
    return this.state !== 'hidden';
  }

  // ───────────────────────────────────────────────────────────

  _validateSequence(seq) {
    if (!seq || !Array.isArray(seq.lines) || seq.lines.length === 0) return false;
    return true;
  }

  _normalizeSequence(seq) {
    const out = { ...seq };
    out.type = VALID_TYPES.includes(out.type) ? out.type : 'speech';
    out.persistence = VALID_PERSISTENCE.includes(out.persistence) ? out.persistence : 'transient';
    out.interaction = VALID_INTERACTION.includes(out.interaction) ? out.interaction : 'advance';

    if (out.auto_close_ms === undefined) {
      out.auto_close_ms = out.persistence === 'transient' ? DEFAULT_AUTO_CLOSE_MS : null;
    }

    // M2.5 不啟用：sticky / timed_choice 退回 fallback 行為 + 警告
    if (out.persistence === 'sticky') {
      console.warn('[bubble] persistence=sticky 在 M3 後才啟用，暫退回 persistent');
      out.persistence = 'persistent';
    }
    if (out.interaction === 'timed_choice') {
      console.warn('[bubble] interaction=timed_choice 在 M3 後才啟用，暫退回 choice');
      out.interaction = 'choice';
    }

    // binary_split 校驗
    if (out.interaction === 'binary_split' && !out.binary) {
      console.warn('[bubble] interaction=binary_split 但無 binary 欄位，退回 advance');
      out.interaction = 'advance';
    }

    // interaction=display 強制不顯示游標、提示
    return out;
  }

  _renderChoices(choices) {
    this.choicesEl.innerHTML = '';
    if (!choices || choices.length === 0) return;
    if (this.sequence.interaction !== 'choice') return;

    choices.forEach((choice, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bubble-choice';
      btn.textContent = choice.label || `選項 ${idx + 1}`;
      btn.dataset.index = String(idx);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleChoice(idx, choice);
      });
      this.choicesEl.appendChild(btn);
    });
  }

  _handleChoice(index, choice) {
    const seqId = this.sequence?.sequenceId;
    this.callbacks.onChoiceSelected({
      sequenceId: seqId,
      choiceIndex: index,
      next: choice.next ?? null,
      action: choice.action ?? null,
    });
    // 選後立刻關氣泡；後續是否展示 next 由 main 決定
    this.dismiss('choice_selected');
  }

  _renderBinary(binary) {
    this.binaryEl.innerHTML = '';
    if (!binary) return;
    if (this.sequence.interaction !== 'binary_split') return;

    const left = this._createBinaryZone('left', binary.left);
    const right = this._createBinaryZone('right', binary.right);
    if (left) this.binaryEl.appendChild(left);
    if (right) this.binaryEl.appendChild(right);
  }

  _createBinaryZone(side, config) {
    if (!config) return null;
    const zone = document.createElement('button');
    zone.type = 'button';
    zone.className = 'bubble-binary-zone';
    zone.dataset.side = side;
    zone.textContent = config.label || (side === 'left' ? '是' : '否');
    zone.addEventListener('click', (e) => {
      e.stopPropagation();
      this._handleBinaryChoice(side, config);
    });
    return zone;
  }

  _handleBinaryChoice(side, config) {
    const seqId = this.sequence?.sequenceId;
    this.callbacks.onChoiceSelected({
      sequenceId: seqId,
      side,
      next: config.next ?? null,
      action: config.action ?? null,
    });
    this.dismiss('choice_selected');
  }

  _isLastLineCompleted(seq) {
    if (!seq) return false;
    const last = seq.lines.length - 1;
    return this.lineIndex >= last && this.charIndex >= (seq.lines[this.lineIndex]?.text?.length ?? 0);
  }

  _startLine() {
    const line = this.sequence.lines[this.lineIndex];
    if (!line) {
      this.dismiss('finished');
      return;
    }
    this.charIndex = 0;
    this.textEl.textContent = '';
    this.hintEl.classList.remove('show');

    const showCursor = this.sequence.interaction !== 'display';
    if (showCursor) this.cursorEl.classList.add('show');
    else this.cursorEl.classList.remove('show');

    this.state = 'typing';
    this._typeNext(line.text);
    this._scheduleAutoClose();
  }

  _typeNext(fullText) {
    if (this.charIndex >= fullText.length) {
      this._onLineComplete();
      return;
    }
    this.textEl.textContent = fullText.slice(0, this.charIndex + 1);
    this.charIndex++;
    this.typingTimer = setTimeout(() => this._typeNext(fullText), TYPING_SPEED_MS);
  }

  _onLineComplete() {
    this.state = 'waiting';
    this.cursorEl.classList.remove('show');

    // display 類型不顯示 hint（沒有「下一句」概念）
    if (this.sequence.interaction !== 'display') {
      const isLast = this.lineIndex === this.sequence.lines.length - 1;
      // choice / binary_split 互動最後一句不需要提示符（讓使用者選）
      const isInteractive = this.sequence.interaction === 'choice' ||
                             this.sequence.interaction === 'binary_split';
      if (isInteractive && isLast) {
        this.hintEl.classList.remove('show');
      } else {
        this.hintEl.textContent = isLast ? '▶' : '▼';
        this.hintEl.classList.add('show');
      }
    }
    this._scheduleAutoClose();
  }

  _handleBodyClick() {
    // display 類型主體不可推進，僅關閉鈕能關
    if (this.sequence.interaction === 'display') return;
    // choice 互動推進到最後一句後不關閉，讓使用者選；選了才關
    if (this.state === 'typing') {
      if (this.typingTimer) clearTimeout(this.typingTimer);
      const line = this.sequence.lines[this.lineIndex];
      this.textEl.textContent = line.text;
      this.charIndex = line.text.length;
      this._onLineComplete();
    } else if (this.state === 'waiting') {
      const isLast = this.lineIndex === this.sequence.lines.length - 1;
      if (isLast) {
        if (this.sequence.interaction === 'choice' || this.sequence.interaction === 'binary_split') {
          // choice / binary_split 不靠點本體關閉，必須選擇
          return;
        }
        if (this.sequence.persistence === 'pinned') {
          // pinned 只能透過 ✕ 關閉，點本體無作用
          return;
        }
        if (this.sequence.persistence === 'persistent') {
          // persistent 循環：最後一句後回到第一句重新打字
          this._loop();
          return;
        }
        this.dismiss('user_close');
      } else {
        this._advance();
      }
    }
  }

  _advance() {
    this.lineIndex++;
    this.callbacks.onAdvance({
      sequenceId: this.sequence.sequenceId,
      lineIndex: this.lineIndex,
    });
    this._startLine();
  }

  _loop() {
    this.lineIndex = 0;
    this.callbacks.onAdvance({
      sequenceId: this.sequence.sequenceId,
      lineIndex: 0,
      loop: true,
    });
    this._startLine();
  }

  _scheduleAutoClose() {
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    const ms = this.sequence?.auto_close_ms;
    if (typeof ms === 'number' && ms > 0) {
      this.autoCloseTimer = setTimeout(() => this.dismiss('auto_close'), ms);
    }
  }

  _clearTimers() {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
  }

  _reposition() {
    const left = this.anchor.x;
    const top = this.anchor.y - ANCHOR_GAP_PX;
    this.root.style.left = `${left}px`;
    this.root.style.top = `${Math.max(top, 0)}px`;
  }
}

window.p5 = window.p5 || {};
window.p5.SpeechBubble = SpeechBubble;
