# WebScreen MediaMTX relay

Install MediaMTX **v1.20.1** and copy these versioned files to `/etc/webscreen/streaming` and `/opt/webscreen/streaming`. The two services share `live/{12-character-id}` but run independently: ingress accepts WHIP and invokes one relay process per available path; egress serves anonymous RTSP on port 554 and accepts publish traffic only from loopback.

Create the unprivileged `webscreen` system user before enabling the units. Copy `Caddyfile` to `/etc/caddy/Caddyfile`; `/etc/caddy/mediamtx-api.env` remains root-readable and holds separate `MEDIAMTX_API_TOKEN` and `MEDIAMTX_EGRESS_API_TOKEN` values. Control API URLs and tokens are configured as Worker secrets (`MEDIAMTX_INGRESS_API_*` and `MEDIAMTX_EGRESS_API_*`). The legacy `MEDIAMTX_API_*` pair remains a fallback for a single-server rollout. The egress unit receives only `CAP_NET_BIND_SERVICE`, which it needs to bind RTSP port 554.

Enable with `systemctl enable --now webscreen-mediamtx-ingress webscreen-mediamtx-egress`. The ingress hook receives `MTX_PATH`, rejects anything except `live/` plus a 12-character base62 ID, and owns only its direct ffmpeg child. It copies H.264 video and maps audio optionally to AAC-LC, 48 kHz stereo, 128 kbps. SIGINT/SIGTERM prevents any retry; ordinary failures retry at most three times.

After publishing a stream, run `./verify-codecs.sh rtspt://your-host/live/AbCdEf123456` from an operator host. During the video-only shadow stage, append `--video-only`. The script converts VRChat's `rtspt://` spelling to `rtsp://` for ffprobe and always probes over TCP. This deploy smoke check is intentionally outside Worker requests; the health API only observes MediaMTX path/byte counters.
