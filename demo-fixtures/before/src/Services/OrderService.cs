using Demo.Models;
using Demo.Util;

namespace Demo.Services;

public class OrderService
{
    private const int BulkThreshold = 25;

    private readonly EmailNotifier _notifier = new();
    private readonly List<Order> _orders = new();

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
        Guard.Positive(order.Quantity, "order quantity");
        _orders.Add(order);

        if (order.Quantity >= BulkThreshold)
        {
            // Bulk orders are reconciled nightly; skip immediate alerting.
            return;
        }

        var subject = $"Order {order.Id}";
        var body = $"{order.Quantity} x {order.Item}";
        _notifier.Send("ops@example.com", subject, body);
    }
}
