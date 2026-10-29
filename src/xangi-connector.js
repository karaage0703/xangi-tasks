function messageText(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.message === 'string') return message.message;
  return '';
}

export class XangiConnector {
  constructor({ baseUrl, token = '', provider = 'codex', fetchImpl = fetch, timeoutMs = 15_000 }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.provider = provider === 'claude' ? 'claude' : 'codex';
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.turns = new Map();
  }

  async health() {
    return this.#request(`/api/info?provider=${this.provider}`);
  }

  async listAgents() {
    const body = await this.#request('/api/agents');
    if (!Array.isArray(body.agents)) throw new Error('エージェント一覧を取得できませんでした');
    return body.agents.map(({ id, name, backend, model }) => ({ id, name, backend, model }));
  }

  async listProjects() {
    const body = await this.#request('/api/projects');
    if (!Array.isArray(body.projects)) throw new Error('Project一覧を取得できませんでした');
    return body.projects.map(({ id, name, channel, defaultAgentId }) => ({ id, name, channel, defaultAgentId }));
  }

  async dispatchTask(task, onSessionReady = async () => {}) {
    const text = [task.title, 'xangi-tasksの依頼です。実行内容と結果はこの会話で報告してください。',
      `Task ID: ${task.id}`, task.description, task.delegationInstructions,
      task.dueDate ? `期限: ${task.dueDate}` : ''].filter(Boolean).join('\n\n');
    let sessionId = task.xangiSessionId;
    let session;
    if (sessionId) {
      session = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}?limit=1`);
      if (session.isActive) throw new Error('会話は処理中です。終了後に依頼してください');
      if (session.lifecycle === 'closed') { sessionId = null; session = null; }
      else if ((task.conversationProjectId || '') !== (task.projectId || '') || (task.conversationAgentId ?? task.agentId ?? '') !== (task.agentId || '')) {
        throw new Error('依頼先を変更する場合は、先に現在の会話を閉じてください');
      }
    }
    if (!sessionId) {
      let project;
      if (task.projectId) {
        project = (await this.listProjects()).find(p => p.id === task.projectId);
        if (!project) throw new Error('Projectが見つかりません。選び直してください');
      }
      const created = await this.#request('/api/sessions', { method: 'POST', body: JSON.stringify(project
        ? { projectId: project.id, message: text }
        : { ...(task.agentId ? { agentId: task.agentId } : {}) }) });
      if (!created.sessionId) throw new Error('xangi did not return a sessionId');
      sessionId = String(created.sessionId);
      session = { platform: project?.channel?.platform || 'web' };
    }
    try {
      // Persist the conversation before execution can update the task.
      await onSessionReady({ sessionId });
      if (session.platform === 'discord' || session.platform === 'slack') {
        await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}/${session.platform}-continue`, { method: 'POST', body: JSON.stringify({ message: text }) }, null);
      } else {
        await this.renameSession(sessionId, task.title);
        await this.sendAgentMessage(sessionId, text);
      }
      return { sessionId };
    } catch (error) { error.sessionId = sessionId; throw error; }
  }

  async readTaskSession(sessionId) {
    const turn = this.turns.get(sessionId);
    if (turn) return { state: turn.state, error: turn.error };
    const body = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}?limit=1`);
    return { state: body.isActive ? 'running' : 'idle', lifecycle: body.lifecycle };
  }

  async sendAgentMessage(sessionId, message) {
    const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    // Clear the previous result before sending so polling cannot complete a follow-up early.
    const turn = { state: 'running', result: '', error: '' };
    this.turns.set(sessionId, turn);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ appSessionId: sessionId, message }),
      });
      if (!response.ok || !response.body) throw new Error(`エージェントへの送信に失敗しました（HTTP ${response.status}）`);
    } catch (error) { turn.state = 'idle'; turn.error = error.message; throw error; }
    finally { clearTimeout(timer); }
    void (async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
            if (!['done', 'error'].includes(event)) continue;
            const data = JSON.parse(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
            if (event === 'error') throw new Error(data.error || data.message || 'エージェントの実行に失敗しました');
            turn.result = String(data.response || data.result || '');
            turn.state = 'idle';
          }
          if (buffer.length > 2_000_000) throw new Error('エージェントの応答が長すぎます');
        }
        if (turn.state !== 'idle') throw new Error('応答の接続が切れました。会話を確認してください');
      } catch (error) { turn.state = 'idle'; turn.error = error.message; }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    })();
    return { sessionId };
  }

  async sendTask(task) {
    const text = [
      task.title,
      'xangi-tasksから依頼されたタスクです。以下を実行し、最後に実行内容と結果を簡潔に報告してください。',
      `Task ID: ${task.id}`,
      task.description ? `Description:\n${task.description}` : '',
      task.delegationInstructions ? `今回の追加指示:\n${task.delegationInstructions}` : '',
      task.dueDate ? `期限: ${task.dueDate}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (task.agentId) {
      const agent = (await this.listAgents()).find(agent => agent.id === task.agentId);
      if (!agent) throw new Error('選択したエージェントが見つかりません。選び直してください');
      const created = await this.#request('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId: task.agentId }) });
      if (!created.sessionId) throw new Error('xangi did not return a sessionId');
      const sessionId = String(created.sessionId);
      try {
        await this.renameSession(sessionId, task.title);
        await this.sendAgentMessage(sessionId, text);
        return { sessionId };
      } catch (error) { error.sessionId = sessionId; throw error; }
    }
    const body = await this.#request('/api/prompt', {
      method: 'POST',
      body: JSON.stringify({ text, provider: this.provider }),
    });
    if (!body.sessionId) throw new Error('xangi did not return a sessionId');
    const sessionId = String(body.sessionId);
    try {
      await this.renameSession(sessionId, task.title);
      return { sessionId };
    } catch (error) {
      return { sessionId, titleError: `会話タイトルの同期に失敗: ${error.message}` };
    }
  }

  async renameSession(sessionId, title) {
    await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH', body: JSON.stringify({ title }),
    });
  }

  async sendMessage(sessionId, text, agentId = '') {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) throw new Error('Message is required');
    if (agentId) return this.sendAgentMessage(sessionId, normalizedText);
    const body = await this.#request('/api/prompt', {
      method: 'POST',
      body: JSON.stringify({ text: normalizedText, provider: this.provider, sessionId }),
    });
    if (!body.sessionId) throw new Error('xangi did not return a sessionId');
    if (String(body.sessionId) !== sessionId) throw new Error('xangi returned a different sessionId');
    return { sessionId };
  }

  async completeSession(sessionId) {
    const result = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      body: JSON.stringify({ force: false }),
    });
    if (result.ok !== true || result.lifecycle !== 'closed') {
      throw new Error('xangi did not confirm session completion');
    }
    this.turns.delete(sessionId);
    return result;
  }

  async readHistory(sessionId, limit = 50, agentId = '') {
    if (agentId) {
      const body = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}?limit=50`);
      return (body.messages || []).map(m => ({ role: m.role, text: String(m.content || '') }));
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 50);
    const params = new URLSearchParams({ provider: this.provider, limit: String(safeLimit) });
    const body = await this.#request(
      `/api/sessions/${encodeURIComponent(sessionId)}/history?${params}`,
    );
    const history = Array.isArray(body.history) ? body.history : [];
    return history
      .map((message) => ({
        role: message?.role === 'assistant' ? 'assistant' : 'user',
        text: messageText(message),
      }))
      .filter((message) => message.text);
  }

  async readSession(sessionId, agentId = '') {
    if (agentId) {
      const turn = this.turns.get(sessionId);
      if (turn) return { ...turn };
      const body = await this.#request(`/api/sessions/${encodeURIComponent(sessionId)}?limit=2`);
      const last = body.messages?.at(-1);
      return { state: body.isActive ? 'running' : 'idle', result: !body.isActive && last?.role === 'assistant' ? String(last.content || '') : '', error: !body.isActive && last?.role !== 'assistant' ? '応答の完了を確認できません。会話を確認してください' : '' };
    }
    const params = new URLSearchParams({
      provider: this.provider,
      sessionId,
      after: '0',
    });
    const body = await this.#request(`/api/messages?${params}`);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const errorMessage = [...messages].reverse().find((message) => message?.type === 'error');
    const resultMessage = [...messages]
      .reverse()
      .find((message) => message?.type === 'result' && messageText(message));
    return {
      state: String(body.state || 'unknown'),
      result: resultMessage ? messageText(resultMessage) : '',
      error: errorMessage ? messageText(errorMessage) || 'xangi execution failed' : '',
    };
  }

  async #request(path, init = {}, timeoutMs = this.timeoutMs) {
    if (!this.baseUrl) throw new Error('XANGI_URL is not configured');
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      // Platform continuation responds after the AI finishes, like the chat SSE.
      // Its lifecycle is tracked by Tasks, not by the short metadata timeout.
      signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok) {
      const error = new Error(body.error || `xangi returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }
}
