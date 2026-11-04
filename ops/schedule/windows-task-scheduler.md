# Windows Task Scheduler

Put the settings in a file only the service account can read, e.g. `C:\medos\backup.env.ps1`:

    $env:DATABASE_URL = "postgresql://medos@db-host:5432/medos"      # OWNER login
    $env:BACKUP_ENCRYPTION_KEY = "..."                               # from `db-backup keygen`
    $env:BACKUP_DIR = "D:\backups"
    $env:PG_BIN = "C:\Program Files\PostgreSQL\17\bin"
    $env:BACKUP_UPLOAD_COMMAND = "aws s3 cp {file} s3://bucket/medos/"
    $env:BACKUP_ALERT_COMMAND = "powershell -File C:\medos\alert.ps1"  # reads $env:BACKUP_ALERT_MESSAGE

Create the three tasks (run as the service account; adjust paths):

    $act = { param($job) New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -Command `". C:\medos\backup.env.ps1; cd C:\medos\apps\api; node dist\cli\db-backup.js $job`"" }
    Register-ScheduledTask -TaskName "MedOS backup" -Action (& $act backup) -Trigger (New-ScheduledTaskTrigger -Daily -At 2:00am)
    Register-ScheduledTask -TaskName "MedOS restore drill" -Action (& $act drill) -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3:30am)
    Register-ScheduledTask -TaskName "MedOS backup health" -Action (& $act status) -Trigger (New-ScheduledTaskTrigger -Once -At 00:00 -RepetitionInterval (New-TimeSpan -Minutes 30))

Enable "Run whether user is logged on or not". These commands were written but not run on this machine.
