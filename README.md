# CPA Console

A self-contained web console for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). One command downloads
CPA, runs it as a supervised process and gives you a polished UI to manage it. You don't install CPA separately.

- **Process management**: installs the latest CPA release for your platform (checksum-verified), restarts it if it
  crashes, and updates it in one click.
- **Usage analytics**: CPA only keeps per-request usage for a few minutes. The console drains it continuously into
  SQLite, so you get history by model, credential, client key and provider, with tokens, latency and failures.
- **Accounts at a glance**: every Claude and Codex account with its 5-hour, weekly and Fable limits, how full each is
  and when it resets.
- **Credentials**: Claude and Codex sign-in, file uploads, enable/disable, cooldowns, per-credential traffic and bulk actions.
- **API providers & client keys**: structured editors instead of raw YAML.
- **Settings**: documented forms for routing, retries, networking and logging, plus a YAML editor with diff review.
- **Logs & playground**: live log tail, CPA process output, request and error logs, and a streaming chat tester.

## Quick start

Requires Node.js 22.13 or newer.

```sh
npx cliproxyui
```

The console prints a setup link (and opens it if it can). Open it and pick the proxy port. The management key is
pre-generated, so save it, then click **Start CLIProxyAPI**. CPA is already downloading in the background while you
fill in the form.

Clients then connect straight to CPA, e.g. `http://<server>:8317/v1`, using the client key shown on the Overview page.
For Claude Code, the Overview page has the commands ready to paste, with your address and key filled in.

### Keep it running

```sh
npx cliproxyui service install
```

This installs a background service that starts at boot: systemd on Linux (a user service, or a system service when
run as root) and launchd on macOS. It installs the latest nightly into the data directory, so it never depends on the
npx cache. `service status` and `service uninstall` do what you'd expect; uninstalling keeps your data.

### Updating

The console is a rolling nightly: every merge to `main` publishes a new build to npm under the default `latest` tag.
When a newer build exists, the console's sidebar shows **Update available** with the exact command, including any
`--data`, `--port` or `--host` options the console runs with. For a service, that re-runs `service install`, which
reinstalls the latest nightly and keeps your data. For a foreground run, stop the console and run the npx command
again; npx fetches the new build. CLIProxyAPI itself updates from the Overview page.

### Options

```
cliproxyui [start] [--port 8320] [--host 0.0.0.0] [--data ~/.cpa-console] [--no-open]
cliproxyui service install|uninstall|status [same options]
```

| Flag | Env | Default | |
| --- | --- | --- | --- |
| `--port` | `PORT` | `8320` | Console port |
| `--host` | `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a reverse proxy or SSH tunnel |
| `--data` | `CPA_CONSOLE_DATA` | `~/.cpa-console` | CPA binary, `config.yaml`, auth files, logs, usage database |
| | `TRUST_PROXY` | | Set to `1` behind a reverse proxy, so failed-login limits apply per client (from `X-Forwarded-For`) |
| | `USAGE_RETENTION_DAYS` | `90` | How long request history is kept |
| | `GITHUB_TOKEN` | | Optional; avoids GitHub API rate limits when checking for CPA releases |

## Security notes

- The setup link contains a one-time token. Until setup is done, anyone with the link can claim the instance, so
  finish setup right away.
- The console serves plain HTTP. To reach it over the internet, put it behind a TLS-terminating reverse proxy
  (Caddy, nginx), with `HOST=127.0.0.1` and `TRUST_PROXY=1`, or use an SSH tunnel.
- Five wrong keys from one address lock that address out for 15 minutes.
- The console checks the management key itself before forwarding anything to CPA. CPA's remote management stays
  disabled, because the console reaches it over localhost.

## Development

```sh
pnpm install          # also builds, via `prepare`
CPA_CONSOLE_DATA=/tmp/cpa-dev pnpm dev
```

`pnpm dev` runs the console server on `:8320` in watch mode and Vite on `:5173`. Open the Vite URL; the setup link
printed by the server works there too if you change its port to 5173.

Stack: Vite, React 19, TanStack Router / Query / Table, shadcn/ui (Radix, Tailwind v4) and Recharts; the server is
Hono on Node, with `node:sqlite` for usage history.

## License

MIT
