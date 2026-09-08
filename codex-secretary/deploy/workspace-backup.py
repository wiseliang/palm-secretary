#!/usr/bin/env python3
"""Offline, verified workspace backup; restore only into a new isolated directory."""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile
import tempfile

FORMAT = 1
MAX_BYTES = 20 * 1024**3


def check(condition, message):
    if not condition:
        raise ValueError(message)


def safe_name(name):
    p = PurePosixPath(name)
    check(bool(name) and not p.is_absolute() and all(x not in ('', '.', '..') for x in name.split('/'))
          and '\\' not in name and ':' not in name, 'Unsafe archive path')
    return p


def idle(workspace):
    state = json.loads((workspace / '.palm/state.json').read_text(encoding='utf-8'))
    check(isinstance(state.get('projects'), list) and isinstance(state.get('tasks'), list), 'Invalid workspace state')
    check(not any(t.get('status') == 'running' or t.get('submissionPending') for t in state['tasks']), 'Active or uncertain task: stop and reconcile before backup')


def inventory(roots):
    result = {}
    for label, root in roots.items():
        def visit(folder):
            for item in sorted(folder.iterdir()):
                name = label + '/' + item.relative_to(root).as_posix()
                safe_name(name)
                info = item.lstat()
                signature = [info.st_size, info.st_mtime_ns, info.st_ino, stat.S_IMODE(info.st_mode)]
                if stat.S_ISLNK(info.st_mode):
                    result[name] = {'kind': 'link', 'target': os.readlink(item), 'signature': signature}
                elif stat.S_ISDIR(info.st_mode):
                    result[name] = {'kind': 'directory', 'signature': signature}
                    visit(item)
                else:
                    check(stat.S_ISREG(info.st_mode), 'Unsupported special file: ' + name)
                    result[name] = {'kind': 'file', 'signature': signature}
        visit(root)
    return result


def digest(stream):
    result = hashlib.sha256()
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            return result.hexdigest()
        result.update(chunk)


def verify(archive):
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        names = [m.name for m in members]
        check(len(set(names)) == len(names), 'Duplicate archive entry')
        check(all(m.isfile() for m in members), 'Archive must contain regular files only')
        for name in names:
            safe_name(name)
        check(sum(m.size for m in members) <= MAX_BYTES, 'Archive exceeds restore limit')
        metadata = bundle.getmember('manifest.json')
        check(metadata.size <= 32 * 1024**2, 'Manifest exceeds limit')
        manifest = json.load(bundle.extractfile(metadata))
        check(manifest.get('format') == FORMAT, 'Unsupported backup format')
        roots = manifest.get('roots')
        check(isinstance(roots, dict) and 'workspace' in roots, 'Invalid roots')
        for label in roots:
            check('/' not in label, 'Invalid root name')
            safe_name(label)
        entries = manifest.get('entries')
        check(isinstance(entries, dict), 'Invalid manifest entries')
        files = set()
        for name, entry in entries.items():
            p = safe_name(name)
            check(len(p.parts) >= 2 and p.parts[0] in roots, 'Entry outside declared roots')
            check(entry.get('kind') in ('file', 'directory', 'link'), 'Invalid entry type')
            for parent in list(p.parents)[:-1]:
                if len(parent.parts) > 1:
                    check(entries.get(str(parent), {}).get('kind') == 'directory', 'Invalid parent')
            if entry['kind'] == 'file':
                member = bundle.getmember('data/' + name)
                check(member.size == entry.get('size'), 'File size mismatch')
                check(digest(bundle.extractfile(member)) == entry.get('sha256'), 'File checksum mismatch')
                files.add('data/' + name)
            elif entry['kind'] == 'link':
                check(isinstance(entry.get('target'), str), 'Invalid link definition')
        check(set(names) == files | {'manifest.json'}, 'Unlisted archive data')
    return manifest


def backup(workspace, archive, extras=None):
    workspace = workspace.resolve(strict=True)
    archive = archive.absolute()
    roots = {'workspace': workspace}
    for label, value in (extras or {}).items():
        safe_name(label)
        check('/' not in label and label not in roots, 'Duplicate or invalid root')
        roots[label] = Path(value).resolve(strict=True)
    check(not archive.exists(), 'Backup destination already exists')
    check(archive.parent.is_dir(), 'Create private backup directory first')
    parent = archive.parent.resolve(strict=True)
    check(all(parent != root and root not in parent.parents for root in roots.values()), 'Backup must be outside source roots')
    check(all(root.is_dir() for root in roots.values()), 'Backup roots must be directories')
    idle(workspace)
    before = inventory(roots)
    check(sum(e['signature'][0] for e in before.values() if e['kind'] == 'file') <= MAX_BYTES, 'Backup exceeds limit')
    manifest = {'format': FORMAT, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'roots': {k: str(v) for k, v in roots.items()}, 'entries': {}}
    fd, temporary = tempfile.mkstemp(prefix='.palm-backup-', dir=parent)
    os.close(fd)
    try:
        with tarfile.open(temporary, 'w:gz') as bundle:
            for name, entry in before.items():
                item = {k: v for k, v in entry.items() if k != 'signature'}
                item['mode'] = entry['signature'][3]
                if entry['kind'] == 'file':
                    parts = PurePosixPath(name).parts
                    source = roots[parts[0]].joinpath(*parts[1:])
                    check(source.resolve() == source, 'Source path changed to a link')
                    descriptor = os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                    with os.fdopen(descriptor, 'rb') as stream:
                        opened = os.fstat(stream.fileno())
                        check(stat.S_ISREG(opened.st_mode) and [opened.st_size, opened.st_mtime_ns, opened.st_ino, stat.S_IMODE(opened.st_mode)] == entry['signature'], 'Source changed before read')
                        item['sha256'] = digest(stream)
                        item['size'] = entry['signature'][0]
                        stream.seek(0)
                        member = tarfile.TarInfo('data/' + name)
                        member.size = item['size']; member.mode = 0o600
                        bundle.addfile(member, stream)
                manifest['entries'][name] = item
            payload = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
            member = tarfile.TarInfo('manifest.json'); member.size = len(payload); member.mode = 0o600
            bundle.addfile(member, io.BytesIO(payload))
        idle(workspace)
        check(inventory(roots) == before, 'Source changed during backup; no archive published')
        verify(temporary)
        # Atomic, exclusive publication on the same filesystem.
        with open(temporary, 'rb+') as source:
            os.fsync(source.fileno())
        os.link(temporary, archive)
    finally:
        Path(temporary).unlink(missing_ok=True)
    with archive.open('rb') as stream:
        checksum = digest(stream)
    return {'archiveSha256': checksum, **summary(manifest)}


def summary(manifest):
    return {kind + 's': sum(e['kind'] == kind for e in manifest['entries'].values()) for kind in ('file', 'directory', 'link')}


def restore(archive, destination):
    # No symlink from the backup is materialized, including links into production.
    manifest = verify(archive)
    destination = destination.absolute()
    check(not destination.exists() and not destination.is_symlink(), 'Restore destination must be new')
    destination.mkdir(mode=0o700)
    marker = destination / '.restore-incomplete'
    marker.write_text('Do not use until verification completes\n', encoding='utf-8')
    for label in manifest['roots']:
        (destination / label).mkdir(mode=0o700)
    with tarfile.open(archive, 'r:gz') as bundle:
        for name, entry in manifest['entries'].items():
            target = destination.joinpath(*PurePosixPath(name).parts)
            if entry['kind'] == 'link': continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if entry['kind'] == 'directory':
                target.mkdir(exist_ok=True, mode=0o700)
            else:
                with bundle.extractfile('data/' + name) as source, target.open('xb') as output:
                    os.chmod(target, 0o600)
                    copied = 0
                    while True:
                        chunk = source.read(min(1024 * 1024, entry['size'] - copied + 1))
                        if not chunk: break
                        copied += len(chunk)
                        check(copied <= entry['size'], 'Archive changed during restore')
                        output.write(chunk)
                    check(copied == entry['size'], 'Truncated restore data')
                with target.open('rb') as stream:
                    check(digest(stream) == entry['sha256'], 'Restored file checksum mismatch')
    (destination / 'restore-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    marker.unlink()
    return {**summary(manifest), 'linksCreated': 0, 'note': 'Link definitions retained in restore-manifest.json; review mappings and permissions before live recovery'}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('backup'); create.add_argument('workspace', type=Path); create.add_argument('archive', type=Path)
    create.add_argument('--extra-root', action='append', default=[], metavar='NAME=PATH')
    for command in ['verify', 'restore']:
        p = sub.add_parser(command); p.add_argument('archive', type=Path)
        if command == 'restore': p.add_argument('destination', type=Path)
    args = parser.parse_args()
    if args.command == 'backup':
        pairs = [value.split('=', 1) for value in args.extra_root]
        check(all(len(pair) == 2 for pair in pairs), 'Use NAME=PATH for extra roots')
        check(len({pair[0] for pair in pairs}) == len(pairs), 'Duplicate extra root')
        result = backup(args.workspace, args.archive, dict(pairs))
    elif args.command == 'verify': result = summary(verify(args.archive))
    else: result = restore(args.archive, args.destination)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
