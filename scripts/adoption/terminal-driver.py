"""Run the public CLI in a real POSIX terminal; exchange JSON with the lab driver."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import sys
import struct
import termios
import time

request = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    os.chdir(request["cwd"])
    environment = dict(os.environ)
    environment.pop("NO_COLOR", None)
    environment.update(request.get("env", {}))
    environment["TERM"] = "xterm-256color" if request.get("styled") else "dumb"
    os.execvpe(request["command"], [request["command"], *request["args"]], environment)

raw = bytearray()
actions = []
step = 0
cursor = 0
deadline = time.monotonic() + request.get("timeoutSeconds", 90)
step_deadline = time.monotonic() + (request["steps"][0].get("timeoutSeconds", 90) if request["steps"] else 90)
failure = None
status = None
ansi = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")

def cleaned():
    return ansi.sub("", raw.decode("utf-8", errors="replace")).replace("\r", "")

def stop(signum=signal.SIGTERM):
    try:
        os.killpg(pid, signum)
    except ProcessLookupError:
        pass

def interrupted(signum, _frame):
    stop()
    raise RuntimeError(f"Terminal driver interrupted by signal {signum}")

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    while True:
        if time.monotonic() >= deadline or (step < len(request["steps"]) and time.monotonic() >= step_deadline):
            raise TimeoutError(f"Terminal timed out waiting for step {step + 1}")
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            raw.extend(chunk)
        text = cleaned()
        if request.get("livePath"):
            with open(request["livePath"], "w", encoding="utf-8") as live:
                live.write(text)
        if step < len(request["steps"]):
            action = request["steps"][step]
            expected = action["expect"]
            found = text.find(expected, cursor)
            if found >= 0:
                if "select" in action:
                    pattern = r"(?:^|\n)\s*[›>]?\s*(\d+)\.\s*" + re.escape(action["select"]) + r"(?:\s|$)"
                    choices = re.findall(pattern, text[:found + len(expected)])
                    if not choices:
                        raise RuntimeError(f"Menu option not found: {action['select']}")
                    answer = choices[-1] + "\r"
                else:
                    answer = action.get("send", "")
                os.write(fd, answer.encode("utf-8"))
                actions.append({"expect": expected, "selection": action.get("select"), "sent": answer})
                cursor = found + len(expected)
                step += 1
                if step < len(request["steps"]):
                    step_deadline = time.monotonic() + request["steps"][step].get("timeoutSeconds", 90)
        ended, child_status = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = os.waitstatus_to_exitcode(child_status)
            # Drain the final output after exit.
            while select.select([fd], [], [], 0)[0]:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    raw.extend(chunk)
                except OSError:
                    break
            break
    if step != len(request["steps"]):
        raise RuntimeError(f"CLI exited before step {step + 1} (exit {status})")
except Exception as error:
    failure = str(error)
finally:
    if status is None:
        stop()
        until = time.monotonic() + 1
        while time.monotonic() < until:
            ended, child_status = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = os.waitstatus_to_exitcode(child_status)
                break
            time.sleep(0.02)
        if status is None:
            stop(signal.SIGKILL)
            _, child_status = os.waitpid(pid, 0)
            status = os.waitstatus_to_exitcode(child_status)
    os.close(fd)

json.dump({"transport": "pty", "exitCode": status, "failure": failure,
           "actions": actions, "transcript": cleaned()}, sys.stdout)
sys.stdout.write("\n")
