#!/usr/bin/env python3
"""Local loopback preview with an existing server credential in process memory."""
from pathlib import Path
import os

env = os.environ.copy()
if not env.get('SUPABASE_SERVICE_ROLE_KEY'):
    for path in [Path.home()/'.env', Path.home()/'Documents/Software/actp-worker/.env']:
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            key, separator, value = line.strip().removeprefix('export ').partition('=')
            if separator and key.strip() in ('SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SERVICE_KEY'):
                env['SUPABASE_SERVICE_ROLE_KEY'] = value.strip().strip(chr(34)).strip(chr(39))
                break
        if env.get('SUPABASE_SERVICE_ROLE_KEY'):
            break
if not env.get('SUPABASE_SERVICE_ROLE_KEY'):
    raise SystemExit('Set the server credential in the environment for local preview.')
os.execvpe('npm', ['npm','run','dev'], env)
