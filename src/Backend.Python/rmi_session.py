"""
Everything this demo does with the robot. It only uses the RMI protocol of the UnderAutomation Fanuc SDK.
The .NET backend has the same class, line for line: src/Backend.DotNet/RmiSession.cs

A step of a sequence is a dict sent by the web page, one Blockly block is one step:
    id      id of the block, sent back with the status so the page can highlight it
    type    joint, linear, linear_rel, wait, wait_di or set_do
    v       J1..J6 in degrees, or X, Y, Z (mm), W, P, R (degrees)
    speed   % for a joint motion, mm/s for a linear motion
    cnt     0 for FINE, 1 to 100 for CNT
    port, on, seconds
"""
import threading
import time
from functools import partial

from underautomation.fanuc.fanuc_robot import FanucRobot
from underautomation.fanuc.connection_parameters import ConnectionParameters
from underautomation.fanuc.common.cartesian_position_with_user_frame import CartesianPositionWithUserFrame
from underautomation.fanuc.common.joints_position import JointsPosition
from underautomation.fanuc.common.task_status import TaskStatus
from underautomation.fanuc.rmi.data.rmi_instruction_status import RmiInstructionStatus
from underautomation.fanuc.rmi.data.rmi_joint_speed_type import RmiJointSpeedType
from underautomation.fanuc.rmi.data.rmi_linear_speed_type import RmiLinearSpeedType
from underautomation.fanuc.rmi.data.rmi_on_off import RmiOnOff
from underautomation.fanuc.rmi.data.rmi_termination_type import RmiTerminationType
from underautomation.fanuc.rmi.tp_instructions.joint_motion_j_rep_tp_instruction import JointMotionJRepTpInstruction
from underautomation.fanuc.rmi.tp_instructions.linear_motion_tp_instruction import LinearMotionTpInstruction
from underautomation.fanuc.rmi.tp_instructions.linear_relative_tp_instruction import LinearRelativeTpInstruction
from underautomation.fanuc.rmi.tp_instructions.wait_din_tp_instruction import WaitDinTpInstruction
from underautomation.fanuc.rmi.tp_instructions.wait_time_tp_instruction import WaitTimeTpInstruction

# The SDK raises the .NET exceptions: they are caught with their .NET types
from System.Net.Sockets import SocketException, SocketError
from UnderAutomation.Fanuc.License import InvalidLicenseException
from UnderAutomation.Fanuc.Rmi import RmiException

MOTIONS = ("joint", "linear", "linear_rel")


class DemoError(Exception):
    """An error with a code, so the web page can tell the user what to check on the robot"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Aborted(Exception):
    pass


class StepState:
    def __init__(self, id):
        self.id = id
        self.response = None  # RmiInstructionResponse
        self.host_status = None  # for a step that is not queued on the controller: it has no RmiInstructionResponse

    @property
    def status(self):
        # Pending, then the pipeline of the SDK: LocalQueued, ControllerQueued, Executing, Completed or Error
        if self.host_status:
            return self.host_status
        return RmiInstructionStatus(self.response.status).name if self.response else "Pending"

    @property
    def error(self):
        failed = self.response and self.response.status == RmiInstructionStatus.Error
        return self.response.error_text if failed else None


class RmiSession:
    def __init__(self, log):
        self._log = log
        self._robot = FanucRobot()
        self._io = threading.RLock()  # one RMI request at a time: the page polls the state while a sequence runs
        self._tool = self._frame = 0
        self._steps = []
        self._run_state = "idle"
        self._run_error = None
        self._abort_requested = False
        self._notice = None
        self._ip = ""

    @property
    def connected(self):
        return self._robot.rmi.connected

    def connect(self, ip):
        self.disconnect()

        parameters = ConnectionParameters(ip)
        parameters.cgtp.enable = False  # enabled by default, this demo is RMI only
        parameters.rmi.enable = True

        robot = FanucRobot()
        active, failure = [], []

        def connect():
            try:
                robot.connect(parameters)
                # The Cartesian targets of the sequence are given in the active tool and user frame
                active.append(robot.rmi.get_u_frame_u_tool())
            except Exception as e:
                failure.append(e)

        thread = threading.Thread(target=connect, daemon=True)
        thread.start()
        # A controller that already has an RMI session can accept a second one, then never answer its commands
        thread.join(8)
        if thread.is_alive():
            threading.Thread(target=robot.disconnect, daemon=True).start()
            raise DemoError("busy", f"The controller at {ip} accepted the connection but does not answer")
        if failure:
            raise self._diagnose(failure[0])

        self._robot = robot
        self._ip = ip
        self._notice = None
        self._robot.rmi.connection_terminated(self._on_connection_terminated)

        self._frame, self._tool = active[0].frame, active[0].tool
        rmi = self._robot.rmi
        self._log(f"Connected to {ip}, RMI v{rmi.major_version}.{rmi.minor_version}, UFRAME {self._frame}, UTOOL {self._tool}")

    def _on_connection_terminated(self):
        self._notice = "The controller closed the RMI session"
        self._log(self._notice)

    @staticmethod
    def _diagnose(error):
        """Why did the connection fail? The page shows what to check for each code."""
        code = "unreachable"  # no answer to the ping, unknown host, network error
        message = error.Message if hasattr(error, "Message") else str(error)
        e = error
        while e is not None:
            if isinstance(e, InvalidLicenseException):
                code = "license"
            # The controller answered on port 16001 and refused the session: its error id is in the RmiException
            elif isinstance(e, RmiException):
                code, message = "refused", f"{message}: {e.Message} (error {e.ErrorId})"
            # The robot answers the ping but nothing listens on port 16001: no RMI option.
            # Refused on another port: the controller gave a working port that an other session already uses.
            elif isinstance(e, SocketException) and e.SocketErrorCode == SocketError.ConnectionRefused:
                code = "no_rmi" if ":16001" in e.Message else "busy"
            e = getattr(e, "InnerException", None)
        return DemoError(code, message)

    def disconnect(self):
        if not self.connected:
            return
        try:
            self.abort()
        except Exception:
            pass
        # Always end the session, otherwise the controller keeps RMI_MOVE selected
        with self._io:
            self._robot.disconnect()
        self._log("Disconnected")

    def run(self, steps, override_percent):
        """Starts the sequence and returns at once: the page follows it with get_state()"""
        if not self.connected:
            raise DemoError("not_connected", "Not connected to a robot")
        if self._run_state in ("running", "paused"):
            raise DemoError("already_running", "A sequence is already running")
        if not 1 <= override_percent <= 100:
            raise ValueError("Override must be between 1 and 100 %")
        for step in steps:
            self._validate(step)

        self._steps = [StepState(step["id"]) for step in steps]
        self._abort_requested = False
        self._run_state, self._run_error = "running", None
        self._log(f"Run {len(steps)} steps at {override_percent} % override")
        threading.Thread(target=self._run, args=(steps, override_percent), daemon=True).start()

    def _run(self, steps, override_percent):
        try:
            with self._io:
                # Creates and starts the RMI_MOVE program. The controller must be in AUTO, teach pendant disabled.
                self._robot.rmi.initialize()
                self._robot.rmi.set_override(override_percent)

            # Which steps are queued on the controller as TP instructions? A motion always is. write_dout is an
            # immediate command. And the controller reports a WAIT as completed only when the next instruction
            # arrives, so a WAIT that nothing follows is done by this program instead.
            queued = [False] * (len(steps) + 1)
            for i in reversed(range(len(steps))):
                queued[i] = steps[i]["type"] in MOTIONS or (steps[i]["type"] != "set_do" and queued[i + 1])

            for i, (step, state) in enumerate(zip(steps, self._steps)):
                if not queued[i]:
                    self._wait_all()  # let the instructions sent before finish first
                    state.host_status = "Executing"
                    self._run_on_host(step)
                    state.host_status = "Completed"
                    continue

                # A CNT motion waits for the next instruction to blend with: it must not be the last one sent
                instruction = self._to_instruction(step, can_blend=queued[i + 1])

                # Returns at once: the SDK feeds the 8 slots of the controller buffer and tracks the instruction
                with self._io:
                    state.response = self._robot.rmi.send_tp_instruction(instruction)
                state.response.status_changed(partial(self._log_status, i + 1, type(instruction).__name__, state))

            self._wait_all()
            self._run_state = "done"
            self._log("Sequence completed")
        except Exception as e:
            if self._abort_requested:
                self._run_state, self._run_error = "aborted", None
                self._log("Sequence aborted")
            else:
                self._run_state, self._run_error = "error", getattr(e, "Message", None) or str(e)
                self._log(f"Sequence failed: {self._run_error}")
        finally:
            # After an alarm, RMI_MOVE is paused: it is the only moment when the controller accepts a reset.
            # Without it, the alarm stays, and the next initialize fails and leaves RMI_MOVE selected.
            if self._run_state == "error":
                try:
                    with self._io:
                        self._robot.rmi.reset()
                except Exception:
                    pass
            # Ends RMI_MOVE, so that other TP programs can run again
            try:
                with self._io:
                    self._robot.rmi.abort()
            except Exception:
                pass
            if self._run_state == "error":
                self._restart()

    def _log_status(self, number, name, state, *_):
        self._log(f"#{number} {name}: {state.status}")

    def _run_on_host(self, step):
        def sleep():
            if self._abort_requested:
                raise Aborted()
            time.sleep(0.05)

        value = self._on_off(step["on"]) if "on" in step else None
        if step["type"] == "set_do":
            with self._io:
                self._robot.rmi.write_dout(step["port"], value)
            self._log(f"DO[{step['port']}] = {value.name}")
        elif step["type"] == "wait":
            end = time.monotonic() + step["seconds"]
            while time.monotonic() < end:
                sleep()
        else:  # wait_di
            self._log(f"Waiting for DI[{step['port']}] = {value.name}")
            while True:
                with self._io:
                    if self._robot.rmi.read_din(step["port"]).port_value == value:
                        break
                sleep()

    def _wait_all(self):
        for state in self._steps:
            response = state.response
            if response is None:
                continue
            while not response.wait_for_completion(100):
                if self._abort_requested:
                    raise Aborted()
            if response.status == RmiInstructionStatus.Error:
                name = type(response.instruction).__name__
                raise Exception(f"{name}: {response.error_text} (error {response.error_id})")

        # An alarm, for example a target out of reach, pauses RMI_MOVE without failing the instruction
        time.sleep(0.2)
        with self._io:
            if self._run_state != "paused" and self._robot.rmi.get_status().program_status != TaskStatus.Running:
                alarm = ", ".join(self._robot.rmi.read_error().error_data_entries)
                raise Exception(f"The controller stopped the motion program, alarm {alarm}")

    def _to_instruction(self, step, can_blend):
        kind = step["type"]
        if kind == "wait":
            instruction = WaitTimeTpInstruction()
            instruction.seconds = step["seconds"]
            return instruction
        if kind == "wait_di":
            instruction = WaitDinTpInstruction()
            instruction.port_number = step["port"]
            instruction.value = self._on_off(step["on"])
            return instruction

        v = step["v"]
        if kind == "joint":
            instruction = JointMotionJRepTpInstruction()
            instruction.speed_type = RmiJointSpeedType.Percent
            instruction.joints = JointsPosition(*v)
        else:
            instruction = LinearMotionTpInstruction() if kind == "linear" else LinearRelativeTpInstruction()
            instruction.speed_type = RmiLinearSpeedType.MmSec
            instruction.target = CartesianPositionWithUserFrame(*v, self._tool, self._frame)
        instruction.speed = step["speed"]
        cnt = step.get("cnt", 0) > 0 and can_blend
        instruction.term_type = RmiTerminationType.Cnt if cnt else RmiTerminationType.Fine
        instruction.term_value = step["cnt"] if cnt else 0
        return instruction

    @staticmethod
    def _on_off(on):
        return RmiOnOff.ON if on else RmiOnOff.OFF

    @staticmethod
    def _validate(step):
        """The steps come from the network: check them before anything is sent to the robot"""
        kind = step.get("type")
        if kind not in MOTIONS + ("wait", "wait_di", "set_do"):
            raise ValueError(f"Unknown step type '{kind}'")
        if not isinstance(step.get("id"), str):
            raise ValueError("A step needs an id")
        if kind in MOTIONS:
            v = step.get("v")
            if not isinstance(v, list) or len(v) != 6 or not all(isinstance(x, (int, float)) for x in v):
                raise ValueError(f"A '{kind}' step needs 6 values")
            speed = step.get("speed")
            if not isinstance(speed, int) or not 1 <= speed <= (100 if kind == "joint" else 2000):
                raise ValueError(f"Speed {speed} is out of range for a '{kind}' step")
            if not 0 <= step.setdefault("cnt", 0) <= 100:
                raise ValueError("CNT must be between 0 and 100")
        if kind in ("wait_di", "set_do"):
            if not isinstance(step.get("port"), int) or not 1 <= step["port"] <= 32767:
                raise ValueError(f"Invalid port number {step.get('port')}")
            step["on"] = bool(step.get("on"))
        if kind == "wait" and not (isinstance(step.get("seconds"), (int, float)) and 0 <= step["seconds"] <= 3600):
            raise ValueError("A wait lasts between 0 and 3600 seconds")

    def pause(self):
        with self._io:
            self._robot.rmi.pause()
        if self._run_state == "running":
            self._run_state = "paused"
        self._log("Paused")

    def continue_(self):
        with self._io:
            self._robot.rmi.continue_()
        if self._run_state == "paused":
            self._run_state = "running"
        self._log("Continued")

    def abort(self):
        self._abort_requested = True  # stops the sequence thread, which is waiting for the instructions
        with self._io:
            self._robot.rmi.clear_local_queued_instructions()
            self._robot.rmi.abort()
        self._log("Aborted")

    def reset(self):
        """Resets the controller errors and leaves the HOLD state"""
        # The controller only accepts a reset while RMI_MOVE runs
        try:
            with self._io:
                self._robot.rmi.reset()
        except RmiException:
            pass
        self._log("Reset")
        if self._run_state not in ("running", "paused"):
            self._restart()

    def _restart(self):
        """After an alarm, the controller refuses initialize in the same RMI session, and accepts it in a new one"""
        try:
            self.connect(self._ip)
        except Exception as e:
            self._notice = f"The RMI session could not be restarted: {getattr(e, 'Message', None) or e}"
            self._log(self._notice)

    def get_state(self):
        """Controller status, position and progress of the sequence: polled by the page"""
        run = {
            "state": self._run_state,
            "error": self._run_error,
            "steps": [{"id": s.id, "status": s.status, "error": s.error} for s in self._steps],
        }
        if not self.connected:
            return {"connected": False, "notice": self._notice, "run": run}

        rmi = self._robot.rmi
        last_error = None
        hold = rmi.is_in_hold_state
        with self._io:
            status = rmi.get_status()
            cartesian = rmi.read_cartesian_position().position
            joints = rmi.read_joint_angles().joint_angle
            # The last alarm of the controller, when something prevents the motion
            if not status.servo_ready or hold or self._run_state == "error":
                last_error = ", ".join(rmi.read_error().error_data_entries)

        return {
            "connected": True,
            "controller": {
                "servoReady": status.servo_ready,
                "tpEnabled": status.tp_enabled,
                "rmiRunning": status.rmi_motion_status,
                "override": status.speed_override,
                "hold": hold,
                "singleStep": status.single_step_mode,
                "lastError": last_error,
                "rmiVersion": f"{rmi.major_version}.{rmi.minor_version}",
            },
            "position": {
                "cartesian": [cartesian.x, cartesian.y, cartesian.z, cartesian.w, cartesian.p, cartesian.r],
                "joints": [joints.j1, joints.j2, joints.j3, joints.j4, joints.j5, joints.j6],
                "tool": cartesian.tool,
                "frame": cartesian.frame,
            },
            "run": run,
        }
