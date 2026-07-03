namespace Demo.Notifications;

public class QueueNotifier : INotifier
{
    private readonly Queue<string> _queue = new();

    public void Notify(string message)
    {
        _queue.Enqueue(message);
        Console.WriteLine($"queued: {message}");
    }

    public int Pending => _queue.Count;
}
