using System.Net.Sockets;
using UnderAutomation.Fanuc;
using UnderAutomation.Fanuc.Common;
using UnderAutomation.Fanuc.License;
using UnderAutomation.Fanuc.Rmi;
using UnderAutomation.Fanuc.Rmi.Data;
using UnderAutomation.Fanuc.Rmi.TpInstructions;

namespace FanucRmiDemo;

/// <summary>One step of a sequence, as sent by the web page: one Blockly block is one step.</summary>
/// <param name="Id">Id of the block, sent back with the status so the page can highlight it</param>
/// <param name="Type">joint, linear, linear_rel, wait, wait_di or set_do</param>
/// <param name="V">J1..J6 in degrees, or X, Y, Z (mm), W, P, R (degrees)</param>
/// <param name="Speed">% for a joint motion, mm/s for a linear motion</param>
/// <param name="Cnt">0 for FINE, 1 to 100 for CNT</param>
public record Step(string Id, string Type, double[]? V, int Speed, int Cnt, int Port, bool On, double Seconds);

/// <summary>An error with a code, so the web page can tell the user what to check on the robot</summary>
public sealed class DemoException(string code, string message) : Exception(message)
{
    public string Code => code;
}

/// <summary>
/// Everything this demo does with the robot. It only uses the RMI protocol of the UnderAutomation Fanuc SDK.
/// The Python backend has the same class, line for line: src/Backend.Python/rmi_session.py
/// </summary>
public sealed class RmiSession(Action<string> log)
{
    private FanucRobot _robot = new();
    private readonly object _io = new(); // one RMI request at a time: the page polls the state while a sequence runs
    private int _tool, _frame;
    private StepState[] _steps = [];
    private string _runState = "idle";
    private string? _runError;
    private volatile bool _abortRequested;
    private string? _notice;
    private string _ip = "";

    public bool Connected => _robot.Rmi.Connected;

    public void Connect(string ip)
    {
        Disconnect();

        var parameters = new ConnectionParameters(ip);
        parameters.Cgtp.Enable = false; // enabled by default, this demo is RMI only
        parameters.Rmi.Enable = true;

        var robot = new FanucRobot();
        var connect = Task.Run(() =>
        {
            robot.Connect(parameters);
            // The Cartesian targets of the sequence are given in the active tool and user frame
            return robot.Rmi.GetUFrameUTool();
        });
        try
        {
            // A controller that already has an RMI session can accept a second one, then never answer its commands
            if (!connect.Wait(TimeSpan.FromSeconds(8)))
            {
                _ = Task.Run(robot.Disconnect);
                throw new DemoException("busy", $"The controller at {ip} accepted the connection but does not answer");
            }
        }
        catch (AggregateException e)
        {
            throw Diagnose(e.InnerException!);
        }

        _robot = robot;
        _ip = ip;
        _notice = null;
        _robot.Rmi.ConnectionTerminated += () =>
        {
            _notice = "The controller closed the RMI session";
            log(_notice);
        };

        (_frame, _tool) = (connect.Result.Frame, connect.Result.Tool);
        log($"Connected to {ip}, RMI v{_robot.Rmi.MajorVersion}.{_robot.Rmi.MinorVersion}, UFRAME {_frame}, UTOOL {_tool}");
    }

    // Why did the connection fail? The page shows what to check for each code.
    private static DemoException Diagnose(Exception error)
    {
        string code = "unreachable"; // no answer to the ping, unknown host, network error
        string message = error.Message;
        for (Exception? e = error; e != null; e = e.InnerException)
        {
            if (e is InvalidLicenseException) code = "license";
            // The controller answered on port 16001 and refused the session: its error id is in the RmiException
            else if (e is RmiException rmi) (code, message) = ("refused", $"{error.Message}: {rmi.Message} (error {rmi.ErrorId})");
            // The robot answers the ping but nothing listens on port 16001: no RMI option.
            // Refused on another port: the controller gave a working port that an other session already uses.
            else if (e is SocketException { SocketErrorCode: SocketError.ConnectionRefused })
                code = e.Message.Contains(":16001") ? "no_rmi" : "busy";
        }
        return new DemoException(code, message);
    }

    public void Disconnect()
    {
        if (!Connected) return;
        try { Abort(); } catch { }
        // Always end the session, otherwise the controller keeps RMI_MOVE selected
        lock (_io) _robot.Disconnect();
        log("Disconnected");
    }

    /// <summary>Starts the sequence and returns at once: the page follows it with GetState()</summary>
    public void Run(Step[] steps, int overridePercent)
    {
        if (!Connected) throw new DemoException("not_connected", "Not connected to a robot");
        if (_runState is "running" or "paused") throw new DemoException("already_running", "A sequence is already running");
        if (overridePercent is < 1 or > 100) throw new ArgumentException("Override must be between 1 and 100 %");
        foreach (var step in steps) Validate(step);

        _steps = steps.Select(s => new StepState(s.Id)).ToArray();
        _abortRequested = false;
        (_runState, _runError) = ("running", null);
        log($"Run {steps.Length} steps at {overridePercent} % override");

        Task.Run(() =>
        {
            try
            {
                lock (_io)
                {
                    // Creates and starts the RMI_MOVE program. The controller must be in AUTO, teach pendant disabled.
                    _robot.Rmi.Initialize();
                    _robot.Rmi.SetOverride((byte)overridePercent);
                }

                // Which steps are queued on the controller as TP instructions? A motion always is. WriteDOUT is an
                // immediate command. And the controller reports a WAIT as completed only when the next instruction
                // arrives, so a WAIT that nothing follows is done by this program instead.
                bool[] queued = new bool[steps.Length + 1];
                for (int i = steps.Length - 1; i >= 0; i--)
                    queued[i] = steps[i].Type is "joint" or "linear" or "linear_rel" || steps[i].Type != "set_do" && queued[i + 1];

                for (int i = 0; i < steps.Length; i++)
                {
                    var (step, state) = (steps[i], _steps[i]);

                    if (!queued[i])
                    {
                        WaitAll(); // let the instructions sent before finish first
                        state.HostStatus = "Executing";
                        RunOnHost(step);
                        state.HostStatus = "Completed";
                        continue;
                    }

                    // A CNT motion waits for the next instruction to blend with: it must not be the last one sent
                    var instruction = ToInstruction(step, canBlend: queued[i + 1]);

                    // Returns at once: the SDK feeds the 8 slots of the controller buffer and tracks the instruction
                    lock (_io) state.Response = _robot.Rmi.SendTpInstruction(instruction);
                    int number = i + 1;
                    state.Response.StatusChanged += status => log($"#{number} {instruction.GetType().Name}: {status}");
                }

                WaitAll();
                _runState = "done";
                log("Sequence completed");
            }
            catch (Exception e)
            {
                (_runState, _runError) = _abortRequested ? ("aborted", null) : ("error", e.Message);
                log(_abortRequested ? "Sequence aborted" : $"Sequence failed: {e.Message}");
            }
            finally
            {
                // After an alarm, RMI_MOVE is paused: it is the only moment when the controller accepts a reset.
                // Without it, the alarm stays, and the next Initialize fails and leaves RMI_MOVE selected.
                if (_runState == "error") try { lock (_io) _robot.Rmi.Reset(); } catch { }
                // Ends RMI_MOVE, so that other TP programs can run again
                try { lock (_io) _robot.Rmi.Abort(); } catch { }
                if (_runState == "error") Restart();
            }
        });
    }

    private void RunOnHost(Step step)
    {
        if (step.Type == "set_do")
        {
            lock (_io) _robot.Rmi.WriteDOUT((short)step.Port, OnOff(step.On));
            log($"DO[{step.Port}] = {OnOff(step.On)}");
        }
        else if (step.Type == "wait")
        {
            var end = DateTime.UtcNow.AddSeconds(step.Seconds);
            while (DateTime.UtcNow < end) Sleep();
        }
        else // wait_di
        {
            log($"Waiting for DI[{step.Port}] = {OnOff(step.On)}");
            while (true)
            {
                lock (_io) if (_robot.Rmi.ReadDIN((short)step.Port).PortValue == OnOff(step.On)) break;
                Sleep();
            }
        }

        void Sleep()
        {
            if (_abortRequested) throw new OperationCanceledException();
            Thread.Sleep(50);
        }
    }

    private void WaitAll()
    {
        foreach (var state in _steps)
        {
            if (state.Response is not { } response) continue;
            while (!response.WaitForCompletion(100))
                if (_abortRequested) throw new OperationCanceledException();
            if (response.Status == RmiInstructionStatus.Error)
                throw new Exception($"{response.Instruction.GetType().Name}: {response.ErrorText} (error {response.ErrorId})");
        }

        // An alarm, for example a target out of reach, pauses RMI_MOVE without failing the instruction
        Thread.Sleep(200);
        lock (_io)
            if (_runState != "paused" && _robot.Rmi.GetStatus().ProgramStatus != UnderAutomation.Fanuc.Common.TaskStatus.Running)
                throw new Exception($"The controller stopped the motion program, alarm {string.Join(", ", _robot.Rmi.ReadError().ErrorDataEntries)}");
    }

    private RmiInstructionBase ToInstruction(Step step, bool canBlend)
    {
        bool cnt = step.Cnt > 0 && canBlend;
        var termType = cnt ? RmiTerminationType.Cnt : RmiTerminationType.Fine;
        byte termValue = (byte)(cnt ? step.Cnt : 0);
        double[] v = step.V ?? [];

        return step.Type switch
        {
            "joint" => new JointMotionJRepTpInstruction
            {
                SpeedType = RmiJointSpeedType.Percent,
                Speed = (short)step.Speed,
                TermType = termType,
                TermValue = termValue,
                Joints = new JointsPosition(v)
            },
            "linear" => new LinearMotionTpInstruction
            {
                SpeedType = RmiLinearSpeedType.MmSec,
                Speed = (short)step.Speed,
                TermType = termType,
                TermValue = termValue,
                Target = new CartesianPositionWithUserFrame(v[0], v[1], v[2], v[3], v[4], v[5], _tool, _frame)
            },
            "linear_rel" => new LinearRelativeTpInstruction
            {
                SpeedType = RmiLinearSpeedType.MmSec,
                Speed = (short)step.Speed,
                TermType = termType,
                TermValue = termValue,
                Target = new CartesianPositionWithUserFrame(v[0], v[1], v[2], v[3], v[4], v[5], _tool, _frame)
            },
            "wait" => new WaitTimeTpInstruction { Seconds = step.Seconds },
            "wait_di" => new WaitDinTpInstruction { PortNumber = (short)step.Port, Value = OnOff(step.On) },
            _ => throw new ArgumentException($"Unknown step type '{step.Type}'")
        };
    }

    private static RmiOnOff OnOff(bool on) => on ? RmiOnOff.ON : RmiOnOff.OFF;

    // The steps come from the network: check them before anything is sent to the robot
    private static void Validate(Step step)
    {
        bool motion = step.Type is "joint" or "linear" or "linear_rel";
        if (!motion && step.Type is not ("wait" or "wait_di" or "set_do"))
            throw new ArgumentException($"Unknown step type '{step.Type}'");
        if (motion && step.V?.Length != 6)
            throw new ArgumentException($"A '{step.Type}' step needs 6 values");
        if (motion && (step.Speed < 1 || step.Speed > (step.Type == "joint" ? 100 : 2000)))
            throw new ArgumentException($"Speed {step.Speed} is out of range for a '{step.Type}' step");
        if (step.Cnt is < 0 or > 100) throw new ArgumentException("CNT must be between 0 and 100");
        if (step.Type is "wait_di" or "set_do" && step.Port is < 1 or > short.MaxValue)
            throw new ArgumentException($"Invalid port number {step.Port}");
        if (step.Type == "wait" && step.Seconds is < 0 or > 3600)
            throw new ArgumentException("A wait lasts between 0 and 3600 seconds");
    }

    public void Pause()
    {
        lock (_io) _robot.Rmi.Pause();
        if (_runState == "running") _runState = "paused";
        log("Paused");
    }

    public void Continue()
    {
        lock (_io) _robot.Rmi.Continue();
        if (_runState == "paused") _runState = "running";
        log("Continued");
    }

    public void Abort()
    {
        _abortRequested = true; // stops the sequence thread, which is waiting for the instructions
        lock (_io)
        {
            _robot.Rmi.ClearLocalQueuedInstructions();
            _robot.Rmi.Abort();
        }
        log("Aborted");
    }

    /// <summary>Resets the controller errors and leaves the HOLD state</summary>
    public void Reset()
    {
        // The controller only accepts a reset while RMI_MOVE runs
        try { lock (_io) _robot.Rmi.Reset(); } catch (RmiException) { }
        log("Reset");
        if (_runState is not ("running" or "paused")) Restart();
    }

    // After an alarm, the controller refuses Initialize in the same RMI session, and accepts it in a new one
    private void Restart()
    {
        try
        {
            Connect(_ip);
        }
        catch (Exception e)
        {
            _notice = $"The RMI session could not be restarted: {e.Message}";
            log(_notice);
        }
    }

    /// <summary>Controller status, position and progress of the sequence: polled by the page</summary>
    public object GetState()
    {
        var run = new
        {
            state = _runState,
            error = _runError,
            steps = _steps.Select(s => new { id = s.Id, status = s.Status, error = s.Error })
        };
        if (!Connected) return new { connected = false, notice = _notice, run };

        RmiControllerStatusResponse status;
        CartesianPositionWithUserFrame cartesian;
        JointsPosition joints;
        string? lastError = null;
        bool hold = _robot.Rmi.IsInHoldState;
        lock (_io)
        {
            status = _robot.Rmi.GetStatus();
            cartesian = _robot.Rmi.ReadCartesianPosition().Position;
            joints = _robot.Rmi.ReadJointAngles().JointAngle;
            // The last alarm of the controller, when something prevents the motion
            if (!status.ServoReady || hold || _runState == "error")
                lastError = string.Join(", ", _robot.Rmi.ReadError().ErrorDataEntries);
        }

        return new
        {
            connected = true,
            controller = new
            {
                servoReady = status.ServoReady,
                tpEnabled = status.TPEnabled,
                rmiRunning = status.RmiMotionStatus,
                @override = status.SpeedOverride,
                hold,
                singleStep = status.SingleStepMode,
                lastError,
                rmiVersion = $"{_robot.Rmi.MajorVersion}.{_robot.Rmi.MinorVersion}"
            },
            position = new
            {
                cartesian = new[] { cartesian.X, cartesian.Y, cartesian.Z, cartesian.W, cartesian.P, cartesian.R },
                joints = new[] { joints.J1, joints.J2, joints.J3, joints.J4, joints.J5, joints.J6 },
                tool = cartesian.Tool,
                frame = cartesian.Frame
            },
            run
        };
    }

    private sealed class StepState(string id)
    {
        public string Id => id;
        public RmiInstructionResponse? Response;
        public string? HostStatus; // for a step that is not queued on the controller: it has no RmiInstructionResponse

        // Pending, then the pipeline of the SDK: LocalQueued, ControllerQueued, Executing, Completed or Error
        public string Status => HostStatus ?? Response?.Status.ToString() ?? "Pending";
        public string? Error => Response?.Status == RmiInstructionStatus.Error ? Response.ErrorText : null;
    }
}
