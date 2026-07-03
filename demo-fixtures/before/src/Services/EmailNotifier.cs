namespace Demo.Services;

public class EmailNotifier
{
    public void Send(string recipient, string subject, string body)
    {
        // Pretend SMTP happens here.
        Console.WriteLine($"EMAIL to {recipient}: {subject} / {body}");
    }
}
