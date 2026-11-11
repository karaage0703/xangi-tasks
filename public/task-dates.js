const jstDateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });

// Calendar goals and external deadlines have deliberately different meanings.
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function dateFields(input, current = {}) {
  if (Object.hasOwn(input, 'dueDate')) throw new Error('Unsupported field: dueDate');
  const targetDate = input.targetDate === undefined ? current.targetDate ?? '' : input.targetDate;
  if (targetDate !== '' && !validDate(targetDate)) throw new Error('目標日は有効な日付を指定してください');
  let day = input.deadlineAt === undefined ? current.deadlineAt ?? '' : input.deadlineAt;
  const status = input.deadlineStatus ?? (input.deadlineAt ? 'confirmed' : current.deadlineStatus ?? 'unknown');
  if (!['unknown', 'none', 'confirmed'].includes(status)) throw new Error('締切の確認状態が無効です');
  if (typeof day !== 'string') throw new Error('締切は日付で指定してください');
  if (input.deadlineStatus && status !== 'confirmed') {
    if (input.deadlineAt) throw new Error('締切日と確認状態が一致しません');
    day = '';
  }
  if (status === 'confirmed') {
    if (!validDate(day)) throw new Error('締切はYYYY-MM-DD形式の有効な日付を指定してください');
  } else if (day) throw new Error('締切日と確認状態が一致しません');
  const evidence = input.deadlineEvidence === undefined ? current.deadlineEvidence ?? '' : input.deadlineEvidence;
  if (typeof evidence !== 'string' || evidence.length > 4000) throw new Error('締切の根拠は4000文字以内で入力してください');
  return { targetDate, deadlineAt: day, deadlineStatus: status, deadlineEvidence: evidence };
}

export function dateSummary(task, now = new Date()) {
  const today = jstDateFormatter.format(now);
  const deadline = task.deadlineStatus === 'confirmed' ? task.deadlineAt || '' : '';
  const open = task.status === 'open';
  return {
    targetToday: open && task.targetDate === today,
    targetPassed: open && Boolean(task.targetDate) && task.targetDate < today,
    deadlineToday: open && Boolean(deadline) && deadline === today,
    deadlineOverdue: open && Boolean(deadline) && deadline < today,
    deadlineSoon: open && Boolean(deadline) && deadline >= today && deadline <= jstDateFormatter.format(new Date(now.getTime() + 7 * 86400000)),
  };
}

export function dateContext(task) {
  return [
    `目標日（自主的な予定・提出期限ではない）: ${task.targetDate || '未設定'}`,
    `実際の締切: ${task.deadlineStatus === 'confirmed' ? task.deadlineAt : task.deadlineStatus === 'none' ? 'なし（確認済み）' : '未確認'}`,
    task.deadlineEvidence ? `締切の根拠: ${task.deadlineEvidence}` : '',
    '目標日超過は予定の見直し。締切超過の警告は確認済みの実際の締切だけに使う。',
  ].filter(Boolean).join('\n');
}

// Missing dates stay last in both directions; equal dates have a stable newest-first tie break.
export function sortTasks(tasks, sort = 'created') {
  const field = sort.startsWith('target-') ? 'targetDate' : sort.startsWith('deadline-') ? 'deadlineAt' : null;
  const newest = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.id.localeCompare(b.id);
  const value = task => field === 'deadlineAt' && task.deadlineStatus !== 'confirmed' ? null : task[field] || null;
  return [...tasks].sort((a, b) => {
    if (!field) return sort === 'created-asc'
      ? (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id)
      : newest(a, b);
    const av = value(a), bv = value(b);
    if (av == null) return bv == null ? newest(a, b) : 1;
    if (bv == null) return -1;
    const order = av < bv ? -1 : av > bv ? 1 : 0;
    return order * (sort.endsWith('-desc') ? -1 : 1) || newest(a, b);
  });
}


export function dateOrderWarning(dates) {
  return dates.deadlineStatus === 'confirmed' && dates.targetDate && dates.deadlineAt && dates.targetDate > dates.deadlineAt
    ? '目標日は締め切り日以前に設定してください（同日は設定できます）' : '';
}
