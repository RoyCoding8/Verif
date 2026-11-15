#!/usr/bin/env python3
"""Verity launcher. Run the app and a few essential commands from a menu.

Stdlib only so the bash and batch wrappers drive the same entry point.
"""

import os
import shutil
import subprocess
import sys

# This launcher's repository. Commands run here, not in the caller's cwd.
ROOT = os.path.dirname(os.path.abspath(__file__))

# label -> argv. The app comes first because that is what this is for.
COMMANDS = (
    ('Run the app', ['npm', 'run', 'app']),
    ('Run the test suite', ['npm', 'test']),
    ('Demo fixture', ['npm', 'run', 'demo']),
    ('Desktop smoke (real window)', ['npm', 'run', 'smoke']),
)


def spawn(argv):
    resolved = shutil.which(argv[0])
    if resolved is None:
        return 127
    return subprocess.run([resolved] + argv[1:], cwd=ROOT).returncode


def read_key():
    if os.name == 'nt':
        import msvcrt
        return msvcrt.getwch()
    import termios
    import tty
    fd = sys.stdin.fileno()
    previous = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, previous)


def menu():
    while True:
        print()
        print('Verity')
        print()
        for i, (label, _) in enumerate(COMMANDS, 1):
            print(f'  [{i}] {label}')
        print()
        print('  [q] quit')
        print()
        print('select: ', end='', flush=True)
        key = read_key()
        print()
        if key in ('q', 'Q', '\x1b', '\x03'):
            return 0
        if key.isdigit() and 1 <= int(key) <= len(COMMANDS):
            label, argv = COMMANDS[int(key) - 1]
            print(f'running {label.lower()}')
            print(f'  $ {" ".join(argv)}')
            code = spawn(argv)
            return code
        print('pick a number or q')


def check():
    failed = 0
    for label, argv in COMMANDS:
        ok = bool(label) and bool(argv) and all(isinstance(a, str) for a in argv)
        print(f'VERDICT {label} {"PASS" if ok else "FAIL"}')
        failed += 0 if ok else 1
    # falsifying mutation: a command with no argv must be caught here
    broken = ('Broken', [])
    bad = not (bool(broken[1]) and all(isinstance(a, str) for a in broken[1]))
    print(f'VERDICT empty-argv-rejected {"PASS" if bad else "FAIL"}')
    failed += 0 if bad else 1
    return 1 if failed else 0


def main(argv):
    if '--check' in argv:
        return check()
    if '--list' in argv:
        for label, cmd in COMMANDS:
            print(f'{label}\t{" ".join(cmd)}')
        return 0
    return menu()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
