// The SDK code behind each button of the page, in C# and in Python: the same calls as in
// src/Backend.DotNet/RmiSession.cs and src/Backend.Python/rmi_session.py

const DOC = 'https://underautomation.com/fanuc/documentation/';

export const SNIPPETS = {
  connect: {
    title: 'Connect',
    text: 'Opens an RMI session with the controller (option R912, TCP port 16001). Nothing is installed on the robot.',
    doc: DOC + 'rmi',
    csharp: `var robot = new FanucRobot();

var parameters = new ConnectionParameters("192.168.0.1");
parameters.Rmi.Enable = true;
robot.Connect(parameters);

// Is the controller ready to move?
RmiControllerStatusResponse status = robot.Rmi.GetStatus();
bool ready = status.ServoReady && !status.TPEnabled;

// When done, always end the session
robot.Disconnect();`,
    python: `robot = FanucRobot()

parameters = ConnectionParameters("192.168.0.1")
parameters.rmi.enable = True
robot.connect(parameters)

# Is the controller ready to move?
status = robot.rmi.get_status()
ready = status.servo_ready and not status.tp_enabled

# When done, always end the session
robot.disconnect()`,
  },

  position: {
    title: 'Current position',
    text: 'Reads the position of the robot. The page polls it to show the live position, and the target icon of a move block copies it into the block.',
    doc: DOC + 'rmi-frames-io',
    csharp: `CartesianPositionWithUserFrame position = robot.Rmi.ReadCartesianPosition().Position;
Console.WriteLine($"X={position.X} Y={position.Y} Z={position.Z} W={position.W} P={position.P} R={position.R}");
Console.WriteLine($"UTOOL {position.Tool}, UFRAME {position.Frame}");

JointsPosition joints = robot.Rmi.ReadJointAngles().JointAngle;
Console.WriteLine($"J1={joints.J1} J2={joints.J2} J3={joints.J3} J4={joints.J4} J5={joints.J5} J6={joints.J6}");`,
    python: `position = robot.rmi.read_cartesian_position().position
print(f"X={position.x} Y={position.y} Z={position.z} W={position.w} P={position.p} R={position.r}")
print(f"UTOOL {position.tool}, UFRAME {position.frame}")

joints = robot.rmi.read_joint_angles().joint_angle
print(f"J1={joints.j1} J2={joints.j2} J3={joints.j3} J4={joints.j4} J5={joints.j5} J6={joints.j6}")`,
  },

  run: {
    title: 'Run',
    text: 'Starts the RMI_MOVE program, then sends one TP instruction per block. The SDK feeds the 8 slots of the controller buffer and tracks each instruction. The C# and Python tabs of the page show the whole program of your sequence.',
    doc: DOC + 'rmi-motion',
    csharp: `// Controller in AUTO, teach pendant disabled
robot.Rmi.Initialize();
robot.Rmi.SetOverride(10);

// Returns at once: the instruction is queued
RmiInstructionResponse response = robot.Rmi.SendTpInstruction(new LinearMotionTpInstruction
{
    SpeedType = RmiLinearSpeedType.MmSec, Speed = 100,
    TermType = RmiTerminationType.Fine,
    Target = new CartesianPositionWithUserFrame(500, 0, 400, 180, 0, 0, tool: 1, frame: 0)
});

// LocalQueued, ControllerQueued, Executing, then Completed or Error
response.StatusChanged += status => Console.WriteLine(status);
response.WaitForCompletion();

if (response.Status == RmiInstructionStatus.Error)
    Console.WriteLine(response.ErrorText);`,
    python: `# Controller in AUTO, teach pendant disabled
robot.rmi.initialize()
robot.rmi.set_override(10)

move = LinearMotionTpInstruction()
move.speed_type = RmiLinearSpeedType.MmSec
move.speed = 100
move.term_type = RmiTerminationType.Fine
move.target = CartesianPositionWithUserFrame(500, 0, 400, 180, 0, 0, 1, 0)

# Returns at once: the instruction is queued
response = robot.rmi.send_tp_instruction(move)

# LocalQueued, ControllerQueued, Executing, then Completed or Error
response.wait_for_completion()

if response.status == RmiInstructionStatus.Error:
    print(response.error_text)`,
  },

  pause: {
    title: 'Pause',
    text: 'Pauses the motion program. The robot decelerates and stops on its path.',
    doc: DOC + 'rmi-frames-io',
    csharp: 'robot.Rmi.Pause();',
    python: 'robot.rmi.pause()',
  },

  continue: {
    title: 'Continue',
    text: 'Resumes a paused motion program.',
    doc: DOC + 'rmi-frames-io',
    csharp: 'robot.Rmi.Continue();',
    python: 'robot.rmi.continue_()',
  },

  abort: {
    title: 'Abort',
    text: 'Drops the instructions that are not sent yet and aborts the motion program. This is not an emergency stop.',
    doc: DOC + 'rmi-frames-io',
    csharp: `robot.Rmi.ClearLocalQueuedInstructions();
robot.Rmi.Abort();`,
    python: `robot.rmi.clear_local_queued_instructions()
robot.rmi.abort()`,
  },

  reset: {
    title: 'Reset',
    text: 'Resets the alarms of the controller and leaves the HOLD state, like the RESET key of the teach pendant.',
    doc: DOC + 'rmi-frames-io',
    csharp: `robot.Rmi.Reset();

// The last alarms of the controller, for example MOTN-018
foreach (string alarm in robot.Rmi.ReadError(count: 3).ErrorDataEntries)
    Console.WriteLine(alarm);`,
    python: `robot.rmi.reset()

# The last alarms of the controller, for example MOTN-018
for alarm in robot.rmi.read_error(3).error_data_entries:
    print(alarm)`,
  },

  license: {
    title: 'License',
    text: 'The SDK runs 30 days without a key. With a license, register it once, before the first connection.',
    doc: DOC + 'license',
    csharp: `FanucRobot.RegisterLicense("YourCompanyName", "YOUR_LICENSE_KEY");

LicenseInfo info = FanucRobot.LicenseInfo;
Console.WriteLine($"{info.State}, {info.EvaluationDaysLeft} trial days left");`,
    python: `FanucRobot.register_license("YourCompanyName", "YOUR_LICENSE_KEY")

info = FanucRobot.license_info
print(f"{info.state}, {info.evaluation_days_left} trial days left")`,
  },
};
