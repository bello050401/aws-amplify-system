namespace PhotoStation.Infrastructure;

public sealed class SingleInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;
    public SingleInstanceGuard(string environment)
    {
        _mutex = new Mutex(initiallyOwned: true, $"Local\\BELLO.PhotoStation.{environment}", out var created);
        if (!created) throw new InvalidOperationException("BELLO Photo Station is already running for this environment");
    }
    public void Dispose() => _mutex.Dispose();
}
