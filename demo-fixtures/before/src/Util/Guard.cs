namespace Demo.Util;

public static class Guard
{
    public static void Positive(int value, string what)
    {
        if (value <= 0)
        {
            throw new ArgumentException($"{what} must be positive");
        }
    }
}
