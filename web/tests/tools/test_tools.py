import argparse
import importlib.util
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


control = module('windows-player-control')
video = module('video-check')


class WindowsTests(unittest.TestCase):
    def test_host_required_and_invalid_before_connection(self):
        for host in ['', '-evil', 'host name', 'host\n', 'x;id', 'x:22', '$(id)', '`id`']:
            with self.subTest(host=host), patch.dict(os.environ, {'VRCHAT_SSH_HOST': host}), patch.object(control.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    control.powershell('Get-Date')
                run.assert_not_called()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                control.ssh_host()

    def test_ssh_and_scp_share_host_and_cleanup(self):
        for failed in [False, True]:
            with self.subTest(failed=failed), patch.dict(os.environ, {'VRCHAT_SSH_HOST': 'test-windows'}), tempfile.TemporaryDirectory() as tmp:
                replies = [r'C:\Temp\WebScreenControl-test', '', '{"ok":true}', '']
                with patch.object(control, 'powershell', side_effect=replies) as ps, patch.object(control.subprocess, 'run') as run:
                    if failed:
                        run.side_effect = subprocess.CalledProcessError(1, ['scp'])
                    args = argparse.Namespace(command='snapshot', out=str(Path(tmp) / 'screen.png'))
                    if failed:
                        with self.assertRaises(subprocess.CalledProcessError):
                            control.run_interactive(args)
                    else:
                        control.run_interactive(args)
                    self.assertEqual(control.ssh_command()[-1], 'test-windows')
                    for call in run.call_args_list:
                        command = call.args[0]
                        self.assertEqual(command[0], 'scp')
                        self.assertTrue(any(arg.startswith('test-windows:C:/Temp/') for arg in command))
                    cleanup = ps.call_args_list[-1].args[0]
                    self.assertIn('Stop-ScheduledTask', cleanup)
                    self.assertIn('Unregister-ScheduledTask', cleanup)
                    self.assertIn('Remove-Item -LiteralPath', cleanup)

    def test_url_validation(self):
        valid = 'https://cdn.web-screen.net/movies/Ab12Cd34Ef56.mp4'
        self.assertEqual(control.parse_args(['paste-url', valid]).url, valid)
        for url in [valid + '?x=1', valid.replace('https:', 'http:'), valid.replace('cdn.web-screen.net', 'evil.test'), '$(touch /tmp/no)', '-evil']:
            with self.subTest(url=url), patch('sys.stderr'):
                with self.assertRaises(SystemExit):
                    control.parse_args(['paste-url', '--', url])

    def test_make_passes_literal_arguments(self):
        repo = ROOT.parent
        with tempfile.TemporaryDirectory() as tmp:
            stub = Path(tmp) / 'python3'
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            stub.chmod(0o755)
            value = 'space $(echo injected) `echo injected` ; file.mp4'
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ['PATH'])
            result = subprocess.run(['make', '-s', 'video-check', 'FILE=' + value], cwd=repo, env=env, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.splitlines()[-1], value)

    def test_e2e_filter_arguments_and_port(self):
        with tempfile.TemporaryDirectory() as tmp:
            stub = Path(tmp) / 'bunx'
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "$E2E_PORT" "$@"\n')
            stub.chmod(0o755)
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ['PATH'])
            result = subprocess.run(['make', '-s', 'e2e', 'FILE=top.spec.ts', 'GREP=画像.*MP4', 'E2E_PORT=4332'],
                                    cwd=ROOT.parent, env=env, capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.splitlines(), ['4332', 'playwright', 'test', 'top.spec.ts', '--grep', '画像.*MP4'])


class VideoTests(unittest.TestCase):
    def probe(self):
        return {'streams': [{'codec_name': 'h264', 'profile': 'Constrained Baseline', 'pix_fmt': 'yuv420p', 'has_b_frames': 0}],
                'frames': [{'key_frame': 1, 'pict_type': 'I'}]}

    def test_faststart_and_frames(self):
        good = [('ftyp', 0), ('moov', 8), ('mdat', 16)]
        video.validate(good, self.probe())
        for boxes in [[('ftyp', 0), ('mdat', 8), ('moov', 16)], [('ftyp', 0)], []]:
            with self.assertRaises(ValueError):
                video.validate(boxes, self.probe())
        for frames in [[], [{'key_frame': 0, 'pict_type': 'P'}], [{'key_frame': 0, 'pict_type': 'I'}]]:
            with self.assertRaises(ValueError):
                video.validate(good, dict(self.probe(), frames=frames))
        for key, value in [('codec_name', 'hevc'), ('profile', 'High'), ('pix_fmt', 'yuv444p'), ('has_b_frames', 1)]:
            probe = self.probe()
            probe['streams'][0][key] = value
            with self.assertRaises(ValueError):
                video.validate(good, probe)

    def test_box_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'test.mp4'
            path.write_bytes(struct.pack('>I4s', 8, b'ftyp') + struct.pack('>I4sQ', 1, b'moov', 16) + struct.pack('>I4s', 0, b'mdat'))
            self.assertEqual(video.mp4_boxes(path), [('ftyp', 0), ('moov', 8), ('mdat', 24)])
            for data in [b'123', struct.pack('>I4s', 4, b'ftyp'), struct.pack('>I4s', 500, b'ftyp'), struct.pack('>I4s', 1, b'moov')]:
                path.write_bytes(data)
                with self.assertRaises(ValueError):
                    video.mp4_boxes(path)


if __name__ == '__main__':
    unittest.main()
