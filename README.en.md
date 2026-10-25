[日本語](README.md) | English

# xangi-tasks

Organize tasks and delegate work to xangi when needed.

- Review candidates in Inbox, manage unfinished tasks in Open, and find completed tasks in Closed.
- Select a task name to view its details and actions.
- Delegate from a task and follow its conversation link to review results or ask follow-up questions.
- Export and import categories, tasks, and settings as JSON.

## Quickstart

Requires Node.js 22+ and xangi with Web Chat enabled.

```bash
npm ci
cp .env.example .env
# Set XANGI_URL and XANGI_TOKEN in .env
xangi extension link /absolute/path/to/xangi-tasks/xangi-extension.json
xangi extension start xangi-tasks
```

Open xangi-tasks from the xangi Extensions screen.

## Documentation

- [Usage, configuration, and verification](docs/en/usage.md)
- [Design and API](docs/en/design.md)

## License

[MIT](LICENSE)
