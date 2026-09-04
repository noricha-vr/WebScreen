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

1. Run `nft -c -f nftables-egress.nft` from the selected release, then install it at `/etc/webscreen/streaming/nftables-egress.nft`.
2. Add `include "/etc/webscreen/streaming/nftables-egress.nft"` once to `/etc/nftables.conf`, then run `systemctl enable --now nftables`.
3. Confirm `nft list table inet webscreen_egress`; repeat it while refusing excess readers to see the rule counter increase.

To remove the cap, delete the include and run `nft delete table inet webscreen_egress`. Before reapplying an updated file, run that same delete command, then load the new file with `nft -f /etc/webscreen/streaming/nftables-egress.nft`.

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

A read replica serves the same `rtsp://host/live/{id}` paths without running ingress or the relay hook. When a reader hits a path that has no publisher, MediaMTX invokes `replica-pull.sh`, which walks an ordered `ORIGINS` list and pulls one stream with `ffmpeg -c copy` from that origin's egress (`:554`, TCP). If every origin fails the pull exits non-zero and MediaMTX surfaces the failure to the reader (no silent restart).

Install differences from an origin node:

- Configs in `/etc/webscreen/streaming/`: **`mediamtx-egress-replica.yml`** (in place of `mediamtx-egress.yml`); do **not** install `mediamtx-ingress.yml`.
- Runtime scripts in `/opt/webscreen/streaming/RELEASE/`: **`replica-pull.sh`** in place of `relay.sh`; `audio-profile.sh` and `verify-codecs.sh` are still useful for smoke checks but not sourced by `replica-pull.sh`.
- Systemd units: enable only **`webscreen-mediamtx-egress-replica.service`**. Do not enable the ingress unit or the original egress unit.
- Environment file `/etc/webscreen/streaming/replica.env` (root-owned, group `webscreen`, mode `0640`):

  ```sh
  # Ordered comma-separated `host` or `host:port` entries (default port 554).
  # The list is walked top-to-bottom on every pull attempt.
  ORIGINS="origin-a.example,origin-b.example"
  # Optional: hostnames this replica answers to. If any ORIGINS host matches
  # (case-insensitive, port ignored), the pull is refused (self-loop guard).
  # Hostnames or IPv4 only; IPv6 literals are rejected with exit 64.
  SELF_HOSTS="replica-1.example"
  # Optional tuning (unsigned integers; anything else exits 64):
  # REPLICA_SUSTAINED_PULL_SECONDS=5 REPLICA_MAX_RETRIES=3 REPLICA_BASE_BACKOFF_SECONDS=1
  # RTSP_PORT is injected by MediaMTX (local egress port the pull publishes to; default 554).
  ```

- Do **not** include this node's own hostname in `ORIGINS`. The self-loop guard exits `64` if you do, but keep the config correct on the writing side.
- Publicly open ports on a replica: `22/tcp`, `80/tcp`, `443/tcp` (for the Caddy fronted Control API used by the cron worker), and `554/tcp` (RTSP readers). WHIP (`8189`) is not needed because ingress is not installed.
- The runtime preflight from the origin section still applies to `replica-pull.sh`:

  ```sh
  release_dir=/opt/webscreen/streaming/RELEASE
  test -r "$release_dir/replica-pull.sh"
  shellcheck "$release_dir/replica-pull.sh" || bash -n "$release_dir/replica-pull.sh"
  ```

Local smoke check (two MediaMTX processes on one machine):

```sh
# 1) start an origin egress (mediamtx-egress.yml) on :554 and publish a test stream to it
# 2) start a replica egress (mediamtx-egress-replica.yml) on an alternate port with
#    ORIGINS=127.0.0.1:554 and observe:
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:{replica-port}/live/AbCdEf123456
# 3) stop the reader and confirm the pull process (replica-pull.sh + child ffmpeg) exits.
```
