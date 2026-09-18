# Automation Service Installation and Recovery

## Safety boundary

The runner reports health, may execute deterministic synthetic recovery drills,
and may compile private application-material requests when explicitly enabled. It
does not navigate job sites, fill forms, or submit applications. The public repository contains no
credentials. The API binds the runner identity to one configured owner; only that
owner can manage delegation or read status.

## Install

Provision a clean Ubuntu 24.04 instance with 2 CPU, 4 GiB memory, swap disabled,
a 30 GiB root filesystem, persistent storage, and host-boot autostart. Attach it
to a dedicated managed NAT network that rejects the Kubernetes pod and service
CIDRs. Do not expose inbound ports; the runtime initiates only authenticated
outbound HTTPS and local stdio MCP connections.

Copy `packaging/bootstrap.sh` and
`packaging/versions.env` into one temporary directory on the instance, then run
the bootstrap as root with the exact deployed commit:

```sh
AUTOMATION_REVISION=<40-character-commit-sha> ./bootstrap.sh
```

The bootstrap installs the checksum-pinned Node.js runtime, clones only the exact
requested repository revision, and invokes `packaging/install.sh`. The installer
verifies the Node.js and Playwright pins, builds and tests the runtime, installs
the pinned Codex CLI and Chrome dependencies, creates the non-login
`job-hunter-automation` account, and installs the systemd unit. Re-running the
same revision is safe. Package installation skips npm's informational network
audit so a slow advisory endpoint cannot block deployment; lockfile security is
checked separately before release. Neither script enables or starts the service.

Populate `/etc/job-hunter-automation/runner.env` without printing values and keep
it owned by root with mode `0600`. Confirm names only:

```sh
sudo stat -c '%U %G %a %n' /etc/job-hunter-automation/runner.env
sudo sed -n 's/=.*//p' /etc/job-hunter-automation/runner.env
```

Complete one-time device authentication as the service account:

```sh
sudo -u job-hunter-automation env \
  CODEX_HOME=/var/lib/job-hunter-automation/codex \
  codex login --device-auth
sudo chmod 0700 /var/lib/job-hunter-automation/codex
sudo find /var/lib/job-hunter-automation/codex -type f -exec chmod 0600 {} +
```

To enable application-material compilation, install the private `cv-materials` package, copy the
immutable profile bundle to the protected materials directory, import that bundle through the
owner-only API endpoint, and set the `MATERIALS_*` variables from `runner.env.example`. Keep the
feature disabled if any bundle hash or profile version differs.

To enable recovery drills, first deploy the compatible API migration and contracts,
then set `WORKFLOW_WORKER_ENABLED=true` and a stable `WORKFLOW_WORKER_ID`. A service
restart starts one new runner generation, invalidates the old lease in PostgreSQL,
and resumes from the first incomplete checkpoint. Do not add a local queue or
workflow database to the instance.

Then start the service:

```sh
sudo systemctl enable --now job-hunter-automation.service
sudo systemctl --no-pager --full status job-hunter-automation.service
```

## Verify

Inspect bounded lifecycle messages and service state. Logs must not contain token,
cookie, URL, prompt, model text, or browser content:

```sh
sudo journalctl -u job-hunter-automation.service --since '-10 minutes' --no-pager
```

A launcher failure is one JSON line with the fixed `event`, `stage`, and `code`
fields and an optional HTTP `status`, for example
`{"event":"automation_launcher_failed","stage":"health","code":"AUTH_FAILED","status":401}`.
The stage is `config`, `health`, `materials`, or `workflow`; codes distinguish
authentication, network, upstream HTTP, configuration, and worker failures. The
line intentionally excludes exception messages, stacks, response bodies, command output, and
request data.

Use the owner-only Job Hunter Automation page to verify fresh LAUNCHER, API,
DATABASE, CHROME, PLAYWRIGHT, BROWSER_MCP, JOB_HUNTER_MCP, and CODEX components.
The first heartbeat runs preflight and canary; later heartbeats reuse snapshots until the
server-issued interval expires. With materials enabled, create a package from the owner UI and verify
that one immutable revision reaches `READY` or the explicit base-CV fallback state.
With the synthetic worker enabled, create a recovery run from the owner UI and
verify exactly three unique checkpoints before `SUCCEEDED`.

Verify network isolation from inside the instance: Kubernetes pod and service
CIDRs must be unreachable while the public Job Hunter health endpoint returns
HTTP 200. After the first successful install, perform both a service restart and
a full instance restart. The service must autostart, credentials and profile
permissions must remain unchanged, and all eight components must return to
`READY` without manual repair.

## Recover

For `AUTH_REQUIRED`, stop the service, repeat the device login without displaying
`auth.json`, and restart. For Chrome or Playwright failure, stop the service before
checking the dedicated profile; never open that profile with a second Chrome
process. For M2M authentication failure, rotate the environment file atomically
and restart.

```sh
sudo systemctl stop job-hunter-automation.service
sudo systemctl start job-hunter-automation.service
```

If recovery fails, leave the service stopped and preserve
`/var/lib/job-hunter-automation` for diagnosis. Do not delete the browser profile
or Codex authentication as part of routine rollback.
