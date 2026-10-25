import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export function pageId(value) {
  if (typeof value !== 'string') throw new Error('NotionページのURLまたはIDを入力してください');
  let candidate = value.trim();
  if (candidate.startsWith('https://')) {
    const url = new URL(candidate);
    const allowedHost = ['notion.so', 'notion.site', 'notion.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (!allowedHost) throw new Error('NotionのURLを入力してください');
    candidate = url.pathname.split('/').filter(Boolean).at(-1) || '';
  }
  const match = candidate.match(/(?:^|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  if (!match) throw new Error('NotionページのURLまたはIDが不正です');
  return match[1].replaceAll('-', '').toLowerCase();
}
export function notionUrl(id) { return `https://www.notion.so/${pageId(id)}`; }

export class NotionClient {
  constructor({ keyFile = join(homedir(), '.config/notion/api_key'), fetchImpl = fetch } = {}) {
    this.keyFile = keyFile;
    this.fetch = fetchImpl;
  }
  async request(path, method = 'GET', data) {
    let token;
    try { token = (await readFile(this.keyFile, 'utf8')).trim(); }
    catch { throw new Error('既存のNotion連携キーを読み込めません。サーバーの設定を確認してください'); }
    if (!token) throw new Error('Notion連携キーが空です');
    const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': '2026-03-11' };
    const multipart = data instanceof FormData;
    if (data && !multipart) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(`https://api.notion.com/v1${path}`, { method, headers, body: data ? multipart ? data : JSON.stringify(data) : undefined, signal: AbortSignal.timeout(60000), redirect: 'error' });
    } catch { throw new Error('Notionとの通信が完了しませんでした。再操作の前にNotion側を確認してください'); }
    if (!response.ok) throw Object.assign(new Error(`Notionへの保存に失敗しました（HTTP ${response.status}）。接続権限・ファイル形式・容量を確認してください`), { definiteFailure: [400, 401, 403, 404, 413, 429].includes(response.status) });
    return response.json();
  }
  async getPage(value) {
    const id = pageId(value);
    const page = await this.request(`/pages/${id}`);
    if (page.archived || page.in_trash) throw new Error('Notionページが削除されています');
    return { id, url: notionUrl(id) };
  }
  async createPage(parent, task) {
    const page = await this.request('/pages', 'POST', {
      parent: { page_id: pageId(parent) },
      properties: { title: { title: [{ type: 'text', text: { content: task.title } }] } },
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `xangi-tasks / Task ID: ${task.id}` } }] } }],
    });
    return { id: pageId(page.id), url: notionUrl(page.id) };
  }
  async upload(id, name, bytes, type = 'application/octet-stream') {
    id = pageId(id);
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('ファイルは空でない20 MiB以下のものを選んでください');
    if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 180 || /[\x00-\x1f/\\]/.test(name)) throw new Error('ファイル名が不正です（180バイト以内）');
    const upload = await this.request('/file_uploads', 'POST', { mode: 'single_part', filename: name, content_type: type });
    const uploadId = pageId(upload.id);
    const form = new FormData(); form.append('file', new Blob([bytes], { type }), name);
    const sent = await this.request(`/file_uploads/${uploadId}/send`, 'POST', form);
    if (sent.status !== 'uploaded') throw new Error('Notionへのファイル送信が完了していません');
    const result = await this.request(`/blocks/${id}/children`, 'PATCH', { children: [{ object: 'block', type: 'file', file: { type: 'file_upload', file_upload: { id: uploadId }, name } }] });
    if (!result.results?.[0]?.id) throw new Error('Notionへの添付を確認できませんでした');
    return { blockId: result.results[0].id };
  }
}
