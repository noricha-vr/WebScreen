# WebScreen MediaMTX relay

Install MediaMTX **v1.20.1** and copy these versioned files to `/etc/webscreen/streaming` and `/opt/webscreen/streaming`. The two services share `live/{12-character-id}` but run independently: ingress accepts WHIP and invokes one relay process per available path; egress serves anonymous RTSP on port 554 and accepts publish traffic only from loopback.

`mediamtx.env` is root-readable and is not committed. It provides `MTX_AUTH_JWT_JWKS`; control API URLs and tokens are configured as Worker secrets (`MEDIAMTX_INGRESS_API_*` and `MEDIAMTX_EGRESS_API_*`). The legacy `MEDIAMTX_API_*` pair remains a fallback for a single-server rollout.

Enable with `systemctl enable --now webscreen-mediamtx-ingress webscreen-mediamtx-egress`. The ingress hook receives `MTX_PATH`, rejects anything except `live/` plus a 12-character base62 ID, and owns only its direct ffmpeg child. It copies H.264 video and maps audio optionally to AAC-LC, 48 kHz stereo, 128 kbps. SIGINT/SIGTERM prevents any retry; ordinary failures retry at most three times.

After publishing a stream, run `./verify-codecs.sh rtspt://your-host/live/AbCdEf123456` from an operator host. This deploy smoke check is intentionally outside Worker requests; the health API only observes MediaMTX path/byte counters.
