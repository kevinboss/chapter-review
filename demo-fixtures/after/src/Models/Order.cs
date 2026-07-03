namespace Demo.Models;

public class Order
{
    public int Id { get; init; }
    public string Item { get; init; } = "";
    public int Quantity { get; init; }

    public decimal Total(decimal unitPrice) => Quantity * unitPrice;
}
