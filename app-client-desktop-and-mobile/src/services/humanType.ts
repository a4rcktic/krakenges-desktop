/**
 * Kraken Ges Human Typing Simulation (Anti-Bot Paste Protection)
 * 
 * Bypasses Cloudflare, DataDome, Akamai, and banking bot detectors by simulating
 * real human keystroke cadence, variable inter-key delays (45ms-130ms),
 * natural rhythm fluctuations, and full DOM KeyboardEvents.
 */

/**
 * Returns a standalone JavaScript snippet that can be injected into any WebView
 * or executed via InAppBrowser.executeScript.
 */
export function getHumanTypeInjectionScript(): string {
  return `
(function() {
  var FLAG = '__ht_loaded__';
  if (window[FLAG]) return;
  try {
    Object.defineProperty(window, FLAG, { value: true, writable: false, enumerable: false, configurable: false });
  } catch(e) {
    window[FLAG] = true;
  }

  var htFn = async function(selector, text, options) {
    options = options || {};
    const minDelay = options.minDelay || 40;
    const maxDelay = options.maxDelay || 115;
    
    let el = null;
    if (typeof selector === 'string') {
      el = document.querySelector(selector);
    } else if (selector instanceof HTMLElement) {
      el = selector;
    } else {
      el = document.activeElement;
    }

    if (!el) {
      console.warn('[Kraken Ges HumanType] No target element found');
      return false;
    }

    el.focus();

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      // Keystroke lifecycle events
      const keydown = new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true });
      const keypress = new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true });
      el.dispatchEvent(keydown);
      el.dispatchEvent(keypress);

      // Append character to value
      if ('value' in el) {
        el.value = (el.value || '') + char;
      } else if (el.isContentEditable) {
        el.textContent = (el.textContent || '') + char;
      }

      // Input change event
      const inputEvt = new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true });
      el.dispatchEvent(inputEvt);

      const keyup = new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true });
      el.dispatchEvent(keyup);

      // Natural typing jitter: occasional longer pause for punctuation or micro-hesitations
      let delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      if (char === ' ' || char === '.' || char === '@') {
        delay += Math.floor(Math.random() * 80) + 40;
      }

      await new Promise(r => setTimeout(r, delay));
    }

    // Final change dispatch
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  try {
    Object.defineProperty(window, '__krakengesHumanType', {
      value: htFn,
      writable: true,
      enumerable: false,
      configurable: true
    });
  } catch(e) {
    window.__krakengesHumanType = htFn;
  }
})();
`;
}

/**
 * Simulates typing text into an HTML input or textarea element on the active document.
 */
export async function simulateHumanTyping(
  targetElement: HTMLElement,
  text: string,
  onProgress?: (typedCount: number, total: number) => void
): Promise<void> {
  targetElement.focus();

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    const keydown = new KeyboardEvent('keydown', { key: char, bubbles: true });
    targetElement.dispatchEvent(keydown);

    if ('value' in targetElement) {
      (targetElement as HTMLInputElement).value += char;
    } else if (targetElement.isContentEditable) {
      targetElement.textContent += char;
    }

    targetElement.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
    targetElement.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));

    if (onProgress) onProgress(i + 1, text.length);

    let delay = Math.floor(Math.random() * 70) + 45;
    if (char === ' ' || char === '@' || char === '.') {
      delay += Math.floor(Math.random() * 60) + 30;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  targetElement.dispatchEvent(new Event('change', { bubbles: true }));
}
