/* Demo streaming chat app. Kept dependency-free on purpose: it is the reference
 * fixture for agent-ui-guard and exposes the DOM contract documented in the
 * package README. */
(() => {
  'use strict';

  const MODE = document.body.dataset.mode || 'healthy';
  const TERMINAL_TOOL_STATES = new Set(['done', 'error', 'cancelled']);

  const sessions = {
    s1: {
      title: 'Release notes',
      turns: [
        {
          id: 'turn-1',
          state: 'done',
          user: 'What changed in v2?',
          text: 'v2 batches streaming deltas per frame, closes tool calls before the turn ends, and gives dialogs a single focus owner.',
          toolCalls: [{ id: 'turn-1-tool-1', name: 'web.search', state: 'done' }],
        },
      ],
    },
    s2: { title: 'Incident 441', turns: [] },
    s3: { title: 'New session', turns: [] },
  };

  const state = { current: 's1', seq: 10, streaming: null };

  const transcript = document.getElementById('transcript');
  const sessionList = document.getElementById('session-list');
  const sessionTitle = document.getElementById('session-title');
  const composer = document.getElementById('composer');
  const input = document.getElementById('composer-input');
  const sendButton = document.getElementById('send');
  const cancelButton = document.getElementById('cancel-turn');

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      node.setAttribute(key, value);
    }
    for (const child of children || []) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function renderSessions() {
    sessionList.textContent = '';
    for (const [id, session] of Object.entries(sessions)) {
      const button = el('button', {
        type: 'button',
        class: 'session',
        'data-session': id,
        'aria-current': id === state.current ? 'true' : 'false',
      });
      button.textContent = session.title;
      button.addEventListener('click', () => switchSession(id));
      const item = el('li', {});
      item.appendChild(button);
      sessionList.appendChild(item);
    }
  }

  function renderToolCall(toolCall, live) {
    const node = el('div', {
      class: 'tool-call',
      'data-tool-call': '',
      'data-tool-call-id': toolCall.id,
      'data-tool-call-name': toolCall.name,
      'data-state': toolCall.state,
    });
    node.appendChild(el('span', { class: 'dot' }));
    node.appendChild(el('span', { class: 'tool-name' }, [toolCall.name]));
    node.appendChild(el('span', { class: 'tool-state' }, [toolCall.state]));
    if (live) live.toolEls.set(toolCall.id, node);
    return node;
  }

  function renderTurn(turn) {
    const article = el('article', {
      class: 'turn',
      'data-turn': '',
      'data-turn-id': turn.id,
      'data-turn-state': turn.state,
    });
    article.appendChild(el('div', { class: 'msg user' }, [turn.user]));

    const assistant = el('div', { class: 'msg assistant', 'data-role': 'assistant' });
    const toolWrap = el('div', { class: 'tool-calls' });
    const content = el('div', { class: 'content' });
    content.textContent = turn.text || '';

    if (turn.state === 'streaming') {
      assistant.setAttribute('aria-busy', 'true');
    }

    assistant.appendChild(toolWrap);
    assistant.appendChild(content);
    if (turn.state === 'streaming') {
      assistant.appendChild(el('span', { class: 'stream-pill', 'data-streaming': 'true' }, ['streaming']));
    }
    article.appendChild(assistant);

    const live = { article, assistant, content, toolWrap, toolEls: new Map() };
    for (const toolCall of turn.toolCalls) {
      toolWrap.appendChild(renderToolCall(toolCall, live));
    }
    article.__live = live;
    return article;
  }

  function renderTranscript() {
    transcript.textContent = '';
    const session = sessions[state.current];
    if (session.turns.length === 0) {
      transcript.appendChild(
        el('p', { class: 'empty' }, ['No messages yet. Ask the agent something.']),
      );
      return;
    }
    for (const turn of session.turns) {
      transcript.appendChild(renderTurn(turn));
    }
    scrollToEnd();
  }

  function scrollToEnd() {
    transcript.scrollTop = transcript.scrollHeight;
  }

  function updateComposer() {
    const busy = state.streaming !== null;
    input.disabled = busy;
    sendButton.disabled = busy;
    cancelButton.hidden = !busy;
  }

  function updateToolDom(live, toolCall) {
    const node = live.toolEls.get(toolCall.id);
    if (!node) return;
    node.setAttribute('data-state', toolCall.state);
    const label = node.querySelector('.tool-state');
    if (label) label.textContent = toolCall.state;
  }

  function upsertToolCall(live, toolCall) {
    let existing = live.turn.toolCalls.find((item) => item.id === toolCall.id);
    if (!existing) {
      existing = { id: toolCall.id, name: toolCall.name || 'tool', state: toolCall.state || 'running' };
      live.turn.toolCalls.push(existing);
      live.toolWrap.appendChild(renderToolCall(existing, live));
      return;
    }
    if (toolCall.name) existing.name = toolCall.name;
    if (toolCall.state) existing.state = toolCall.state;
    updateToolDom(live, existing);
  }

  function finalizeTurn(turn, nextState) {
    if (turn.state === nextState) return;
    turn.state = nextState;
    const live = state.streaming;
    if (!live || live.turn !== turn) return;

    // A cancelled or failed turn cleans up whatever tool call was still running.
    if (nextState !== 'done') {
      for (const toolCall of turn.toolCalls) {
        if (TERMINAL_TOOL_STATES.has(toolCall.state)) continue;
        toolCall.state = nextState === 'cancelled' ? 'cancelled' : 'error';
        updateToolDom(live, toolCall);
      }
    }

    live.article.setAttribute('data-turn-state', nextState);
    live.assistant.removeAttribute('aria-busy');
    const pill = live.assistant.querySelector('[data-streaming="true"]');
    if (pill) pill.remove();
    state.streaming = null;
    updateComposer();
    scrollToEnd();
  }

  function parseEvent(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return { event: null, data: null };
    try {
      return { event, data: JSON.parse(dataLines.join('\n')) };
    } catch {
      return { event: null, data: null };
    }
  }

  function handleEvent(event, data, live) {
    if (!live || live.turn.state !== 'streaming') return;
    if (event === 'turn' && data && typeof data.state === 'string') {
      if (data.state !== 'streaming') finalizeTurn(live.turn, data.state);
      return;
    }
    if (event === 'text' && data && typeof data.delta === 'string') {
      live.turn.text += data.delta;
      live.content.textContent = live.turn.text;
      scrollToEnd();
      return;
    }
    if (event === 'tool_call' && data && typeof data.id === 'string') {
      upsertToolCall(live, data);
    }
  }

  async function streamTurn(text) {
    const session = sessions[state.current];
    const turn = {
      id: `turn-${++state.seq}-${state.current}`,
      state: 'streaming',
      user: text,
      text: '',
      toolCalls: [],
    };
    session.turns.push(turn);

    const article = renderTurn(turn);
    const empty = transcript.querySelector('.empty');
    if (empty) empty.remove();
    transcript.appendChild(article);

    const live = {
      turn,
      article,
      assistant: article.__live.assistant,
      content: article.__live.content,
      toolWrap: article.__live.toolWrap,
      toolEls: article.__live.toolEls,
      controller: new AbortController(),
    };
    state.streaming = live;
    updateComposer();
    scrollToEnd();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, turnId: turn.id }),
        signal: live.controller.signal,
      });

      if (!response.ok) {
        // Deliberately console.warn: the HTTP status itself is what the
        // harness reports, and the fixture should not double-report it as a
        // console error.
        console.warn('chat request failed with HTTP', response.status);
        finalizeTurn(turn, 'error');
        return;
      }
      if (!response.body) {
        finalizeTurn(turn, 'error');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const parsed = parseEvent(raw);
          if (parsed.event) handleEvent(parsed.event, parsed.data, live);
          if (live.turn.state !== 'streaming') {
            finished = true;
            break;
          }
          index = buffer.indexOf('\n\n');
        }
      }

      if (finished) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        return;
      }

      if (live.turn.state === 'streaming') {
        // Fixture bug: the connection ended without a `turn` event, and the UI
        // stays busy forever. In healthy mode the server always closes the turn.
        console.warn('stream ended before the turn was closed');
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        finalizeTurn(turn, 'cancelled');
      } else {
        console.warn('chat failed', error);
        finalizeTurn(turn, 'error');
      }
    }
  }

  function sendCurrentPrompt() {
    const text = input.value.trim();
    if (!text || state.streaming) return;
    input.value = '';
    void streamTurn(text);
  }

  function abortActiveTurn() {
    if (!state.streaming) return;
    const live = state.streaming;
    live.controller.abort();
    finalizeTurn(live.turn, 'cancelled');
  }

  function switchSession(id) {
    if (!sessions[id] || id === state.current) return;
    abortActiveTurn();
    state.current = id;
    sessionTitle.textContent = sessions[id].title;
    renderSessions();
    renderTranscript();
    updateComposer();
  }

  function newSession() {
    abortActiveTurn();
    const id = `s${Object.keys(sessions).length + 1}`;
    sessions[id] = { title: `New session ${Object.keys(sessions).length}`, turns: [] };
    state.current = id;
    sessionTitle.textContent = sessions[id].title;
    renderSessions();
    renderTranscript();
    updateComposer();
    input.focus();
  }

  // --- dialogs -------------------------------------------------------------
  // In `double-modal` mode opening one dialog no longer closes the other; that
  // is the injected bug the harness is meant to catch.
  const BUG_DOUBLE_MODAL = MODE === 'double-modal';
  const modalIds = ['palette', 'settings-dialog'];

  function openModal(id) {
    if (!BUG_DOUBLE_MODAL) {
      for (const other of modalIds) {
        if (other !== id) document.getElementById(other).hidden = true;
      }
    }
    const node = document.getElementById(id);
    node.hidden = false;
    const focusable = node.querySelector('input, button');
    if (focusable) focusable.focus();
  }

  function closeModal(id) {
    document.getElementById(id).hidden = true;
  }

  function topOpenModal() {
    for (const id of modalIds) {
      if (!document.getElementById(id).hidden) return id;
    }
    return null;
  }

  function closeTopModal() {
    const id = topOpenModal();
    if (id) closeModal(id);
    return id !== null;
  }

  // --- wiring --------------------------------------------------------------
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendCurrentPrompt();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendCurrentPrompt();
    }
  });

  cancelButton.addEventListener('click', () => {
    if (state.streaming) state.streaming.controller.abort();
  });

  document.getElementById('open-palette').addEventListener('click', () => openModal('palette'));
  document.getElementById('open-settings').addEventListener('click', () => openModal('settings-dialog'));
  document.getElementById('new-session').addEventListener('click', newSession);

  for (const id of modalIds) {
    const node = document.getElementById(id);
    node.addEventListener('click', (event) => {
      if (event.target === node) closeModal(id);
    });
  }

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  }

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openModal('palette');
      return;
    }
    if (event.key === 'Escape') {
      if (closeTopModal()) event.preventDefault();
    }
  });

  renderSessions();
  renderTranscript();
  updateComposer();
})();
