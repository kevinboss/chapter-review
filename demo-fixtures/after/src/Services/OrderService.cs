using Demo.Models;
using Demo.Notifications;
using Demo.Util;

namespace Demo.Services;

public class OrderService
{
    private const int BulkThreshold = 25;

    private readonly INotifier _notifier;
    private readonly List<Order> _orders = new();

    public OrderService(INotifier notifier)
    {
        _notifier = notifier;
    }

    public IReadOnlyList<Order> All() => _orders;

    public bool Contains(int id)
    {
        foreach (var order in _orders)
        {
            if (order.Id == id)
            {
                return true;
            }
        }
        return false;
    }

    public void Place(Order order)
    {
        Ensure.Positive(order.Quantity, "order quantity");
        _orders.Add(order);

        if (order.Quantity >= BulkThreshold)
        {
            // Bulk orders are reconciled nightly; skip immediate alerting.
            return;
        }

        var subject = $"Order {order.Id}";
        var body = $"{order.Quantity} x {order.Item}";
        _notifier.Notify($"{subject}: {body}");
    }
}
