using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using FanucRmiDemo;
using Microsoft.AspNetCore.StaticFiles;
using Spectre.Console;
using UnderAutomation.Fanuc;

const string Url = "http://localhost:16080";
const string WebSite = "https://fanuc-rmi-demo.underautomation.com";

// ---------------------------------------------------------------- settings, saved next to the executable
string configPath = Path.Combine(Path.GetDirectoryName(Environment.ProcessPath)!, "fanuc-rmi-demo.json");
var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };
var config = File.Exists(configPath) ? JsonSerializer.Deserialize<Config>(File.ReadAllText(configPath), jsonOptions)! : new Config();
void SaveConfig() => File.WriteAllText(configPath, JsonSerializer.Serialize(config, jsonOptions));

// Without a key, the SDK runs in its 30 day trial period
void RegisterLicense()
{
    if (!string.IsNullOrWhiteSpace(config.LicenseKey))
        try { FanucRobot.RegisterLicense(config.Licensee, config.LicenseKey); } catch { }
}
RegisterLicense();

// ---------------------------------------------------------------- console
void Log(string tag, string color, string message) =>
    AnsiConsole.MarkupLine($"[grey]{DateTime.Now:HH:mm:ss}[/] [{color}]{tag,-5}[/] {Markup.Escape(message)}");

string sdkVersion = typeof(FanucRobot).Assembly.GetName().Version!.ToString(3);
var license = FanucRobot.LicenseInfo;

AnsiConsole.Write(new FigletText("Fanuc RMI Demo").Color(Color.Orange1));
var banner = new Grid().AddColumn().AddColumn();
banner.AddRow("[grey]SDK[/]", $"UnderAutomation.Fanuc [bold]{sdkVersion}[/] for .NET");
banner.AddRow("[grey]License[/]", license.IsLicensed
    ? $"[green]{license.State}[/]" + (license.EvaluationDaysLeft is { } days ? $", {days} days left" : $", {Markup.Escape(license.Licensee ?? "")}")
    : $"[red]{license.State}[/], get a license on https://underautomation.com/fanuc");
banner.AddRow("[grey]Robot[/]", string.IsNullOrEmpty(config.Ip) ? "[grey]not set yet[/]" : config.Ip);
banner.AddRow("[grey]Settings[/]", Markup.Escape(configPath));
banner.AddRow("[grey]Web page[/]", $"[link]{Url}[/] or [link]{WebSite}[/]");
AnsiConsole.Write(new Panel(banner).Header("[bold] Remote Motion Interface, driven from C# [/]").BorderColor(Color.Grey));

// ---------------------------------------------------------------- web server
var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.UseUrls(Url);
var app = builder.Build();

var session = new RmiSession(message => Log("RMI", "orange1", message));
app.Lifetime.ApplicationStopping.Register(session.Disconnect);

app.Use(async (context, next) =>
{
    // The hosted web page calls this local API: only that page and local pages are allowed to
    string origin = context.Request.Headers.Origin.ToString();
    if (origin != "")
    {
        if (origin != WebSite && !origin.StartsWith("http://localhost:") && !origin.StartsWith("http://127.0.0.1:"))
        {
            context.Response.StatusCode = 403;
            return;
        }
        context.Response.Headers.AccessControlAllowOrigin = origin;
        context.Response.Headers.Vary = "Origin";
        context.Response.Headers.AccessControlAllowMethods = "GET, POST, PUT";
        context.Response.Headers.AccessControlAllowHeaders = "Content-Type";
        context.Response.Headers["Access-Control-Allow-Private-Network"] = "true"; // public page to localhost, asked by Chrome
    }
    if (context.Request.Method == "OPTIONS")
    {
        context.Response.StatusCode = 204;
        return;
    }

    try
    {
        await next(context);
    }
    catch (Exception e)
    {
        Log("ERROR", "red", e.Message);
        context.Response.StatusCode = 400;
        await context.Response.WriteAsJsonAsync(new { error = e.Message, code = (e as DemoException)?.Code ?? "error" });
    }
});

object Info() => new
{
    backend = "dotnet",
    sdkVersion,
    license = new { state = FanucRobot.LicenseInfo.State.ToString(), daysLeft = FanucRobot.LicenseInfo.EvaluationDaysLeft, licensed = FanucRobot.LicenseInfo.IsLicensed },
    config = new { ip = config.Ip, licensee = config.Licensee }
};
object Ok() => new { ok = true };

app.MapGet("/api/info", Info);
app.MapPut("/api/config", (Config update) =>
{
    config.Ip = update.Ip ?? config.Ip;
    config.Licensee = update.Licensee ?? config.Licensee;
    config.LicenseKey = update.LicenseKey ?? config.LicenseKey;
    SaveConfig();
    RegisterLicense();
    Log("API", "blue", "Settings saved");
    return Info();
});
app.MapPost("/api/connect", (Config body) =>
{
    session.Connect(body.Ip ?? throw new ArgumentException("ip is missing"));
    config.Ip = body.Ip;
    SaveConfig();
    return session.GetState();
});
app.MapPost("/api/disconnect", () => { session.Disconnect(); return Ok(); });
app.MapGet("/api/state", session.GetState);
app.MapPost("/api/run", (RunRequest body) => { session.Run(body.Steps, body.Override); return Ok(); });
app.MapPost("/api/pause", () => { session.Pause(); return Ok(); });
app.MapPost("/api/continue", () => { session.Continue(); return Ok(); });
app.MapPost("/api/abort", () => { session.Abort(); return Ok(); });
app.MapPost("/api/reset", () => { session.Reset(); return Ok(); });

// The web page, embedded in the executable
var assembly = Assembly.GetExecutingAssembly();
var pages = assembly.GetManifestResourceNames().Where(n => n.StartsWith("Client/")).ToDictionary(n => n["Client".Length..].Replace('\\', '/'));
var contentTypes = new FileExtensionContentTypeProvider();
app.MapFallback("{*path}", async context => // the default pattern skips the paths that look like files
{
    string path = context.Request.Path == "/" ? "/index.html" : context.Request.Path.Value!;
    if (!pages.TryGetValue(path, out var resource))
    {
        context.Response.StatusCode = 404;
        return;
    }
    context.Response.ContentType = contentTypes.TryGetContentType(path, out var type) ? type : "application/octet-stream";
    await assembly.GetManifestResourceStream(resource)!.CopyToAsync(context.Response.Body);
});

try
{
    await app.StartAsync();
}
catch (IOException)
{
    AnsiConsole.MarkupLine($"[red]Port 16080 is already used: is another backend of this demo running?[/]");
    return 1;
}
Log("READY", "green", $"REST API and web page on {Url}, Ctrl+C to quit");

if (!Console.IsInputRedirected && AnsiConsole.Confirm("Open the web page in your browser?"))
    Process.Start(new ProcessStartInfo(Url) { UseShellExecute = true });

await app.WaitForShutdownAsync();
return 0;

record Config
{
    public string? Ip { get; set; }
    public string? Licensee { get; set; }
    public string? LicenseKey { get; set; }
}

record RunRequest(Step[] Steps, int Override = 10);
