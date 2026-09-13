#!/usr/bin/env python3
"""MP4 の faststart と WebScreen のエンコード契約を検査する。"""
import argparse
import json
from pathlib import Path
import struct
import subprocess


def mp4_boxes(path):
    boxes = []
    with Path(path).open('rb') as source:
        total = source.seek(0, 2)
        offset = 0
        while offset < total:
            source.seek(offset)
            header = source.read(8)
            if len(header) != 8:
                raise ValueError('MP4 ボックスヘッダーが不完全です')
            size, kind = struct.unpack('>I4s', header)
            minimum = 8
            if size == 1:
                extended = source.read(8)
                if len(extended) != 8:
                    raise ValueError('MP4 拡張サイズが不完全です')
                size = struct.unpack('>Q', extended)[0]
                minimum = 16
            elif size == 0:
                size = total - offset
            if size < minimum or offset + size > total:
                raise ValueError('MP4 ボックスサイズが不正です')
            boxes.append((kind.decode('ascii'), offset))
            offset += size
    return boxes


def validate(boxes, probe):
    kinds = [kind for kind, _ in boxes]
    if not kinds or kinds[0] != 'ftyp' or kinds.count('moov') != 1 or 'mdat' not in kinds:
        raise ValueError('ftyp / moov / mdat を持つ MP4 が必要です')
    if 'moof' in kinds or kinds.index('moov') > kinds.index('mdat'):
        raise ValueError('faststart が必要です: moov は mdat より前に配置してください')
    streams = probe.get('streams', [])
    if len(streams) != 1:
        raise ValueError('映像ストリームは 1 本必要です')
    stream = streams[0]
    if (stream.get('codec_name') != 'h264' or stream.get('profile') not in ('Baseline', 'Constrained Baseline')
            or stream.get('pix_fmt') != 'yuv420p' or stream.get('has_b_frames') != 0):
        raise ValueError('H.264 baseline / yuv420p / B フレームなしが必要です')
    frames = probe.get('frames', [])
    if not frames or any(f.get('key_frame') != 1 or f.get('pict_type') != 'I' for f in frames):
        raise ValueError('全フレームが I キーフレームである必要があります')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    args = parser.parse_args()
    try:
        path = args.file.resolve(strict=True)
        boxes = mp4_boxes(path)
        result = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v',
                                 '-show_entries', 'stream=codec_name,profile,pix_fmt,has_b_frames:frame=key_frame,pict_type',
                                 '-of', 'json', str(path)], capture_output=True, text=True, check=True, timeout=120)
        probe = json.loads(result.stdout)
        validate(boxes, probe)
        print(json.dumps({'ok': True, 'boxes': boxes, 'streams': probe['streams'],
                          'frames': len(probe['frames'])}, ensure_ascii=False, indent=2))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f'動画検査失敗: {error}\n')


if __name__ == '__main__':
    main()
