# Design — xangi-tasks

## Ownership and flow

xangi-tasks owns tasks, collections and settings. xangi runs the requested work. An AI response finishing does not close a task: it remains Open until the user closes it.

The browser and bundled skill call xangi-tasks. Delegation creates or reuses an xangi session, then sends via `/api/chat` or the platform continuation endpoint. The extension ID/capability pair is `xangi-tasks` / `xangi-tasks.manage`; mail reads use `xangi-mail` / `xangi-mail.read`.

xangi starts the application as a managed extension on an automatically allocated loopback port. The process owns API handling, JSON storage and polling. Users access it through the xangi port.

## Lifecycle and execution

API, storage and UI use the same lifecycle:

- `status: inbox`: an unaccepted proposal; never executes.
- `status: open`: accepted, unfinished work. Manual creation starts here.
- `status: closed`: completed or dismissed work.

`executionStatus` is separate. Inbox and Closed require `idle`. Open supports `idle` (not started), `working` (manually started), `delegating`, `running`, `review` (awaiting human review or uncertain delivery), `completing` (waiting for required conversation closure), and `failed`.

`closedReason` is `completed` or `dismissed` for Closed and null otherwise. Dismissed items appear in Closed and All. Deletion uses `deletedAt` and hides the task without changing its conversation. All is a view, never a stored status.

```text
Inbox --open--> Open --close--> Closed (completed)
Inbox --dismiss-------------> Closed (dismissed)
Closed --open--> Open

Within Open:
idle --execution/start--> working
idle / working / review / failed --delegate--> delegating → running → review / failed
working / review / failed --execution/reset--> idle
```

The browser and server share definitions and validation in `public/task-state.js`. The `taskPhase` helper is a transition/presentation key, not a persisted status. Invalid combinations and old-format data fail startup/import rather than silently losing records.

## API

- `GET /api/health`: service and xangi connection health.
- `GET /api/tasks`: all nondeleted tasks, including status, executionStatus and closedReason.
- `POST /api/tasks`: create Open / idle.
- `GET /api/inbox`: list Inbox items.
- `POST /api/inbox`: create an evidence-backed Inbox item.
- `GET /api/inbox/capabilities`: sourceKeys:true and statusModel:2.
- `GET /api/tasks/:id?history=0`: retrieve a task without requesting chat history.
- `PUT /api/tasks/:id`: edit title, description, notes, labels, due date, repeat and category. Lifecycle changes use dedicated operations.
- `POST /api/tasks/:id/open`: accept Inbox or reopen Closed as Open / idle.
- `POST /api/tasks/:id/dismiss`: dismiss Inbox as Closed / idle with dismissed reason.
- `POST /api/tasks/:id/close`: complete as Closed / idle with completed reason.
- `POST /api/tasks/:id/execution/start`: manually start Open as working.
- `POST /api/tasks/:id/execution/reset`: reset Open execution to idle; does not reopen Closed.
- `POST /api/tasks/:id/delegate`: dispatch to an agent or Project.
- `POST /api/tasks/:id/sync`: refresh execution state.
- `DELETE /api/tasks/:id`: soft delete. The extension bridge also accepts POST to `/delete`.

## Conversations and concurrency

A Project controls its agent and destination; otherwise the selected agent is used. Open conversations are reused; closed conversations are replaced. Destination changes require closing the existing conversation.

Native Project/agent dispatch persists the conversation ID before returning HTTP 202; the UI navigates to that conversation. Acceptance does not guarantee delivery or completion. Completing these tasks does not close their xangi conversation.

A per-task lock covers sending, preventing premature polling and duplicate delegation. Late responses/errors cannot reopen Closed tasks. Restart resumes polling without resending the request. For recorded conversation modes requiring closure confirmation, completing and completionOriginPhase are persisted; a busy conversation returns 202 with completionPending:true. Polling retries closure before marking the task Closed. Pending completion blocks deletion, redelegation and manual execution changes.

## Persistence, recurrence and transfer

Writes are queued and persisted by atomic rename, with memory rollback on failure. Collections and settings use `.collections.json` and `.settings.json` sidecars. Multiple writers to the same data are unsupported.

Recurrence uses repeat={unit,interval,daysOfWeek}, JST dates, Monday-based weeks and month-end/leap-year clamping. Completion and creation of the next Open / idle task share one write. nextTaskId prevents duplicate successors after repeated completion, reopening, or deletion of the next occurrence.

Export uses format xangi-tasks-backup, version 2. It includes Inbox, dismissed and completed tasks, excluding deleted records and credentials. Import requires a preview token bound to both the file and current data; concurrent edits and active tasks prevent replacement. Imported active tasks become Open / review without resending work.

A pre-import backup is saved, and `.import.json` commits the three-file replacement. Startup finishes an interrupted import.

## UI and integrations

Views are Inbox / Open / Closed / All. Details show lifecycle and execution separately. Category selection, folder expansion, view, label and sort order persist in the same browser. Missing categories fall back to all categories. Desktop uses sidebar/list/details; mobile opens panels as needed. Direct edits and drag operations use the same APIs and reload persisted state on failure. Themes are light/dark/system.

The bundled skill reviews important xangi-mail messages, owner conversations and selected Google calendars, then creates Inbox items. sourceKey prevents duplicates after acceptance, dismissal and deletion. Failed reads and deferred decisions remain reviewable. Collection never accepts or executes a task.

Notion uses PUT /api/settings/notion for the parent, POST/PUT /api/tasks/:id/notion for a page, and POST /api/tasks/:id/notion/files for attachments. Credentials remain server-side; uncertain writes are not automatically retried. Full backups use Export / Import.
