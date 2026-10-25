# The production database backup mechanism

These three files are what creates `agrent`'s only backup. They are tracked
here because **they were not**, and that is a defect with a name: #2319 found
that a clean clone could not deploy, because `docker-compose.vm.yml` mounted a
script the repo did not have — satisfied in production by an untracked copy
somebody had placed on the VM. The same shape was reproduced here within hours
of standing the backup up: the script, the unit and the timer existed **only**
at `/usr/local/sbin` and `/etc/systemd/system` on one machine.

If that machine is lost, the backups in GCS survive and the thing that creates
them does not.

| file | installed to | mode |
| --- | --- | --- |
| `agrent-db-backup` | `/usr/local/sbin/agrent-db-backup` | `0755 root:root` |
| `agrent-db-backup.service` | `/etc/systemd/system/agrent-db-backup.service` | `0644 root:root` |
| `agrent-db-backup.timer` | `/etc/systemd/system/agrent-db-backup.timer` | `0644 root:root` |

`deploy/check-drift.sh` hashes all three against the live copies, so the
tracked version and the running version cannot diverge silently — the failure
the Dockerfile pair in that script was added for, where the VM sat three months
behind the repo with the check green.

## What is NOT here, deliberately

The service-account key at `/etc/agrent-db-backup/sa-key.json` (0600 root:root).
This repository is **public**. The key is created with
`gcloud iam service-accounts keys create` and installed file-to-file; its
contents are never printed. It grants `objectCreator` + `objectViewer` on one
bucket and nothing at project level, so it can add and read but **cannot delete
or overwrite** — a compromised VM cannot destroy the backup history.

## Installing or reinstalling

```bash
sudo install -m 0755 -o root -g root deploy/backup/agrent-db-backup /usr/local/sbin/
sudo install -m 0644 -o root -g root \
  deploy/backup/agrent-db-backup.service \
  deploy/backup/agrent-db-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agrent-db-backup.timer
```

Then prove it rather than assume it — the run is idempotent and writes a new
timestamped object:

```bash
sudo /usr/local/sbin/agrent-db-backup
```

See `docs/backup-restore.md` for the restore procedure and the drill.
