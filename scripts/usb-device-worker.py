"""JSON-lines stdio bridge to the ESP32 console. Never toggle reset/boot pins."""
import argparse
import json
import queue
import sys
import threading
import time
import serial

parser = argparse.ArgumentParser()
parser.add_argument('--port', default='COM5')
args = parser.parse_args()
commands = queue.Queue(maxsize=100)
stopped = threading.Event()
diagnostic_markers = (
    'StateMachine: State:',
    'StateMachine: Invalid state transition:',
    'Application: Wake word detected:',
    'WorkBuddyUSB:',
)

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def read_commands():
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if isinstance(message, dict):
                commands.put(message, timeout=2)
        except (ValueError, queue.Full):
            pass
    stopped.set()

threading.Thread(target=read_commands, daemon=True).start()
while not stopped.is_set():
    try:
        port = serial.Serial()
        port.port = args.port
        port.baudrate = 115200
        port.timeout = 0.05
        port.write_timeout = 3
        port.dtr = False
        port.rts = False
        port.open()
        emit({'type': 'transport_connected'})
        buffer = b''
        with port:
            while not stopped.is_set():
                try:
                    command = commands.get_nowait()
                    payload = b'WB:' + json.dumps(command, ensure_ascii=False).encode('utf-8') + b'\n'
                    if len(payload) <= 4096:
                        port.write(payload)
                    else:
                        emit({'id': command.get('id'), 'type': 'error', 'error': 'command_too_large'})
                except queue.Empty:
                    pass
                data = port.read(port.in_waiting or 1)
                buffer += data
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    marker = line.find(b'WBJSON ')
                    if marker >= 0:
                        try:
                            emit(json.loads(line[marker + 7:].decode('utf-8')))
                        except (ValueError, UnicodeDecodeError):
                            pass
                    else:
                        try:
                            decoded_line = line.decode('utf-8', errors='replace').strip()
                            if any(item in decoded_line for item in diagnostic_markers):
                                print(f'[device] {decoded_line}', file=sys.stderr, flush=True)
                        except (ValueError, UnicodeDecodeError):
                            pass
                if len(buffer) > 65536:
                    buffer = b''
    except (serial.SerialException, OSError) as exc:
        emit({'type': 'transport_disconnected', 'error': str(exc)})
        # Commands from the previous connection must not be replayed after reconnect.
        while not commands.empty():
            try:
                commands.get_nowait()
            except queue.Empty:
                break
        stopped.wait(2)
