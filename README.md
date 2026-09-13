# Job Hunter Automation

Node.js runner for the bounded automation contract in [Job Hunter](https://github.com/mshykhov/job-hunter). The API remains the source of truth for leases, checkpoints, and audit state; this process holds no workflow database.

The included synthetic worker demonstrates lease claim, heartbeat, checkpoint, and restart recovery without browsing job sites or submitting applications. Browser-related adapters require separately provisioned credentials and a profile, so this repository is not a standalone application.

## Verify

Requires Node.js 24.

```sh
npm ci
npm run verify
```

## Build and run

The runner must be configured against a compatible Job Hunter API before it can
start. Follow the [runtime configuration](docs/reference/runtime-configuration.md)
reference for the required API, machine-identity, browser-profile, and Codex
variables, then use the [service runbook](docs/runbooks/automation-service.md)
for installation and recovery.

```sh
npm run build
node dist/launcher.js
```

The production runbook installs this command as a systemd service. Do not commit
credentials, browser state, or generated application materials.

See the [documentation map](docs/README.md) for architecture, runbooks, and
reference material.

## License

[MIT](LICENSE)
