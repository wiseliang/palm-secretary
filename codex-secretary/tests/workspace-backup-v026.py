import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backup', Path(__file__).parents[1] / 'deploy/workspace-backup.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='palm-backup-test-')
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        (self.work / '.palm').mkdir(parents=True)
        (self.work / 'projects/p/outbox').mkdir(parents=True)
        self.state = self.work / '.palm/state.json'
        self.state.write_text(json.dumps({'version': 8, 'projects': [{'id': 'p'}], 'tasks': []}))
        (self.work / 'projects/p/outbox/result.txt').write_text('result\n', encoding='utf-8')
        self.archive = self.root / 'backup.tar.gz'

    def tearDown(self):
        self.temp.cleanup()

    def test_roundtrip_and_extra_root(self):
        extra = self.root / 'extra'; extra.mkdir()
        (extra / 'note.md').write_text('linked project', encoding='utf-8')
        result = ops.backup(self.work, self.archive, {'vault': str(extra)})
        self.assertEqual(result['files'], 3)
        target = self.root / 'restore'
        ops.restore(self.archive, target)
        self.assertEqual((target / 'workspace/projects/p/outbox/result.txt').read_text(), 'result\n')
        self.assertEqual((target / 'vault/note.md').read_text(), 'linked project')
        self.assertEqual((target / 'workspace/.palm/state.json').read_bytes(), self.state.read_bytes())
        self.assertFalse((target / '.restore-incomplete').exists())
        with self.assertRaises(ValueError): ops.restore(self.archive, target)
        with self.assertRaises(ValueError): ops.backup(self.work, self.archive)

    def test_refuses_active_and_uncertain(self):
        for task in [{'status': 'running'}, {'status': 'interrupted', 'submissionPending': True}]:
            self.state.write_text(json.dumps({'projects': [], 'tasks': [task]}))
            with self.assertRaises(ValueError): ops.backup(self.work, self.archive)
            self.assertFalse(self.archive.exists())

    def test_source_changes_not_published(self):
        original = ops.inventory
        calls = 0
        def changing(roots):
            nonlocal calls
            calls += 1
            result = original(roots)
            if calls == 2: result.pop(next(iter(result)))
            return result
        with patch.object(ops, 'inventory', changing):
            with self.assertRaises(ValueError): ops.backup(self.work, self.archive)
        self.assertFalse(self.archive.exists())
        self.assertEqual(list(self.root.glob('.palm-backup-*')), [])

    def test_output_must_be_outside_source(self):
        with self.assertRaises(ValueError): ops.backup(self.work, self.work / 'backup.tar.gz')

    def test_links_are_recorded_never_followed(self):
        secret = self.root / 'outside.txt'; secret.write_text('not in backup')
        link = self.work / 'outside-link'
        try: link.symlink_to(secret)
        except OSError: self.skipTest('Symlink privilege unavailable')
        result = ops.backup(self.work, self.archive)
        self.assertEqual(result['links'], 1)
        manifest = ops.verify(self.archive)
        self.assertEqual(Path(manifest['entries']['workspace/outside-link']['target']).resolve(), secret.resolve())
        target = self.root / 'restore'; ops.restore(self.archive, target)
        self.assertFalse((target / 'workspace/outside-link').exists())
        self.assertEqual(secret.read_text(), 'not in backup')

    def test_corrupt_traversal_duplicate_and_unlisted(self):
        ops.backup(self.work, self.archive)
        with tarfile.open(self.archive) as bundle:
            original = [(m.name, bundle.extractfile(m).read()) for m in bundle.getmembers()]
        cases = [original + [('../escape', b'bad')], original + [original[0]], original + [('unlisted', b'bad')],
                 [(name, b'bad' if name.startswith('data/') else payload) for name, payload in original]]
        for i, members in enumerate(cases):
            bad = self.root / ('bad-' + str(i) + '.tar.gz')
            with tarfile.open(bad, 'w:gz') as bundle:
                for name, payload in members:
                    member = tarfile.TarInfo(name); member.size = len(payload)
                    bundle.addfile(member, io.BytesIO(payload))
            target = self.root / ('target-' + str(i))
            with self.assertRaises((ValueError, KeyError)): ops.restore(bad, target)
            self.assertFalse(target.exists())
        self.assertFalse((self.root / 'escape').exists())


if __name__ == '__main__':
    unittest.main()
