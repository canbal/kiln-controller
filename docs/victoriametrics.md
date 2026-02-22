# VictoriaMetrics (TSDB) Setup

This controller can write time-series samples to VictoriaMetrics (`vmsingle`).
Samples are stored independently of sessions. Sessions remain metadata only.

## Install (Raspberry Pi OS, armhf)

```bash
sudo apt update
sudo apt install snapd
sudo reboot
sudo snap install snapd
sudo snap install victoriametrics
```

## Configure (Memory / Retention)

Create or update the snap config file, then restart:

```bash
echo 'FLAGS="-memory.allowedBytes=192MiB -search.maxMemoryPerQuery=24MiB -search.maxConcurrentRequests=2 -search.maxQueueDuration=30s -retentionPeriod=30d"' | sudo tee /var/snap/victoriametrics/current/extra_flags
sudo snap restart victoriametrics
```

## Data Location

Snap-managed data directory:

```
/var/snap/victoriametrics/current/var/lib/victoriametrics/
```

## Remove Completely

```bash
sudo snap stop victoriametrics
sudo snap remove victoriametrics
sudo rm -rf /var/snap/victoriametrics/
```

## Controller Config

Edit `config.py`:

- `tsdb_enabled = True`
- `tsdb_url = "http://localhost:8428"`
- `tsdb_threshold_temp = 150`
- `tsdb_sample_interval_sec = 1`
- `tsdb_max_points_default = 2000`

## API

Samples can be queried from:

```
GET /v1/samples?from=<unix_seconds>&to=<unix_seconds>&max_points=<n>
```

This returns:

```json
{
  "success": true,
  "samples": [
    {"t": 1700000000, "temp": 1234.5, "target": 1200, "power_percent": 40}
  ]
}
```
