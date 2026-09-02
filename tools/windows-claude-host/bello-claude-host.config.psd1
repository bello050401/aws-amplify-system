<#
    BELLO Claude Code Remote Control host - configuration
    ----------------------------------------------------
    This file contains ONLY non-secret operational settings.
    NEVER put credentials here: no Anthropic / Claude login tokens,
    no AWS credentials, no GitHub tokens, no API keys.
    Claude Code manages its own login; AWS/GitHub use their own
    credential stores. This file is committed to git.
#>
@{
    # Absolute path to the BELLO repository that Claude Code should run in.
    # Remote Control session state is keyed off this directory, so keep it stable.
    RepoPath = 'C:\Users\win\Documents\GitHub\aws-amplify-system'

    # Session title shown in the session list at claude.ai/code.
    # Passed to `claude remote-control --name`.
    SessionName = 'BELLO-dev'

    # Where supervisor + Claude Code debug logs are written.
    # Defaults to %LOCALAPPDATA%\BELLO\claude-host when left empty.
    LogRoot = ''

    # --- Crash-loop protection -------------------------------------------
    # Restart at most MaxRestarts times inside CrashWindowMinutes.
    # Exceeding that stops the supervisor for good (no infinite restart loop).
    MaxRestarts        = 5
    CrashWindowMinutes = 10

    # A child process that stayed up at least this long is considered a
    # healthy run; the failure counter resets when it later exits.
    HealthySeconds = 120

    # Backoff between restarts: 5s, 10s, 20s, 40s ... capped at MaxBackoffSeconds.
    BaseBackoffSeconds = 5
    MaxBackoffSeconds  = 300

    # --- Sleep behaviour --------------------------------------------------
    # While the supervisor runs and the machine is on AC power, ask Windows
    # not to enter system sleep. The display is deliberately NOT kept awake,
    # so the screen still turns off and the lock screen still engages.
    # This is released automatically when the supervisor exits.
    InhibitSleepOnAC = $true

    # --- Log retention ----------------------------------------------------
    LogRetentionDays = 30
}
