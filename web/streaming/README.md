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

## Egress connection caps

`mediamtx-egress.yml` and `mediamtx-egress-replica.yml` cap each live path at 60 readers. `nftables-egress.nft` separately caps all new TCP 554 connections on one node at 505 while retaining `policy accept` for every other packet.

1. Save the current rules with `sudo nft list ruleset > /root/nftables-before-$(date +%F).txt`, and confirm they are empty because no other firewall manager is active.
2. Run `nft -c -f nftables-egress.nft` from the selected release, then install it at `/etc/webscreen/streaming/nftables-egress.nft`.
3. Ubuntu's standard `/etc/nftables.conf` contains `flush ruleset`; inspect that parent file before adding `include "/etc/webscreen/streaming/nftables-egress.nft"` and running `systemctl enable --now nftables`.
4. Confirm `nft list table inet webscreen_egress`; repeat it while refusing excess readers to see the rule counter increase.

To remove the cap, delete the include and run `nft delete table inet webscreen_egress`. Before reapplying an updated file, run that same delete command, then load the new file with `nft -f /etc/webscreen/streaming/nftables-egress.nft`.

This is bandwidth self-protection, not SYN flood protection: SYN-only connections also consume a slot.

## Candidate test, production promotion, and rollback

Do not use the candidate test as production cutover approval. Stage and test `0.2.0-beta` away from the production service while production continues to use AAC. The 30-minute stability, capacity, and codec gates have passed; promotion still requires controlled PC and Quest audio listening, sub-second Quest playback, and an actual-Mac 24/30 fps comparison.

An isolated Mac arm64 rehearsal also passed candidate MP3 shutdown and restoration to the pre-PR H.264 + AAC relay, including a 10-second `ffmpeg -xerror` decode. It did not exercise the production Indigo service, Worker, or product configuration.

For the browser-side recovery candidate, open the screen-share page with exactly one `stream-profile=mp3-beta` query value in Chrome. It requests the next keyframe every 500 ms; normal, unknown, and duplicate values keep the existing behavior. The request does not guarantee that a new reader's first packet is an IDR, because MediaMTX has no GOP cache. Unsupported browsers may ignore the optional `setParameters` argument and keep a no-op request loop. Do not expose an arbitrary interval in the URL.

After A12 passes, the VPS must be ready before any Worker version containing the split settings is deployed.

1. Back up the current MediaMTX unit/config, Caddyfile, and token environment file to a timestamped directory.
2. Install the two configs, all three runtime scripts (`relay.sh`, `verify-codecs.sh`, and `audio-profile.sh`), and systemd units without enabling them. Run the preflight above, then validate Caddy and both MediaMTX configs.
3. Wait until the old service has no ready paths. Stop the old service, start ingress and egress, reload Caddy, and keep a shell rollback trap active for the whole cutover.
4. Verify both Control API routes with their own non-empty, mutually different tokens. Each same Control API probe must return HTTP 200 and the expected `X-WebScreen-MediaMTX-Role: ingress` or `egress` marker; also reject a wrong token, confirm WHIP HTTP is reachable, and run a video-only relay/codec smoke. Only then remove the rollback trap.
5. Push the Worker version. The deploy workflow checks the non-equal tokens plus both split Control API status/role markers before D1 migration or Worker deployment, so a VPS-first setup error stops safely.
6. Publish one browser stream and confirm ingress and egress bytes both increase. For audio, confirm H.264 + MP3 at 48 kHz stereo with `verify-codecs.sh`.

If a VPS check fails before the Worker deploy, stop the split units and restore the backed-up old unit/config/Caddyfile. If the Worker has already switched to split, roll back the Worker and VPS as one operation; `wrangler rollback` changes only Worker code and does not restore systemd, Caddy, or MediaMTX configuration.

## Read replica node (delta from an origin node)

Use `Caddyfile.node` instead of `Caddyfile` on every node other than the Indigo origin. It serves one node-specific host taken from `WEBSCREEN_NODE_HOST` (add `WEBSCREEN_NODE_HOST=chi1.web-screen.net` to `/etc/caddy/mediamtx-api.env`, which caddy.service reads through a systemd drop-in `EnvironmentFile=`). The host must resolve to this node only (never `webscreen.tv`, which resolves to every read node), so the cron worker can count readers per node and ACME challenges always reach the right machine. Public hostnames stay a single `webscreen.tv` for VRChat (see `docs/streaming/operations.md`, "ホスト名の役割").

If the node also carries `mediamtx-ingress.yml` (so it can become origin), set `webrtcAdditionalHosts` to this node's public IP and open UDP 8189; `Caddyfile.node` already routes `/live/*/whip*` to the local ingress.

A read replica serves the same `rtsp://host/live/{id}` paths without running ingress or a relay hook. MediaMTX pulls each stream itself through its native RTSP `source` (`sourceOnDemand`), so there is no helper script and no environment file. The origin is whatever `stream.web-screen.net` resolves to: exactly one host, with no ordered fallback list. Moving the origin is a DNS change, not a per-replica config change. The pull opens when the first reader arrives (`sourceOnDemandStartTimeout: 10s`) and closes 10 seconds after the last reader leaves; if the origin has no such path, the reader receives an error instead of a silent retry loop.

**A path that has a `source` never accepts a publisher**, so one node cannot be origin and replica for the same path regexp. Never install this config on a node that runs ingress + relay — that node keeps `mediamtx-egress.yml`.

Install differences from an origin node:

- Configs in `/etc/webscreen/streaming/`: **`mediamtx-egress-replica.yml`** (in place of `mediamtx-egress.yml`); do **not** install `mediamtx-ingress.yml`.
- Runtime scripts in `/opt/webscreen/streaming/RELEASE/`: none are needed for the pull (`relay.sh` is not used); `audio-profile.sh` and `verify-codecs.sh` remain useful for smoke checks.
- Systemd units: enable only **`webscreen-mediamtx-egress-replica.service`**. Do not enable the ingress unit or the original egress unit.
- Publicly open ports on a replica: `22/tcp`, `80/tcp`, `443/tcp` (for the Caddy fronted Control API used by the cron worker), and `554/tcp` (RTSP readers). WHIP (`8189`) is not needed because ingress is not installed.

Local smoke check (two MediaMTX processes on one machine):

```sh
# 1) start an origin MediaMTX on :8554 (mediamtx-egress.yml with rtspAddress/apiAddress moved off
#    the production ports) and publish a test stream to it
# 2) point a copy of the replica config at that origin and give it its own ports
sed -e 's#stream\.web-screen\.net:554#127.0.0.1:8554#' \
    -e 's#^rtspAddress: :554$#rtspAddress: :8555#' \
    -e 's#^apiAddress: 127\.0\.0\.1:9998$#apiAddress: 127.0.0.1:9991#' \
    mediamtx-egress-replica.yml > /tmp/replica-smoke.yml
mediamtx /tmp/replica-smoke.yml
# 3) read through the replica: the pull starts on demand
ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name \
  -of default=noprint_wrappers=1 rtsp://127.0.0.1:8555/live/AbCdEf123456
# 4) stop the reader and confirm the replica drops the origin connection within 10 seconds.
```
