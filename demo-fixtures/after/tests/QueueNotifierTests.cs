using Demo.Notifications;
using Xunit;

namespace Demo.Tests;

public class QueueNotifierTests
{
    [Fact]
    public void Notify_EnqueuesMessage()
    {
        var notifier = new QueueNotifier();
        notifier.Notify("hello");
        Assert.Equal(1, notifier.Pending);
    }
}
