# @feedbacks/cli

Command-line interface of [Feedbacks](https://github.com/krishna2206/feedbacks) — team chat that turns
feedback into tickets — for humans and AI agents. Single file, no dependencies, Node 22+.

```bash
npm install -g @feedbacks/cli
feedbacks login --url https://feedbacks.example.com --token fbk_…   # Settings › API tokens
feedbacks messages list feedback --unprocessed --since 24h
feedbacks tickets create --project APP --from-messages <id1>,<id2> --priority high
feedbacks --help
```

`--json` gives a stable machine-readable output; exit codes: 0 ok, 1 error, 2 usage,
3 auth/permission, 4 not found, 5 conflict, 6 rate limited, 7 network. See
[docs/AGENTS.md](https://github.com/krishna2206/feedbacks/blob/main/docs/AGENTS.md).

License: AGPL-3.0-only.
