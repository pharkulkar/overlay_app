// solution-format.js — pure helper for the small "solution panel". Splits an
// OpenAI answer into plain-text and fenced-code segments so the panel can show
// code in a monospace box WITHOUT the ``` markers (easier to read and type from).
// No DOM and no Node-only APIs: loaded by index.html via <script> (attaches
// window.SolutionFormat) and by node tests via require().
(function () {
  'use strict';

  // Returns [{ type: 'text' | 'code', content: string, lang?: string }].
  //  - Blank-only text segments are dropped.
  //  - An UNCLOSED fence (the reply was cut off) is treated as code to the end.
  //  - Code content keeps its indentation; only the single newline right after
  //    the opening fence and right before the closing fence is trimmed.
  function splitSolution(input) {
    const text = typeof input === 'string' ? input.replace(/\r\n/g, '\n') : '';
    const out = [];
    const lines = text.split('\n');
    let mode = 'text';
    let lang = '';
    let buf = [];

    const flush = () => {
      if (mode === 'code') {
        out.push({ type: 'code', lang, content: buf.join('\n') });
      } else {
        const t = buf.join('\n').trim();
        if (t) out.push({ type: 'text', content: t });
      }
      buf = [];
    };

    for (const line of lines) {
      const fence = /^\s*```\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line);
      if (fence) {
        if (mode === 'text') { flush(); mode = 'code'; lang = fence[1] || ''; }
        else { flush(); mode = 'text'; lang = ''; }
      } else {
        buf.push(line);
      }
    }
    flush();  // unclosed code fence is flushed as code; trailing text as text
    return out;
  }

  // True when there is real answer text (not empty, not a placeholder).
  function hasSolution(text) {
    return typeof text === 'string' && text.trim().length > 0;
  }

  const api = { splitSolution, hasSolution };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.SolutionFormat = api;
})();
