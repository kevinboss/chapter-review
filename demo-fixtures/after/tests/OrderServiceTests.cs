using Demo.Models;
using Demo.Notifications;
using Demo.Services;
using Xunit;

namespace Demo.Tests;

public class OrderServiceTests
{
    [Fact]
    public void Place_AddsOrder()
    {
        var service = new OrderService(new QueueNotifier());
        service.Place(new Order { Id = 1, Item = "Widget", Quantity = 2 });
        Assert.Single(service.All());
    }

    [Fact]
    public void Place_RejectsNonPositiveQuantity()
    {
        var service = new OrderService(new QueueNotifier());
        Assert.Throws<ArgumentException>(
            () => service.Place(new Order { Id = 3, Item = "Widget", Quantity = 0 }));
    }
}
