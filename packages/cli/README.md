# kvy

**Run Claude Code and Codex on your own machine, and control them from anywhere.**

`kvy` wraps your existing `claude`/`codex` CLI so you get the exact same terminal
experience, plus a synced, end-to-end encrypted timeline you can watch and control
from a browser on any device.

## Install

```bash
npm install -g @vibe-oss/kvy
# or, no Node required:
curl -fsSL https://kvy.dev/install.sh | sh
```

## Usage

```bash
kvy claude   # or: kvy codex
```

That's it — `kvy claude` behaves exactly like `claude`, and the session shows up
live on the web app within a few seconds.

## Links

- [Source & full documentation](https://github.com/trankhacvy/falcon-cli)
- [Architecture](https://github.com/trankhacvy/falcon-cli/blob/main/docs/kvy-system-design.md)
- [Self-hosting](https://github.com/trankhacvy/falcon-cli/blob/main/deploy/README.md)
- [Uninstall](https://github.com/trankhacvy/falcon-cli/blob/main/docs/uninstall.md)

## License

MIT
