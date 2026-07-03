using Demo.Models;
using Demo.Notifications;
using Demo.Services;

var service = new OrderService(new QueueNotifier());
service.Place(new Order { Id = 1, Item = "Widget", Quantity = 3 });
service.Place(new Order { Id = 2, Item = "Gadget", Quantity = 30 });

foreach (var order in service.All())
{
    Console.WriteLine($"{order.Id}: {order.Quantity} x {order.Item}");
}

var total = 0;
foreach (var order in service.All())
{
    total += order.Quantity;
}
Console.WriteLine($"Total units: {total}");
