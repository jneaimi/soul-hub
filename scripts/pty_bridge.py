#!/usr/bin/env python3
"""PTY Bridge — Spawns claude in a real PTY, streams I/O as JSON lines to stdout.

Protocol (stdout, one JSON per line):
  {"type": "spawned", "pid": 12345}
  {"type": "output", "data": "..."}
  {"type": "exit", "code": 0}

Protocol (stdin, one JSON per line):
  {"type": "input", "data": "..."}
  {"type": "resize", "cols": 120, "rows": 40}
  {"type": "kill"}
"""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def main():
    args = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    prompt = args.get("prompt", "")
    cwd = args.get("cwd", os.environ.get("HOME", "/"))
    cols = args.get("cols", 120)
    rows = args.get("rows", 40)
    claude_bin = os.path.expanduser("~/.local/bin/claude")

    master_fd, slave_fd = pty.openpty()

    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    pid = os.fork()
    if pid == 0:
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        os.chdir(cwd)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["CLAUDE_CODE_DISABLE_HOOKS"] = "1"
        os.execve(claude_bin, [claude_bin, "--dangerously-skip-permissions"], env)

    os.close(slave_fd)

    fl = fcntl.fcntl(sys.stdin, fcntl.F_GETFL)
    fcntl.fcntl(sys.stdin, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    emit({"type": "spawned", "pid": pid})

    prompt_sent = False
    output_buffer = ""
    start_time = time.time()
    # Track if we've seen the welcome banner complete and the input prompt appear
    seen_input_prompt = False

    try:
        while True:
            rlist, _, _ = select.select([master_fd, sys.stdin], [], [], 0.1)

            for fd in rlist:
                if fd == master_fd:
                    try:
                        data = os.read(master_fd, 4096)
                        if not data:
                            raise EOFError
                        text = data.decode("utf-8", errors="replace")
                        output_buffer += text
                        emit({"type": "output", "data": text})

                        if not prompt_sent and prompt:
                            elapsed = time.time() - start_time
                            # Look for the input prompt indicator (❯) which appears
                            # after the welcome banner when Claude is ready for input.
                            # Also check for "bypass permissions" which confirms
                            # --dangerously-skip-permissions is active.
                            recent = output_buffer[-500:] if len(output_buffer) > 500 else output_buffer
                            if "\u276f" in recent:  # ❯ character
                                seen_input_prompt = True
                            # Send prompt once we see the input prompt and enough
                            # time has passed for the UI to settle
                            if seen_input_prompt and elapsed > 3.0:
                                time.sleep(0.8)  # let terminal fully settle
                                os.write(master_fd, prompt.encode())
                                time.sleep(0.2)
                                os.write(master_fd, b"\r")
                                prompt_sent = True
                                emit({"type": "prompt_sent"})
                            # Fallback: after 10s just send it regardless
                            elif elapsed > 10.0 and len(output_buffer) > 200:
                                time.sleep(0.5)
                                os.write(master_fd, prompt.encode())
                                time.sleep(0.2)
                                os.write(master_fd, b"\r")
                                prompt_sent = True
                                emit({"type": "prompt_sent"})
                    except OSError:
                        raise EOFError

                elif fd == sys.stdin:
                    try:
                        line = sys.stdin.readline()
                        if not line:
                            continue
                        msg = json.loads(line.strip())
                        if msg["type"] == "input":
                            os.write(master_fd, msg["data"].encode())
                        elif msg["type"] == "resize":
                            winsize = struct.pack("HHHH", msg["rows"], msg["cols"], 0, 0)
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                            os.kill(pid, signal.SIGWINCH)
                        elif msg["type"] == "kill":
                            os.kill(pid, signal.SIGTERM)
                    except (json.JSONDecodeError, BlockingIOError):
                        pass

            result = os.waitpid(pid, os.WNOHANG)
            if result[0] != 0:
                code = os.WEXITSTATUS(result[1]) if os.WIFEXITED(result[1]) else -1
                emit({"type": "exit", "code": code})
                break

    except (EOFError, KeyboardInterrupt):
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
        emit({"type": "exit", "code": -1})

    os.close(master_fd)


def emit(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
