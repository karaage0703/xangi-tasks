#!/usr/bin/env python3
"""Read sources via authenticated xangi extensions and apply reviewed candidate decisions."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


def api(cli, extension, capability, path, query=None, body=None):
    args = [cli, 'tool', 'extension_request', '--id', extension, '--capability', capability, '--path', path]
    if query is not None:
        args += ['--query-json', json.dumps(query)]
    if body is not None:
        args += ['--method', 'POST', '--body-json', json.dumps(body, ensure_ascii=False)]
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f'{extension} {path}: request failed (exit {result.returncode})')
    data = json.loads(result.stdout)
    if not isinstance(data, dict) or 'error' in data:
        raise RuntimeError(f'{extension} {path}: invalid/error response')
    return data


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.chmod(0o600)
    os.replace(tmp, path)


def conversation_sources(directory, speaker_id, since):
    if not directory.is_dir():
        raise ValueError('conversation log directory does not exist')
    for path in sorted(directory.glob('*.jsonl')):
        if path.stat().st_mtime < since.timestamp():
            continue
        # JSONL records are separated by LF, not Unicode separators inside strings.
        with path.open(encoding='utf-8') as stream:
            rows = [json.loads(line) for line in stream if line.strip()]
        for index, row in enumerate(rows):
            content = row.get('content')
            if row.get('role') != 'user' or not isinstance(content, str):
                continue
            if datetime.fromisoformat(row['createdAt'].replace('Z', '+00:00')) < since:
                continue
            # Speaker headers are supplied by xangi. Do not collect schedules or other people's messages.
            clean = re.sub(r'<system-context>.*?</system-context>|<prefetched-history\b.*?</prefetched-history>', '', content, flags=re.S)
            speaker = re.search(r'^\[発言者:.*?\(ID: (\d+)\)\]', clean, re.M)
            if not speaker or speaker[1] != speaker_id:
                continue
            clock = re.search(r'^\[現在時刻:[^\]]*\]', clean, re.M)
            if not clock:
                continue
            body = clean[clock.end():].strip()
            body = re.sub(r'^---\s*🧵 スレッド元.*?\n---\s*', '', body, flags=re.S)
            if not body:
                continue
            # Subsequent messages are context, not fresh instructions. Needed to exclude resolved work.
            context = []
            for following in rows[max(0,index - 2):index] + rows[index + 1:]:
                value = following.get('content')
                if following.get('role') == 'assistant':
                    text = value.get('result', '') if isinstance(value, dict) else value
                    if text:
                        context.append(str(text))
                elif following.get('role') == 'user' and isinstance(value, str):
                    value = re.sub(r'<system-context>.*?</system-context>|<prefetched-history\b.*?</prefetched-history>', '', value, flags=re.S)
                    clock_context = re.search(r'^\[現在時刻:[^\]]*\]', value, re.M)
                    if clock_context:
                        context.append(value[clock_context.end():].strip())
            key = f'conversation:message:{row["platformMessageId"]}' if row.get('platformMessageId') else f'conversation:{path.stem}:{row["id"]}'
            yield {'sourceKey': key, 'kind': 'conversation',
                   'text': body, 'context': context, 'sourceUrl': '',
                   'sourcePath': str(path), 'entryId': row['id'], 'createdAt': row['createdAt']}


def calendar_sources(config_path, days, executable, run=subprocess.run):
    """Read explicitly selected calendars; keep failures separate from empty calendars."""
    config = json.loads(config_path.read_text())
    if not isinstance(config, list) or not config:
        raise ValueError('calendar config must be a non-empty array')
    tz = ZoneInfo('Asia/Tokyo')
    start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=days)
    for source in config:
        account, calendar = source.get('account'), source.get('calendar', 'primary')
        if not isinstance(account, str) or not account or not isinstance(calendar, str) or not calendar:
            yield None, {'source': 'calendar', 'error': 'calendar account and ID required'}
            continue
        try:
            result = run([executable, '-a', account, 'calendar', 'events', calendar,
                          '--json', '--all-pages', '--no-input', '--from', start.isoformat(),
                          '--to', end.isoformat()], capture_output=True, text=True, timeout=60)
            if result.returncode:
                raise RuntimeError(f'gog calendar failed (exit {result.returncode})')
            data = json.loads(result.stdout)
            if not isinstance(data, dict) or not isinstance(data.get('events'), list) or data.get('nextPageToken'):
                raise ValueError('calendar response incomplete or invalid')
            for event in data['events']:
                try:
                    if event.get('status') == 'cancelled':
                        continue
                    response = next((a.get('responseStatus') for a in event.get('attendees', []) if a.get('self')), None)
                    if response == 'declined':
                        continue
                    event_id = event['id']
                    if not isinstance(event_id, str) or not event_id:
                        raise ValueError('calendar event ID missing')
                    dates = {}
                    for field in ('start', 'end'):
                        value = event[field]
                        if value.get('dateTime'):
                            parsed = datetime.fromisoformat(value['dateTime'].replace('Z', '+00:00'))
                            if parsed.tzinfo is None:
                                raise ValueError('calendar timestamp needs timezone')
                            dates[field] = parsed.astimezone(tz).isoformat()
                        else:
                            dates[field] = datetime.strptime(value['date'], '%Y-%m-%d').date().isoformat()
                    # Calendar + occurrence ID stays stable after edits/moves; recurring instances have distinct IDs.
                    identity = json.dumps([account, calendar, event_id], ensure_ascii=False)
                    key = 'calendar:' + hashlib.sha256(identity.encode()).hexdigest()
                    text = json.dumps({'summary': event.get('summary', ''), 'description': event.get('description', ''),
                                       'location': event.get('location', ''), **dates,
                                       'allDay': 'date' in event['start'], 'selfResponse': response}, ensure_ascii=False)
                    if len(text) > 60000:
                        raise ValueError('calendar event too large; review manually')
                    yield {'sourceKey': key, 'kind': 'calendar', 'text': text, 'context': [],
                           'sourceUrl': event.get('htmlLink', ''), 'calendar': calendar,
                           'account': account, 'calendarLabel': source.get('label', calendar)}, None
                except (KeyError, ValueError, TypeError, AttributeError) as error:
                    yield None, {'source': 'calendar', 'error': str(error)}
        except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
            yield None, {'source': 'calendar', 'calendar': calendar, 'error': str(error)}


def collect(args, state, call=api):
    sources, errors, limits = [], [], []
    seen = state.get('seen', {})
    if args.mail:
        try:
            offset = 0
            while True:
                data = call(args.xangi, 'xangi-mail', 'xangi-mail.read', '/api/important-feed', {'offset': offset, 'limit': 50})
                for entry in data['entries']:
                    key = 'mail:' + entry['uid']
                    if key in seen:
                        continue
                    message = call(args.xangi, 'xangi-mail', 'xangi-mail.read', '/api/messages/' + entry['id'], {'account': entry['account']})
                    if message.get('truncated') or message.get('htmlOnly') or not message.get('body'):
                        errors.append({'sourceKey': key, 'error': 'mail body incomplete; not acknowledged'})
                        continue
                    from urllib.parse import urlencode
                    link = 'https://mail.google.com/mail/u/?' + urlencode({'authuser': entry['account']}) + '#all/' + (entry.get('threadId') or entry['id'])
                    if len(message['body']) > 60000:
                        errors.append({'sourceKey': key, 'error': 'mail too large; review manually'})
                        continue
                    sources.append({'sourceKey': key, 'kind': 'mail', 'text': message['body'], 'subject': entry.get('subject'), 'sourceUrl': link, 'summary': entry.get('summary'), 'context': []})
                    if len(sources) >= args.limit:
                        break
                if len(sources) >= args.limit:
                    limits.append('mail')
                    break
                if data['nextOffset'] is None:
                    break
                if data['nextOffset'] <= offset:
                    raise ValueError('mail pagination did not advance')
                offset = data['nextOffset']
        except (KeyError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            errors.append({'source': 'mail', 'error': str(error)})
    if getattr(args, 'calendar_config', None):
        try:
            count = 0
            for source, error in calendar_sources(args.calendar_config, args.calendar_days, args.gog):
                if error:
                    errors.append(error)
                    continue
                if source['sourceKey'] in seen:
                    continue
                if count >= args.limit:
                    if 'calendar' not in limits:
                        limits.append('calendar')
                    continue
                sources.append(source)
                count += 1
        except (ValueError, OSError, TypeError, AttributeError) as error:
            errors.append({'source': 'calendar', 'error': str(error)})
    if args.sessions_dir:
        try:
            since = datetime.now(timezone.utc) - timedelta(hours=args.hours)
            items = conversation_sources(args.sessions_dir, args.speaker_id, since)
            count = 0
            for source in items:
                if source['sourceKey'] in seen:
                    continue
                if len(json.dumps(source, ensure_ascii=False)) > 60000:
                    errors.append({'sourceKey': source['sourceKey'], 'error': 'conversation context exceeds 60000 chars; review manually'})
                    continue
                sources.append(source)
                count += 1
                if count >= args.limit:
                    limits.append('conversation')
                    break
        except (KeyError, ValueError, OSError) as error:
            errors.append({'source': 'conversation', 'error': str(error)})
    sources = list({source['sourceKey']: source for source in sources}.values())
    tasks = call(args.xangi, 'xangi-tasks', 'xangi-tasks.manage', '/api/tasks')['tasks']
    return {'sources': sources, 'existingTasks': tasks, 'errors': errors, 'limitsReached': limits, 'createdAt': datetime.now(timezone.utc).isoformat()}


def apply(args, state, call=api):
    capabilities = call(args.xangi, 'xangi-tasks', 'xangi-tasks.manage', '/api/inbox/capabilities')
    if capabilities.get('sourceKeys') is not True or capabilities.get('statusModel') != 2:
        raise RuntimeError('Tasks source-key support is required before applying')
    snapshot = json.loads(args.snapshot.read_text())
    decisions = json.loads(args.decisions.read_text())
    sources = {s['sourceKey']: s for s in snapshot['sources']}
    if not isinstance(decisions, list):
        raise ValueError('decisions must be an array')
    keys = set()
    # Validate the whole batch before any write.
    for decision in decisions:
        key = decision['sourceKey']
        if key not in sources or key in keys or decision['action'] not in ('candidate', 'ignore', 'defer'):
            raise ValueError('unknown/duplicate source or invalid action')
        keys.add(key)
        if not str(decision.get('reason', '')).strip():
            raise ValueError('decision reason is required')
        if decision['action'] == 'candidate':
            evidence = decision.get('evidence', '')
            title = decision.get('title', '')
            if not isinstance(title, str) or not 1 <= len(title.strip()) <= 160 or not isinstance(evidence, str) or not 5 <= len(evidence) <= 4000 or evidence not in sources[key]['text']:
                raise ValueError('candidate needs a title and exact source evidence')
    results = []
    for decision in decisions:
        key = decision['sourceKey']
        if key in state.setdefault('seen', {}):
            results.append({'sourceKey': key, 'status': 'already-reviewed'})
            continue
        if decision['action'] == 'defer':
            results.append({'sourceKey': key, 'status': 'deferred'})
            continue
        outcome = {'status': decision['action'], 'reason': decision['reason']}
        if decision['action'] == 'candidate':
            source = sources[key]
            task = call(args.xangi, 'xangi-tasks', 'xangi-tasks.manage', '/api/inbox', body={
                'title': decision['title'], 'description': decision['reason'], 'type': 'action',
                'sourceKey': key, 'sourceText': decision['evidence'], 'sourceUrl': source['sourceUrl'],
                'sourceSpeaker': source['kind']})['task']
            if task.get('source', {}).get('key') != key:
                raise RuntimeError('Tasks does not support idempotent source keys; stop before retrying')
            outcome.update(taskId=task['id'], taskStatus=task['status'])
        state['seen'][key] = outcome
        save(args.state, state)  # One durable checkpoint per confirmed result.
        results.append({'sourceKey': key, **outcome})
    return {'results': results, 'sourceErrors': snapshot.get('errors', [])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['collect', 'apply'])
    parser.add_argument('--xangi', required=True, help='absolute xangi CLI path')
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--decisions', type=Path)
    parser.add_argument('--mail', action='store_true', help='read configured xangi-mail; omit when not installed')
    parser.add_argument('--calendar-config', type=Path, help='JSON array of account/calendar pairs')
    parser.add_argument('--calendar-days', type=int, default=14, help='calendar lookahead from today (JST)')
    parser.add_argument('--gog', default='gog', help='gogcli executable; uses existing authentication')
    parser.add_argument('--sessions-dir', type=Path)
    parser.add_argument('--speaker-id', help='only collect this platform speaker')
    parser.add_argument('--hours', type=int, default=24)
    parser.add_argument('--limit', type=int, default=30, help='max new sources per source type')
    args = parser.parse_args()
    if not Path(args.xangi).is_absolute() or args.limit < 1 or args.hours < 1 or args.calendar_days < 1:
        parser.error('absolute xangi path and positive limits required')
    if args.command == 'collect' and not (args.mail or args.sessions_dir or args.calendar_config):
        parser.error('select --mail, --sessions-dir and/or --calendar-config')
    if args.sessions_dir and not args.speaker_id:
        parser.error('--sessions-dir requires --speaker-id')
    if args.command == 'apply' and not args.decisions:
        parser.error('apply requires --decisions')
    os.umask(0o077)
    args.state.parent.mkdir(parents=True, exist_ok=True)
    with args.state.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(args.state.read_text()) if args.state.exists() else {'seen': {}}
        if args.command == 'collect':
            output = collect(args, state)
            save(args.snapshot, output)
            print(json.dumps({'sources': len(output['sources']), 'errors': output['errors'], 'limitsReached': output['limitsReached'], 'snapshot': str(args.snapshot)}, ensure_ascii=False))
        else:
            output = apply(args, state)
            print(json.dumps(output, ensure_ascii=False))
        return 2 if output.get('errors') or output.get('sourceErrors') else 0


if __name__ == '__main__':
    raise SystemExit(main())
