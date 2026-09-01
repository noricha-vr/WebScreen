# WebScreen MediaMTX relay

Install MediaMTX **v1.20.1** and copy the versioned configs to `/etc/webscreen/streaming` and the runtime scripts to one versioned release directory under `/opt/webscreen/streaming`. `relay.sh`, `verify-codecs.sh`, and `audio-profile.sh` are one release unit: place all three in the same directory and switch them together. Never replace only one of these files, because both scripts source `audio-profile.sh` by absolute path. The two services share `live/{12-character-id}` but run independently: ingress accepts WHIP and invokes one relay process per available path; egress serves anonymous RTSP on port 554 and accepts publish traffic only from loopback.

Create the unprivileged `webscreen` system user before enabling the units. Copy `Caddyfile` to `/etc/caddy/Caddyfile`; `/etc/caddy/mediamtx-api.env` remains root-readable and holds separate `MEDIAMTX_API_TOKEN` and `MEDIAMTX_EGRESS_API_TOKEN` values. Control API URLs and tokens are configured as Worker secrets (`MEDIAMTX_INGRESS_API_*` and `MEDIAMTX_EGRESS_API_*`). The legacy `MEDIAMTX_API_*` pair is used only when none of the four split URL/token settings is present; it is not an automatic runtime fallback after split is enabled. The egress unit receives only `CAP_NET_BIND_SERVICE`, which it needs to bind RTSP port 554.

Before starting either unit, run this preflight in the selected release directory:

```sh
release_dir=/opt/webscreen/streaming/RELEASE
test -r "$release_dir/relay.sh" && test -r "$release_dir/verify-codecs.sh" && test -r "$release_dir/audio-profile.sh"
/bin/sh -c '. "$1/audio-profile.sh"' sh "$release_dir"
shellcheck "$release_dir/relay.sh" "$release_dir/verify-codecs.sh" "$release_dir/audio-profile.sh"
```

If ShellCheck is unavailable, use `bash -n` for `relay.sh` and `verify-codecs.sh` and `/bin/sh -n` for `audio-profile.sh`. Do not start or restart a service unless every check succeeds.

The `0.2.0-beta` runtime candidate copies H.264 video and maps optional audio to MP3, 48 kHz stereo, 128 kbps. SIGINT/SIGTERM prevents any retry; ordinary failures retry at most three times. This is an A12 test candidate, not the current production profile: production remains H.264 + AAC until every A12 check passes.

After publishing to the candidate environment, run `./verify-codecs.sh rtspt://your-host/live/AbCdEf123456` from the same release directory. It requires H.264 + MP3 at 48 kHz stereo; during the video-only shadow stage, append `--video-only`. The script converts VRChat's `rtspt://` spelling to `rtsp://` for ffprobe and always probes over TCP. This candidate smoke check is intentionally outside Worker requests; the health API only observes MediaMTX path/byte counters.

## Candidate test, production promotion, and rollback

Do not use the candidate test as production cutover approval. Stage and test `0.2.0-beta` away from the production service while production continues to use AAC. Promote the MP3 profile only after A12 passes in full: PC and Quest audio listening, sub-second Quest playback, 30-minute stability, 24/30 fps comparison, capacity, and codec gate.

After A12 passes, the VPS must be ready before any Worker version containing the split settings is deployed.

1. Back up the current MediaMTX unit/config, Caddyfile, and token environment file to a timestamped directory.
2. Install the two configs, all three runtime scripts (`relay.sh`, `verify-codecs.sh`, and `audio-profile.sh`), and systemd units without enabling them. Run the preflight above, then validate Caddy and both MediaMTX configs.
3. Wait until the old service has no ready paths. Stop the old service, start ingress and egress, reload Caddy, and keep a shell rollback trap active for the whole cutover.
4. Verify both Control API routes with their own non-empty, mutually different tokens. Each same Control API probe must return HTTP 200 and the expected `X-WebScreen-MediaMTX-Role: ingress` or `egress` marker; also reject a wrong token, confirm WHIP HTTP is reachable, and run a video-only relay/codec smoke. Only then remove the rollback trap.
5. Push the Worker version. The deploy workflow checks the non-equal tokens plus both split Control API status/role markers before D1 migration or Worker deployment, so a VPS-first setup error stops safely.
6. Publish one browser stream and confirm ingress and egress bytes both increase. For audio, confirm H.264 + MP3 at 48 kHz stereo with `verify-codecs.sh`.

If a VPS check fails before the Worker deploy, stop the split units and restore the backed-up old unit/config/Caddyfile. If the Worker has already switched to split, roll back the Worker and VPS as one operation; `wrangler rollback` changes only Worker code and does not restore systemd, Caddy, or MediaMTX configuration.
