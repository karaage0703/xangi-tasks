import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parents[1] / 'skills/xs-xangi-tasks/scripts/collect_candidates.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.args = SimpleNamespace(xangi='/xangi',state=self.root/'state.json',snapshot=self.root/'sources.json',decisions=self.root/'decisions.json',mail=False,sessions_dir=None,speaker_id='123',hours=24,limit=30)

    def fake(self, cli, extension, capability, path, query=None, body=None):
        if path == '/api/inbox/capabilities': return {'sourceKeys':True,'statusModel':2}
        if path == '/api/tasks': return {'tasks':[]}
        if path == '/api/collections': return {'categories': []}
        raise RuntimeError('fixture unavailable')

    def sources(self):
        c.save(self.args.snapshot, {'sources':[{'sourceKey':'mail:a','text':'Please send the document','kind':'mail','sourceUrl':'https://example.test/a'}], 'errors':[]})
        c.save(self.args.decisions,[{'sourceKey':'mail:a','action':'candidate','title':'Send document','evidence':'send the document','reason':'Explicit outstanding request'}])

    def test_apply_crash_retry_uses_identical_key(self):
        self.sources(); state={}; remote={}; attempts=[]
        def api(*args, **kwargs):
            if args[3] != '/api/inbox': return self.fake(*args, **kwargs)
            body=kwargs['body']; key=body['sourceKey']; attempts.append(key)
            remote.setdefault(key,{'id':'one','status':'inbox','source':{'key':key}})
            if len(attempts)==1: raise RuntimeError('response lost after commit')
            return {'task':remote[key]}
        with self.assertRaises(RuntimeError):c.apply(self.args,state,api)
        self.assertFalse(self.args.state.exists())
        c.apply(self.args,state,api)
        c.apply(self.args,state,api)
        self.assertEqual(attempts,['mail:a','mail:a']);self.assertEqual(len(remote),1)
        self.assertEqual(json.loads(self.args.state.read_text())['seen']['mail:a']['taskId'],'one')

    def test_proposed_category_is_forwarded_without_acceptance(self):
        self.sources()
        decisions=json.loads(self.args.decisions.read_text())
        decisions[0]['categoryId']='work'
        c.save(self.args.decisions,decisions)
        sent=[]
        def api(*args, **kwargs):
            if args[3] != '/api/inbox': return self.fake(*args, **kwargs)
            sent.append(kwargs['body'])
            return {'task': {'id':'one','status':'inbox','source':{'key':'mail:a'}}}
        c.apply(self.args,{},api)
        self.assertEqual(sent[0]['categoryId'],'work')
        self.assertNotIn('status',sent[0])

    def test_invalid_evidence_and_unsupported_backend_write_nothing(self):
        self.sources(); decision=json.loads(self.args.decisions.read_text());decision[0]['evidence']='Invented evidence';c.save(self.args.decisions,decision)
        with self.assertRaises(ValueError):c.apply(self.args,{},self.fake)
        self.assertFalse(self.args.state.exists())
        with self.assertRaises(RuntimeError):c.apply(self.args,{},lambda *a,**kw: {'sourceKeys':False})

    def test_ignore_is_durable_defer_is_not(self):
        self.sources();c.save(self.args.decisions,[{'sourceKey':'mail:a','action':'defer','reason':'uncertain'}]);state={}
        c.apply(self.args,state,self.fake);self.assertNotIn('mail:a',state['seen'])
        c.save(self.args.decisions,[{'sourceKey':'mail:a','action':'ignore','reason':'Already resolved'}]);c.apply(self.args,state,self.fake)
        self.assertEqual(state['seen']['mail:a']['status'],'ignore')

    def write_conversation(self):
        now=datetime.now(timezone.utc).isoformat()
        def row(identifier,role,content):return {'id':identifier,'role':role,'content':content,'createdAt':now}
        rows=[row('x','user','[発言者: other (ID: 456)]\n[現在時刻: today]\nOther task'),
              row('a','user','[発言者: owner (ID: 123)]\n[現在時刻: today]\nPlease write a report'),
              row('b','assistant',{'result':'The report is complete'}),
              row('c','user','Scheduled instruction without speaker')]
        p=self.root/'session.jsonl';p.write_text(''.join(json.dumps(x)+'\n' for x in rows))
        return p

    def test_owner_only_and_later_context(self):
        self.write_conversation()
        sources=list(c.conversation_sources(self.root,'123',datetime.now(timezone.utc)-timedelta(hours=1)))
        self.assertEqual(len(sources),1);self.assertEqual(sources[0]['text'],'Please write a report')
        self.assertIn('The report is complete',sources[0]['context'])
        self.assertEqual(sources[0]['sourceKey'],'conversation:session:a')

    def test_mail_failure_preserves_conversation_and_no_mail_is_optional(self):
        self.write_conversation();self.args.sessions_dir=self.root
        self.args.mail=True;out=c.collect(self.args,{},self.fake)
        self.assertEqual(len(out['sources']),1);self.assertEqual(len(out['errors']),1)
        self.args.mail=False;out=c.collect(self.args,{},self.fake)
        self.assertEqual(out['errors'],[])

    def test_mail_pagination_and_body_evidence(self):
        self.args.mail=True
        def api(*args, **kwargs):
            path=args[3]
            if path=='/api/important-feed':
                offset=args[4]['offset'];return {'entries':[{'uid':str(offset),'id':str(offset),'account':'a@test'}], 'nextOffset':1 if offset==0 else None}
            if path.startswith('/api/messages/'):return {'body':'Original mail request'}
            return self.fake(*args,**kwargs)
        out=c.collect(self.args,{'seen':{'mail:0':{}}},api)
        self.assertEqual(out['errors'],[]);self.assertEqual(len(out['sources']),1)
        self.assertEqual(out['sources'][0]['sourceKey'],'mail:1')
        self.assertEqual(out['sources'][0]['text'],'Original mail request')

    def calendar_fixture(self):
        config = self.root / 'calendars.json'
        c.save(config, [{'account': 'owner@example.test', 'calendar': 'primary'}])
        event = {'id': 'event_1', 'summary': 'Prepare slides', 'description': 'Send slides before meeting',
                 'start': {'dateTime': '2026-10-25T01:00:00Z'}, 'end': {'dateTime': '2026-10-25T02:00:00Z'},
                 'htmlLink': 'https://calendar.google.com/event/example'}
        return config, event

    def test_calendar_jst_evidence_stable_key_and_recurrence(self):
        config, event = self.calendar_fixture(); commands = []
        def run(command, **kwargs):
            commands.append(command)
            return SimpleNamespace(returncode=0, stdout=json.dumps({'events': [event]}))
        first = list(c.calendar_sources(config, 14, 'gog', run))[0][0]
        self.assertIn('2026-10-25T10:00:00+09:00', first['text'])
        self.assertIn('Send slides before meeting', first['text'])
        self.assertIn('--all-pages', commands[0]); self.assertIn('--no-input', commands[0])
        event['start']['dateTime'] = '2026-10-26T01:00:00Z'
        self.assertEqual(first['sourceKey'], list(c.calendar_sources(config, 14, 'gog', run))[0][0]['sourceKey'])
        event['id'] = 'event_2'
        self.assertNotEqual(first['sourceKey'], list(c.calendar_sources(config, 14, 'gog', run))[0][0]['sourceKey'])
        c.save(self.args.snapshot, {'sources': [first]})
        c.save(self.args.decisions, [{'sourceKey': first['sourceKey'], 'action': 'candidate', 'title': 'Prepare slides',
                                     'evidence': 'Send slides before meeting', 'reason': 'Explicit preparation'}])
        sent = []
        def api(*args, **kwargs):
            if args[3] != '/api/inbox': return self.fake(*args, **kwargs)
            body = kwargs['body']; sent.append(body)
            return {'task': {'id': 'cal-task', 'status': 'inbox', 'source': {'key': body['sourceKey']}}}
        state = {}; c.apply(self.args, state, api); c.apply(self.args, state, api)
        self.assertEqual(len(sent), 1); self.assertEqual(sent[0]['sourceSpeaker'], 'calendar')

    def test_calendar_cancelled_declined_all_day_and_invalid(self):
        config, event = self.calendar_fixture()
        events = [dict(event, status='cancelled'), dict(event, attendees=[{'self': True, 'responseStatus': 'declined'}]),
                  dict(event, id='all-day', start={'date': '2026-10-25'}, end={'date': '2026-10-26'}),
                  dict(event, id='broken', start={'dateTime': 'invalid'})]
        out = list(c.calendar_sources(config, 14, 'gog', lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps({'events': events}))))
        self.assertEqual(len(out), 2); self.assertTrue(json.loads(out[0][0]['text'])['allDay'])
        self.assertIsNotNone(out[1][1])

    def test_calendar_failure_isolation_pagination_and_seen_limits(self):
        from unittest.mock import patch
        config, event = self.calendar_fixture()
        c.save(config, [{'account': 'bad', 'calendar': 'primary'}, {'account': 'good', 'calendar': 'primary'}])
        def run(command, **kwargs):
            return SimpleNamespace(returncode=1 if command[2] == 'bad' else 0, stdout=json.dumps({'events': [event]}))
        out = list(c.calendar_sources(config, 14, 'gog', run))
        self.assertIsNotNone(out[0][1]); self.assertIsNotNone(out[1][0])
        partial = list(c.calendar_sources(config, 14, 'gog', lambda *a, **kw: SimpleNamespace(returncode=0, stdout='{"events":[],"nextPageToken":"more"}')))
        self.assertTrue(all(error for source, error in partial))
        self.args.calendar_config=config; self.args.calendar_days=14; self.args.gog='gog'; self.args.limit=1
        source=out[1][0]
        with patch.object(c, 'calendar_sources', return_value=iter(out)):
            result=c.collect(self.args, {'seen': {source['sourceKey']: {}}}, self.fake)
        self.assertEqual(result['sources'], []); self.assertEqual(len(result['errors']), 1)
        with patch.object(c, 'calendar_sources', return_value=iter([(source,None),(dict(source,sourceKey='calendar:other'),None)])):
            result=c.collect(self.args, {}, self.fake)
        self.assertEqual(len(result['sources']), 1); self.assertIn('calendar', result['limitsReached'])


if __name__=='__main__':unittest.main()
