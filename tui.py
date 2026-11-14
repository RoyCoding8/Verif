#!/usr/bin/env python3
"""Verity terminal front end.

Local commands run on this machine. Heavy verification is dispatched to GitHub
Actions so it runs on GitHub's runners rather than the local CPU.

Stdlib only on purpose: `import curses` is unavailable on this host's Python and
both a bash and a batch wrapper must drive the same entry point.
"""

from __future__ import annotations

import ast
import glob
import json
import os
import shutil
import subprocess
import sys

KIND_LOCAL = 'local'
KIND_CI = 'ci'

REQUIRED_IDS = (
    'test-local', 'test-ci', 'lean-judge', 'kani-judge', 'refinement',
    'promotion', 'live-eval', 'ci-status', 'demo', 'smoke',
)

COMMAND_KEYS = ('id', 'label', 'kind', 'argv', 'needs', 'runs_on')

RUN_IDLE = 'idle'
RUN_RUNNING = 'running'
RUN_OK = 'ok'
RUN_FAILED = 'failed'
RUN_UNAVAILABLE = 'unavailable'

# The registry is the only source of menu entries and dispatch behaviour.
# Adding an action is appending one row; no branch in the dispatch path knows
# any specific id.
COMMANDS = (
    {'id': 'test-local', 'label': 'Run the test suite', 'kind': KIND_LOCAL,
     'argv': ['node', '--test', 'test/*.test.mjs'], 'needs': ['node'],
     'runs_on': 'this machine'},
    {'id': 'test-ci', 'label': 'Full verify on the CI matrix', 'kind': KIND_CI,
     'argv': ['gh', 'workflow', 'run', 'verify.yml'], 'needs': ['gh'],
     'runs_on': 'GitHub runners'},
    {'id': 'lean-judge', 'label': 'Lean proof judge', 'kind': KIND_CI,
     'argv': ['gh', 'workflow', 'run', 'lean-judge.yml'], 'needs': ['gh'],
     'runs_on': 'GitHub runners'},
    {'id': 'kani-judge', 'label': 'Kani model judge', 'kind': KIND_CI,
     'argv': ['gh', 'workflow', 'run', 'kani-judge.yml'], 'needs': ['gh'],
     'runs_on': 'GitHub runners'},
    {'id': 'refinement', 'label': 'Refinement witnesses', 'kind': KIND_CI,
     'argv': ['gh', 'workflow', 'run', 'refinement-proof.yml'], 'needs': ['gh'],
     'runs_on': 'GitHub runners'},
    {'id': 'promotion', 'label': 'Promotion model', 'kind': KIND_CI,
     'argv': ['gh', 'workflow', 'run', 'promotion.yml'], 'needs': ['gh'],
     'runs_on': 'GitHub runners'},
    {'id': 'live-eval', 'label': 'Live matched-trial evaluation', 'kind': KIND_CI,
     'argv': ['gh', 'workflow', 'run', 'reservation-evaluation.yml'],
     'needs': ['gh'], 'runs_on': 'GitHub runners'},
    {'id': 'ci-status', 'label': 'Recent CI runs', 'kind': KIND_CI,
     'argv': ['gh', 'run', 'list', '--limit', '10'], 'needs': ['gh'],
     'runs_on': 'GitHub runners'},
    {'id': 'demo', 'label': 'Demo fixture', 'kind': KIND_LOCAL,
     'argv': ['npm', 'run', 'demo'], 'needs': ['npm'], 'runs_on': 'this machine'},
    {'id': 'smoke', 'label': 'Desktop smoke (real window)', 'kind': KIND_LOCAL,
     'argv': ['npm', 'run', 'smoke'], 'needs': ['npm'], 'runs_on': 'this machine'},
)


# ---------- registry validators ----------

def validate_shape(rows):
    """Return one message per malformed row. Empty list means well formed."""
    errors = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append(f'row {index} is not a mapping')
            continue
        for key in COMMAND_KEYS:
            if key not in row:
                errors.append(f'row {index} missing key {key!r}')
        if 'id' in row and not isinstance(row['id'], str):
            errors.append(f'row {index} id is not a string')
        elif 'id' in row and row['id']:
            import re
            if not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', row['id']):
                errors.append(f'row {index} id {row["id"]!r} is not kebab-case')
        if 'kind' in row and row['kind'] not in (KIND_LOCAL, KIND_CI):
            errors.append(f'row {index} kind {row["kind"]!r} is not allowed')
        if 'argv' in row:
            if not isinstance(row['argv'], list) or not row['argv'] \
                    or not all(isinstance(a, str) for a in row['argv']):
                errors.append(f'row {index} argv must be a non-empty list of strings')
        if 'needs' in row and (not isinstance(row['needs'], list)
                               or not all(isinstance(n, str) for n in row['needs'])):
            errors.append(f'row {index} needs must be a list of strings')
    return errors


def validate_unique_ids(rows):
    """Return one message per duplicate id. Empty list means unique."""
    seen = set()
    errors = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_id = row.get('id')
        if row_id in seen:
            errors.append(f'duplicate id {row_id!r}')
        seen.add(row_id)
    return errors


def validate_required_rows(rows):
    """Return one message per missing required id."""
    present = {row.get('id') for row in rows if isinstance(row, dict)}
    return [f'missing required id {rid!r}' for rid in REQUIRED_IDS if rid not in present]


# ---------- execution ----------

def expand_argv(argv):
    """Expand a literal glob argument without going through a shell.

    Windows cmd does not expand globs, so the registry keeps the pattern as one
    argv element and this runner grows it.
    """
    expanded = []
    for arg in argv:
        if any(ch in arg for ch in '*?[') and glob.glob(arg):
            expanded.extend(sorted(glob.glob(arg)))
        else:
            expanded.append(arg)
    return expanded


def spawn(argv):
    """Run a command with inherited stdio. The only subprocess entry point."""
    resolved = shutil.which(argv[0])
    if resolved is None:
        return 127
    return subprocess.run([resolved] + expand_argv(argv[1:])).returncode


def missing_tools(spec):
    return [tool for tool in spec['needs'] if shutil.which(tool) is None]


def is_dispatch(spec):
    """A workflow dispatch, as opposed to a status listing."""
    argv = spec['argv']
    return 'workflow' in argv and 'run' in argv


def run_action(spec):
    """Dispatch one registry row. Returns a RunState."""
    absent = missing_tools(spec)
    if absent:
        print(f'unavailable: {absent[0]!r} is not on PATH')
        return RUN_UNAVAILABLE

    if spec['kind'] == KIND_CI:
        print('this uses GitHub runners, not this machine')
        if is_dispatch(spec):
            print('dispatching a workflow; it runs on GitHub CPUs')

    print(f'running: {" ".join(spec["argv"])}')
    code = spawn(spec['argv'])

    if is_dispatch(spec):
        print('follow up with: gh run list')
        print('follow up with: gh run watch')

    return RUN_OK if code == 0 else RUN_FAILED


# ---------- self check ----------

def _functions_calling_spawn():
    """Names of top-level functions that call subprocess.run/Popen."""
    source = open(__file__, encoding='utf-8').read()
    tree = ast.parse(source)
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for child in ast.walk(node):
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
                owner = child.func.value
                if isinstance(owner, ast.Name) and owner.id == 'subprocess' \
                        and child.func.attr in ('run', 'Popen'):
                    hits.append(node.name)
                    break
    return hits


def _id_comparisons_in_source():
    source = open(__file__, encoding='utf-8').read()
    found = []
    for rid in REQUIRED_IDS:
        for quote in ("'", '"'):
            if f'== {quote}{rid}{quote}' in source or f'{quote}{rid}{quote} ==' in source:
                found.append(rid)
    return found


def _references_in(path, needle):
    try:
        return needle in open(path, encoding='utf-8', errors='replace').read()
    except OSError:
        return False


def verdicts():
    """Yield (name, 'PASS'|'FAIL', evidence) for every named subject."""
    rows = COMMANDS

    shape_errors = validate_shape(rows)
    yield ('registry-shape', 'PASS' if not shape_errors else 'FAIL',
           'all rows carry every CommandSpec key' if not shape_errors else '; '.join(shape_errors))

    dup_errors = validate_unique_ids(rows)
    yield ('registry-unique-ids', 'PASS' if not dup_errors else 'FAIL',
           f'{len(rows)} distinct ids' if not dup_errors else '; '.join(dup_errors))

    missing = validate_required_rows(rows)
    yield ('registry-required-rows', 'PASS' if not missing else 'FAIL',
           f'all {len(REQUIRED_IDS)} required ids present' if not missing else '; '.join(missing))

    compared = _id_comparisons_in_source()
    yield ('dispatch-is-a-registry', 'PASS' if not compared else 'FAIL',
           'no id is compared outside the registry' if not compared
           else f'ids compared in dispatch: {compared}')

    spawners = _functions_calling_spawn()
    yield ('single-spawn-function', 'PASS' if len(spawners) == 1 else 'FAIL',
           f'only {spawners[0]!r} spawns a process' if len(spawners) == 1
           else f'spawning functions: {spawners}')

    here = os.path.dirname(os.path.abspath(__file__))
    wrappers_ok = _references_in(os.path.join(here, 'tui.sh'), 'tui.py') \
        and _references_in(os.path.join(here, 'tui.bat'), 'tui.py')
    yield ('wrappers-launch', 'PASS' if wrappers_ok else 'FAIL',
           'both wrappers reference tui.py' if wrappers_ok
           else 'tui.sh or tui.bat is missing or does not reference tui.py')

    # Falsifying mutations. A mutation that survives means the check is weak.
    duplicated = [dict(row) for row in rows]
    duplicated.append(dict(duplicated[0]))
    dup_killed = bool(validate_unique_ids(duplicated))
    yield ('mutation-duplicate-id-killed', 'PASS' if dup_killed else 'FAIL',
           'validator rejected a duplicated id' if dup_killed
           else 'validator accepted a duplicated id')

    truncated = [dict(row) for row in rows]
    del truncated[1]['argv']
    shape_killed = bool(validate_shape(truncated))
    yield ('mutation-missing-key-killed', 'PASS' if shape_killed else 'FAIL',
           'validator rejected a row with no argv' if shape_killed
           else 'validator accepted a row with no argv')


def run_check():
    failed = 0
    for name, status, evidence in verdicts():
        print(f'VERDICT {name} {status} {evidence}')
        if status != 'PASS':
            failed += 1
    return 1 if failed else 0


# ---------- menu ----------

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


def render_menu(last_state):
    print()
    print('Verity terminal front end')
    print('  local commands run here; CI commands run on GitHub runners')
    print()
    for position, spec in enumerate(COMMANDS):
        key = '0' if position == len(COMMANDS) - 1 else str(position + 1)
        print(f'  [{key}] {spec["label"]:<38} {spec["runs_on"]}')
    print()
    print('  [q] quit')
    if last_state:
        print(f'  last result: {last_state}')
    print()


def menu():
    state = RUN_IDLE
    while True:
        render_menu(state)
        print('select: ', end='', flush=True)
        key = read_key()
        print()
        if key in ('q', 'Q', '\x1b', '\x03'):
            return 0
        if key == '0':
            index = len(COMMANDS) - 1
        elif key.isdigit() and 1 <= int(key) <= len(COMMANDS):
            index = int(key) - 1
        else:
            state = RUN_IDLE
            continue
        state = run_action(COMMANDS[index])
        print(f'result: {state}')


def main(argv):
    if '--check' in argv:
        return run_check()
    if '--list' in argv:
        for spec in COMMANDS:
            print(json.dumps(spec))
        return 0
    return menu()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
